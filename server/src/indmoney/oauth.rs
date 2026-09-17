use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// OAuth 2.1 client pieces for the INDmoney MCP server: resource/AS metadata discovery
/// (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591), PKCE (RFC 7636) and
/// the authorization-code + refresh-token grants. Endpoints were verified live:
///   resource metadata: /.well-known/oauth-protected-resource/mcp
///   AS metadata:       /.well-known/oauth-authorization-server
///   DCR:               POST /register   (client_secret_post, PKCE S256)

#[derive(Debug, Error)]
pub enum OAuthError {
    #[error("invalid MCP url: {0}")]
    InvalidUrl(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{what} failed ({status}): {body}")]
    Response {
        what: &'static str,
        status: u16,
        body: String,
    },
    #[error("authorization server advertises no registration endpoint")]
    NoRegistration,
    #[error("resource metadata lists no authorization servers")]
    NoAuthServer,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProtectedResource {
    pub resource: String,
    pub authorization_servers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthServerMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds at which the access token stops being valid.
    pub expires_at: i64,
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// RFC 7636 verifier (43+ chars, base64url of 32 random bytes) and its S256 challenge.
pub fn pkce() -> Pkce {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = challenge_for(&verifier);
    Pkce { verifier, challenge }
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// RFC 9728 metadata locations for a resource URL, path-scoped first, then origin root.
pub fn metadata_candidates(mcp_url: &str) -> Result<Vec<String>, OAuthError> {
    let url = reqwest::Url::parse(mcp_url).map_err(|e| OAuthError::InvalidUrl(e.to_string()))?;
    let origin = format!("{}://{}", url.scheme(), url.authority());
    let mut candidates = Vec::new();
    if url.path() != "/" {
        candidates.push(format!("{origin}/.well-known/oauth-protected-resource{}", url.path()));
    }
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
    Ok(candidates)
}

pub async fn discover(
    http: &reqwest::Client,
    mcp_url: &str,
) -> Result<(ProtectedResource, AuthServerMetadata), OAuthError> {
    let candidates = metadata_candidates(mcp_url)?;
    let mut last_error = None;
    for candidate in candidates {
        let response = http.get(&candidate).send().await?;
        let status = response.status();
        if !status.is_success() {
            last_error = Some(OAuthError::Response {
                what: "resource metadata",
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
            continue;
        }
        let resource: ProtectedResource = response.json().await?;
        let server = resource
            .authorization_servers
            .first()
            .ok_or(OAuthError::NoAuthServer)?
            .trim_end_matches('/')
            .to_string();
        let meta_url = format!("{server}/.well-known/oauth-authorization-server");
        let response = http.get(&meta_url).send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(OAuthError::Response {
                what: "authorization server metadata",
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        let metadata: AuthServerMetadata = response.json().await?;
        return Ok((resource, metadata));
    }
    Err(last_error.unwrap_or(OAuthError::NoAuthServer))
}

pub async fn register_client(
    http: &reqwest::Client,
    metadata: &AuthServerMetadata,
    redirect_uri: &str,
    client_name: &str,
    scope: &str,
) -> Result<RegisteredClient, OAuthError> {
    let endpoint = metadata
        .registration_endpoint
        .as_ref()
        .ok_or(OAuthError::NoRegistration)?;
    let body = serde_json::json!({
        "client_name": client_name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
        "scope": scope,
    });
    let response = http.post(endpoint).json(&body).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(OAuthError::Response {
            what: "client registration",
            status: status.as_u16(),
            body: response.text().await.unwrap_or_default(),
        });
    }
    let registered: RegistrationResponse = response.json().await?;
    Ok(RegisteredClient {
        client_id: registered.client_id,
        client_secret: registered.client_secret,
        redirect_uri: redirect_uri.to_string(),
    })
}

pub fn authorize_url(
    metadata: &AuthServerMetadata,
    client: &RegisteredClient,
    resource: &str,
    scope: &str,
    challenge: &str,
    state: &str,
) -> String {
    let params = [
        ("response_type", "code"),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", client.redirect_uri.as_str()),
        ("scope", scope),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("resource", resource),
    ];
    let query = params
        .iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{}?{}", metadata.authorization_endpoint, query)
}

pub async fn exchange_code(
    http: &reqwest::Client,
    metadata: &AuthServerMetadata,
    client: &RegisteredClient,
    code: &str,
    verifier: &str,
) -> Result<TokenSet, OAuthError> {
    token_request(http, metadata, client, authorization_code_form(client, code, verifier)).await
}

/// RFC 6749 §4.1.3: `redirect_uri` is required at token time when it was used at
/// authorize time. INDmoney enforces this — verified live, a token request without it
/// fails 400 `redirect_uri did not match the one used when creating auth code`.
pub fn authorization_code_form(
    client: &RegisteredClient,
    code: &str,
    verifier: &str,
) -> Vec<(String, String)> {
    vec![
        ("grant_type".into(), "authorization_code".into()),
        ("code".into(), code.into()),
        ("code_verifier".into(), verifier.into()),
        ("redirect_uri".into(), client.redirect_uri.clone()),
    ]
}

pub async fn refresh(
    http: &reqwest::Client,
    metadata: &AuthServerMetadata,
    client: &RegisteredClient,
    refresh_token: &str,
) -> Result<TokenSet, OAuthError> {
    token_request(
        http,
        metadata,
        client,
        vec![
            ("grant_type".into(), "refresh_token".into()),
            ("refresh_token".into(), refresh_token.into()),
        ],
    )
    .await
}

async fn token_request(
    http: &reqwest::Client,
    metadata: &AuthServerMetadata,
    client: &RegisteredClient,
    mut form: Vec<(String, String)>,
) -> Result<TokenSet, OAuthError> {
    form.push(("client_id".into(), client.client_id.clone()));
    if let Some(secret) = &client.client_secret {
        form.push(("client_secret".into(), secret.clone()));
    }
    let response = http.post(&metadata.token_endpoint).form(&form).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(OAuthError::Response {
            what: "token request",
            status: status.as_u16(),
            body: response.text().await.unwrap_or_default(),
        });
    }
    let token: TokenResponse = response.json().await?;
    Ok(TokenSet {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Utc::now().timestamp() + token.expires_in.unwrap_or(3600),
        scope: token.scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_appendix_b() {
        // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(challenge_for(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn pkce_generates_valid_shapes() {
        let pkce = pkce();
        assert_eq!(pkce.verifier.len(), 43);
        assert_eq!(pkce.challenge, challenge_for(&pkce.verifier));
        assert!(!pkce.verifier.contains('=') && !pkce.verifier.contains('+') && !pkce.verifier.contains('/'));
    }

    #[test]
    fn metadata_candidates_are_path_scoped_then_root() {
        let candidates = metadata_candidates("https://mcp.indmoney.com/mcp").unwrap();
        assert_eq!(
            candidates,
            vec![
                "https://mcp.indmoney.com/.well-known/oauth-protected-resource/mcp",
                "https://mcp.indmoney.com/.well-known/oauth-protected-resource",
            ]
        );

        let candidates = metadata_candidates("https://example.com").unwrap();
        assert_eq!(
            candidates,
            vec!["https://example.com/.well-known/oauth-protected-resource"]
        );
    }

    #[test]
    fn token_form_carries_redirect_uri_and_verifier() {
        let client = RegisteredClient {
            client_id: "c1".into(),
            client_secret: None,
            redirect_uri: "http://127.0.0.1:8787/api/indmoney/oauth/callback".into(),
        };
        let form = authorization_code_form(&client, "CODE", "VERIFIER");
        let lookup = |key: &str| {
            form.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(lookup("grant_type").unwrap(), "authorization_code");
        assert_eq!(lookup("code").unwrap(), "CODE");
        assert_eq!(lookup("code_verifier").unwrap(), "VERIFIER");
        assert_eq!(lookup("redirect_uri").unwrap(), client.redirect_uri);
    }

    #[test]
    fn authorize_url_encodes_every_parameter() {
        let metadata = AuthServerMetadata {
            issuer: "https://mcp.indmoney.com/".into(),
            authorization_endpoint: "https://mcp.indmoney.com/authorize".into(),
            token_endpoint: "https://mcp.indmoney.com/token".into(),
            registration_endpoint: None,
            scopes_supported: vec![],
            code_challenge_methods_supported: vec!["S256".into()],
        };
        let client = RegisteredClient {
            client_id: "client-1".into(),
            client_secret: None,
            redirect_uri: "http://127.0.0.1:8787/api/indmoney/oauth/callback".into(),
        };
        let url = authorize_url(&metadata, &client, "https://mcp.indmoney.com/mcp", "market:read", "CH", "ST");
        assert!(url.starts_with("https://mcp.indmoney.com/authorize?"));
        assert!(url.contains("client_id=client-1"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("resource=https%3A%2F%2Fmcp.indmoney.com%2Fmcp"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fapi%2Findmoney%2Foauth%2Fcallback"));
    }
}
