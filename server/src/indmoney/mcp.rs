use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::RwLock;

/// Minimal MCP client over the Streamable HTTP transport.
///
/// We only need `initialize` + `tools/call`, and the bearer token must be swapped
/// dynamically (OAuth refresh), so this speaks JSON-RPC directly instead of pulling
/// in a full SDK whose transport pins the auth header at construction time.
/// Protocol notes verified against the spec: POST with
/// `Accept: application/json, text/event-stream`; responses may be either JSON or an
/// SSE stream; the `Mcp-Session-Id` header (when issued) must be echoed afterwards.
#[derive(Debug, Error)]
pub enum McpError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unauthorized")]
    Unauthorized,
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("rpc error {code}: {message}")]
    Rpc { code: i64, message: String },
}

const PROTOCOL_FALLBACKS: [&str; 2] = ["2025-06-18", "2026-07-28"];

pub struct McpClient {
    http: reqwest::Client,
    url: String,
    session: RwLock<Option<String>>,
    protocol: RwLock<Option<String>>,
    next_id: AtomicI64,
}

impl McpClient {
    pub fn new(http: reqwest::Client, url: impl Into<String>) -> Self {
        Self {
            http,
            url: url.into(),
            session: RwLock::new(None),
            protocol: RwLock::new(None),
            next_id: AtomicI64::new(1),
        }
    }

    pub async fn negotiated_protocol(&self) -> Option<String> {
        self.protocol.read().await.clone()
    }

    /// Calls a tool; retries once with a fresh session when the server reports an expired one.
    pub async fn call_tool(&self, token: &str, name: &str, arguments: Value) -> Result<Value, McpError> {
        match self.try_call_tool(token, name, &arguments).await {
            Err(McpError::Protocol(message)) if message.contains("HTTP 400") || message.contains("HTTP 404") => {
                *self.session.write().await = None;
                self.try_call_tool(token, name, &arguments).await
            }
            other => other,
        }
    }

    async fn try_call_tool(&self, token: &str, name: &str, arguments: &Value) -> Result<Value, McpError> {
        self.ensure_initialized(token).await?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        self.post_json(token, &body, true).await
    }

    async fn ensure_initialized(&self, token: &str) -> Result<(), McpError> {
        if self.session.read().await.is_some() {
            return Ok(());
        }
        let mut last_error = None;
        for version in PROTOCOL_FALLBACKS {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            let body = json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "initialize",
                "params": {
                    "protocolVersion": version,
                    "capabilities": {},
                    "clientInfo": { "name": "amaterasu", "version": env!("CARGO_PKG_VERSION") },
                },
            });
            match self.post_json(token, &body, false).await {
                Ok(result) => {
                    let negotiated = result
                        .get("protocolVersion")
                        .and_then(|v| v.as_str())
                        .unwrap_or(version)
                        .to_string();
                    tracing::debug!(protocol = %negotiated, "mcp initialized");
                    *self.protocol.write().await = Some(negotiated);
                    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
                    // The notification has no response; a failure here is non-fatal.
                    if let Err(error) = self.post_raw(token, &note, true).await {
                        tracing::debug!(%error, "initialized notification failed");
                    }
                    return Ok(());
                }
                Err(error @ McpError::Rpc { .. }) => last_error = Some(error),
                Err(other) => return Err(other),
            }
        }
        Err(last_error.unwrap_or_else(|| McpError::Protocol("initialize failed".into())))
    }

    async fn post_json(&self, token: &str, body: &Value, with_session: bool) -> Result<Value, McpError> {
        let raw = self.post_raw(token, body, with_session).await?;
        let id = body.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let message = extract_response(&raw, id)?;
        if let Some(error) = message.get("error") {
            return Err(McpError::Rpc {
                code: error.get("code").and_then(|v| v.as_i64()).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error")
                    .to_string(),
            });
        }
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn post_raw(&self, token: &str, body: &Value, with_session: bool) -> Result<String, McpError> {
        let mut request = self
            .http
            .post(&self.url)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .bearer_auth(token)
            .json(body);
        if with_session {
            if let Some(session) = self.session.read().await.clone() {
                request = request.header("Mcp-Session-Id", session);
            }
        }
        let response = request.send().await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(McpError::Unauthorized);
        }
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            *self.session.write().await = Some(session.to_string());
        }
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() && status != reqwest::StatusCode::ACCEPTED {
            let snippet: String = text.chars().take(300).collect();
            return Err(McpError::Protocol(format!("HTTP {status}: {snippet}")));
        }
        Ok(text)
    }
}

/// Extracts the JSON-RPC response for `id` from either a plain JSON body or an SSE stream.
pub fn extract_response(raw: &str, id: i64) -> Result<Value, McpError> {
    let trimmed = raw.trim_start();
    if trimmed.starts_with('{') {
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) if value.get("id").and_then(|v| v.as_i64()) == Some(id) => return Ok(value),
            Ok(_) => {}
            Err(error) => {
                return Err(McpError::Protocol(format!("invalid json response: {error}")));
            }
        }
    }
    for line in raw.lines() {
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
                return Ok(value);
            }
        }
    }
    let snippet: String = raw.chars().take(200).collect();
    Err(McpError::Protocol(format!(
        "no JSON-RPC response for id {id} (raw: {snippet})"
    )))
}

/// Pulls the JSON payload out of an MCP tool result's text content.
pub fn tool_result_text(result: &Value) -> Result<&str, McpError> {
    result
        .get("content")
        .and_then(|v| v.as_array())
        .and_then(|items| items.iter().find_map(|item| item.get("text").and_then(|t| t.as_str())))
        .ok_or_else(|| McpError::Protocol("tool result has no text content".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plain_json_response() {
        let raw = r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
        let value = extract_response(raw, 7).unwrap();
        assert_eq!(value["result"]["ok"], true);
    }

    #[test]
    fn extracts_sse_response_and_skips_other_ids() {
        let raw = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":1}}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"n\":2}}\n\n";
        let value = extract_response(raw, 2).unwrap();
        assert_eq!(value["result"]["n"], 2);
    }

    #[test]
    fn reports_missing_ids() {
        let raw = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let error = extract_response(raw, 99).unwrap_err();
        assert!(matches!(error, McpError::Protocol(_)));
    }

    #[test]
    fn reads_tool_result_text() {
        let result = serde_json::json!({
            "content": [{ "type": "text", "text": "{\"a\":1}" }],
            "isError": false,
        });
        assert_eq!(tool_result_text(&result).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn surfaces_rpc_errors() {
        let body = serde_json::json!({ "id": 3 });
        let raw = r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad params"}}"#;
        let message = extract_response(raw, 3).unwrap();
        assert_eq!(message["error"]["code"], -32602);
        let _ = body;
    }
}
