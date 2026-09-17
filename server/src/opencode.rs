use futures_util::StreamExt;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::mpsc;

use crate::config::Config;

/// Thin HTTP client for the OpenCode server (Basic auth `opencode:<password>`).
/// Only the routes the bridge needs: sessions, prompts, messages, plugin RPC, events.
#[derive(Clone)]
pub struct OpenCodeClient {
    http: reqwest::Client,
    base: String,
    password: String,
}

#[derive(Debug, Error)]
pub enum OpenCodeError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("opencode returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("unexpected response shape: {0}")]
    Shape(String),
}

pub type Result<T> = std::result::Result<T, OpenCodeError>;

impl OpenCodeClient {
    /// `None` when no password is configured — the bridge degrades to chart-only mode.
    pub fn from_config(config: &Config) -> Option<Self> {
        let password = config.opencode_password.clone()?;
        Some(Self {
            http: reqwest::Client::new(),
            base: config.opencode_base_url.trim_end_matches('/').to_string(),
            password,
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base))
            .basic_auth("opencode", Some(&self.password))
    }

    async fn ok_json(&self, response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(OpenCodeError::Status {
                status: status.as_u16(),
                body: body.chars().take(400).collect(),
            });
        }
        if body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&body).map_err(|error| OpenCodeError::Shape(error.to_string()))
    }

    pub async fn create_session(&self, agent: &str, model: Option<&str>, directory: &str) -> Result<String> {
        let mut body = json!({ "agent": agent, "location": { "directory": directory } });
        if let Some(model) = model {
            if let Some((provider_id, id)) = model.split_once('/') {
                body["model"] = json!({ "providerID": provider_id, "id": id });
            }
        }
        let value = self
            .ok_json(self.request(reqwest::Method::POST, "/api/session").json(&body).send().await?)
            .await?;
        value
            .get("id")
            .or_else(|| value.get("data").and_then(|d| d.get("id")))
            .and_then(|id| id.as_str())
            .map(str::to_string)
            .ok_or_else(|| OpenCodeError::Shape(format!("no session id in {value}")))
    }

    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<()> {
        let body = json!({ "text": text });
        self.ok_json(
            self.request(reqwest::Method::POST, &format!("/api/session/{session_id}/prompt"))
                .json(&body)
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        self.ok_json(
            self.request(reqwest::Method::POST, &format!("/api/session/{session_id}/interrupt"))
                .json(&json!({}))
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }

    /// Raw message list for a session (the frontend renders from this).
    pub async fn messages(&self, session_id: &str) -> Result<Vec<Value>> {
        let value = self
            .ok_json(
                self.request(reqwest::Method::GET, &format!("/api/session/{session_id}/context"))
                    .send()
                    .await?,
            )
            .await?;
        Ok(value
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default())
    }

    /// Calls one of the chart-bridge plugin's RPC methods.
    pub async fn rpc(&self, rpc_id: &str, method: &str, input: Value) -> Result<Value> {
        let value = self
            .ok_json(
                self.request(reqwest::Method::POST, &format!("/api/rpc/{rpc_id}/{method}"))
                    .json(&json!({ "input": input }))
                    .send()
                    .await?,
            )
            .await?;
        Ok(value.get("output").cloned().unwrap_or(Value::Null))
    }

    /// Long-lived event subscription; each yielded value is a decoded event object.
    pub async fn subscribe(&self) -> Result<mpsc::Receiver<Result<Value>>> {
        let response = self
            .request(reqwest::Method::GET, "/api/event")
            .header("accept", "text/event-stream")
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(OpenCodeError::Status {
                status: status.as_u16(),
                body: body.chars().take(300).collect(),
            });
        }
        let (tx, rx) = mpsc::channel(256);
        let mut stream = response.bytes_stream();
        tokio::spawn(async move {
            let mut buffer = SseBuffer::default();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        for payload in buffer.push(&bytes) {
                            let event = serde_json::from_str::<Value>(&payload)
                                .map_err(|error| OpenCodeError::Shape(error.to_string()));
                            if tx.send(event).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(OpenCodeError::Http(error))).await;
                        return;
                    }
                }
            }
        });
        Ok(rx)
    }
}

/// Incremental SSE parser: keeps a byte buffer, yields each `data:` payload once complete.
#[derive(Default)]
pub struct SseBuffer {
    buffer: String,
}

impl SseBuffer {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut payloads = Vec::new();
        loop {
            let Some(index) = self.buffer.find('\n') else { break };
            let line = self.buffer[..index].trim_end_matches('\r').to_string();
            self.buffer.drain(..=index);
            if let Some(payload) = line.strip_prefix("data:") {
                let payload = payload.trim();
                if !payload.is_empty() {
                    payloads.push(payload.to_string());
                }
            }
        }
        payloads
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_buffer_reassembles_split_chunks() {
        let mut buffer = SseBuffer::default();
        assert!(buffer.push(b"data: {\"a\":").is_empty());
        let payloads = buffer.push(b"1}\n\ndata: {\"b\":2}\n");
        assert_eq!(payloads, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        assert!(buffer.push(b"data: [DONE]\n").len() == 1);
    }

    #[test]
    fn sse_buffer_ignores_comments_and_blank_lines() {
        let mut buffer = SseBuffer::default();
        let payloads = buffer.push(b": keep-alive\n\nevent: message\ndata: {\"x\":1}\n\n");
        assert_eq!(payloads, vec!["{\"x\":1}".to_string()]);
    }
}
