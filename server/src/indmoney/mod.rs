pub mod mcp;
pub mod normalize;
pub mod oauth;
pub mod store;

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};

use crate::config::Config;
use store::{AuthStore, StoredAuth};

/// Refresh the access token this many seconds before it actually expires.
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;

#[derive(Debug, Error)]
pub enum IndmoneyError {
    #[error("INDmoney is not connected")]
    NotConnected,
    #[error("INDmoney authorization is no longer valid; reconnect required")]
    Unauthorized,
    #[error(transparent)]
    OAuth(#[from] oauth::OAuthError),
    #[error(transparent)]
    Mcp(#[from] mcp::McpError),
    #[error(transparent)]
    Normalize(#[from] normalize::NormalizeError),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("unexpected state: {0}")]
    State(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
}

struct Pending {
    state: String,
    verifier: String,
}

/// Owns the INDmoney data-path connection: OAuth client registration + tokens,
/// token refresh, and the MCP client used for tool calls.
pub struct IndmoneyClient {
    http: reqwest::Client,
    mcp: mcp::McpClient,
    store: AuthStore,
    auth: RwLock<StoredAuth>,
    metadata: RwLock<Option<oauth::AuthServerMetadata>>,
    pending: Mutex<Option<Pending>>,
    scope: String,
    resource: String,
    redirect_uri: String,
    client_name: String,
}

impl IndmoneyClient {
    pub async fn new(config: &Config, http: reqwest::Client) -> Self {
        let store = AuthStore::new(&config.data_dir);
        let auth = store.load().await;
        let mcp = mcp::McpClient::new(http.clone(), config.indmoney_mcp_url.clone());
        Self {
            http,
            mcp,
            store,
            auth: RwLock::new(auth),
            metadata: RwLock::new(None),
            pending: Mutex::new(None),
            scope: config.indmoney_scope.clone(),
            resource: config.indmoney_mcp_url.clone(),
            redirect_uri: config.redirect_uri(),
            client_name: "Amaterasu (self-hosted)".to_string(),
        }
    }

    pub async fn status(&self) -> ConnectionStatus {
        let auth = self.auth.read().await;
        let tokens = auth.tokens.as_ref();
        ConnectionStatus {
            connected: tokens.is_some(),
            expires_at: tokens.map(|t| t.expires_at),
            scope: tokens.and_then(|t| t.scope.clone()),
        }
    }

    async fn metadata(&self) -> Result<oauth::AuthServerMetadata, IndmoneyError> {
        if let Some(metadata) = self.metadata.read().await.clone() {
            return Ok(metadata);
        }
        let (_, metadata) = oauth::discover(&self.http, &self.resource).await?;
        *self.metadata.write().await = Some(metadata.clone());
        Ok(metadata)
    }

    /// Discovers metadata, registers a client if needed, and returns the authorize URL.
    pub async fn start_connect(&self) -> Result<String, IndmoneyError> {
        let metadata = self.metadata().await?;
        let existing = { self.auth.read().await.client.clone() };
        let client = match existing {
            // A redirect-URI change (dev host vs domain) invalidates the stored registration.
            Some(client) if client.redirect_uri == self.redirect_uri => client,
            _ => {
                let registered = oauth::register_client(
                    &self.http,
                    &metadata,
                    &self.redirect_uri,
                    &self.client_name,
                    &self.scope,
                )
                .await?;
                let mut stored = self.auth.read().await.clone();
                stored.client = Some(registered.clone());
                self.store
                    .save(&stored)
                    .await
                    .map_err(|error| IndmoneyError::Storage(error.to_string()))?;
                *self.auth.write().await = stored;
                registered
            }
        };

        let pkce = oauth::pkce();
        let state = oauth::random_state();
        *self.pending.lock().await = Some(Pending {
            state: state.clone(),
            verifier: pkce.verifier,
        });
        Ok(oauth::authorize_url(
            &metadata,
            &client,
            &self.resource,
            &self.scope,
            &pkce.challenge,
            &state,
        ))
    }

    pub async fn complete_connect(&self, code: &str, state: &str) -> Result<(), IndmoneyError> {
        let pending = self
            .pending
            .lock()
            .await
            .take()
            .ok_or_else(|| IndmoneyError::State("no authorization is in progress".into()))?;
        if pending.state != state {
            return Err(IndmoneyError::State("authorization state mismatch".into()));
        }
        let metadata = self.metadata().await?;
        let client = {
            self.auth
                .read()
                .await
                .client
                .clone()
                .ok_or_else(|| IndmoneyError::State("no registered client".into()))?
        };
        let tokens = oauth::exchange_code(&self.http, &metadata, &client, code, &pending.verifier).await?;
        let mut stored = self.auth.read().await.clone();
        stored.tokens = Some(tokens);
        self.store
            .save(&stored)
            .await
            .map_err(|error| IndmoneyError::Storage(error.to_string()))?;
        *self.auth.write().await = stored;
        Ok(())
    }

    /// A valid access token, refreshed ahead of expiry when a refresh token exists.
    pub async fn access_token(&self) -> Result<String, IndmoneyError> {
        let (tokens, client) = {
            let auth = self.auth.read().await;
            (auth.tokens.clone(), auth.client.clone())
        };
        let Some(tokens) = tokens else {
            return Err(IndmoneyError::NotConnected);
        };
        if tokens.expires_at - TOKEN_REFRESH_MARGIN_SECS > Utc::now().timestamp() {
            return Ok(tokens.access_token);
        }
        let (Some(client), Some(refresh_token)) = (client, tokens.refresh_token.clone()) else {
            return Err(IndmoneyError::Unauthorized);
        };
        self.refresh_tokens(&client, &refresh_token).await
    }

    async fn refresh_tokens(
        &self,
        client: &oauth::RegisteredClient,
        refresh_token: &str,
    ) -> Result<String, IndmoneyError> {
        let metadata = self.metadata().await?;
        let fresh = match oauth::refresh(&self.http, &metadata, client, refresh_token).await {
            Ok(fresh) => fresh,
            Err(error) => {
                tracing::warn!(%error, "token refresh failed");
                return Err(IndmoneyError::Unauthorized);
            }
        };
        let mut stored = self.auth.read().await.clone();
        stored.tokens = Some(fresh.clone());
        if let Err(error) = self.store.save(&stored).await {
            tracing::warn!(%error, "failed to persist refreshed tokens");
        }
        *self.auth.write().await = stored;
        Ok(fresh.access_token)
    }

    /// Calls an MCP tool, refreshing once when the server rejects the token.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, IndmoneyError> {
        let token = self.access_token().await?;
        match self.mcp.call_tool(&token, name, arguments.clone()).await {
            Err(mcp::McpError::Unauthorized) => {
                let (tokens, client) = {
                    let auth = self.auth.read().await;
                    (auth.tokens.clone(), auth.client.clone())
                };
                let refresh_token = tokens
                    .and_then(|t| t.refresh_token)
                    .ok_or(IndmoneyError::Unauthorized)?;
                let client = client.ok_or(IndmoneyError::Unauthorized)?;
                let token = self.refresh_tokens(&client, &refresh_token).await?;
                Ok(self.mcp.call_tool(&token, name, arguments).await?)
            }
            Err(error) => Err(error.into()),
            Ok(result) => Ok(result),
        }
    }

    /// Calls a tool and parses its text content as JSON.
    pub async fn call_tool_json(&self, name: &str, arguments: Value) -> Result<Value, IndmoneyError> {
        let result = self.call_tool(name, arguments).await?;
        let text = mcp::tool_result_text(&result)?;
        serde_json::from_str(text).map_err(|error| {
            IndmoneyError::State(format!("tool `{name}` returned invalid JSON: {error}"))
        })
    }
}
