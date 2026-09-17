use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{RwLock, broadcast};

use crate::{
    config::Config,
    opencode::{OpenCodeClient, OpenCodeError},
};

pub type Result<T> = std::result::Result<T, BridgeError>;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("chat is not configured (OPENCODE_PASSWORD is unset)")]
    NotConfigured,
    #[error(transparent)]
    OpenCode(#[from] OpenCodeError),
}

/// Bridges the browser to the OpenCode agent: one upstream event subscription fanned out
/// to every browser tab, plus chat session helpers and the chart-bridge RPC forwarders.
pub struct Bridge {
    client: Option<OpenCodeClient>,
    events: broadcast::Sender<Value>,
    contexts: RwLock<HashMap<String, Value>>,
    active_chart: RwLock<Option<String>>,
    agent: String,
    model: Option<String>,
    directory: String,
}

impl Bridge {
    pub fn new(config: &Config) -> Arc<Self> {
        let (events, _) = broadcast::channel(512);
        Arc::new(Self {
            client: OpenCodeClient::from_config(config),
            events,
            contexts: RwLock::new(HashMap::new()),
            active_chart: RwLock::new(None),
            agent: config.opencode_agent.clone(),
            model: config.opencode_model.clone(),
            directory: config.opencode_directory.clone(),
        })
    }

    pub fn chat_configured(&self) -> bool {
        self.client.is_some()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    /// One upstream subscription, reconnecting forever; forwards only the interesting events.
    pub fn spawn_event_pump(self: &Arc<Self>) {
        let Some(client) = self.client.clone() else {
            tracing::info!("chat disabled: OPENCODE_PASSWORD is not set");
            return;
        };
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match client.subscribe().await {
                    Ok(mut receiver) => {
                        tracing::info!("opencode event stream connected");
                        while let Some(event) = receiver.recv().await {
                            match event {
                                Ok(value) => bridge.forward(value),
                                Err(error) => {
                                    tracing::warn!(%error, "opencode event stream error");
                                    break;
                                }
                            }
                        }
                        tracing::warn!("opencode event stream ended; reconnecting");
                    }
                    Err(error) => tracing::warn!(%error, "opencode event subscribe failed"),
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
    }

    fn forward(&self, event: Value) {
        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or_default();
        if is_interesting(event_type) {
            let _ = self.events.send(event);
        }
    }

    pub async fn create_session(&self) -> Result<String> {
        let client = self.client.as_ref().ok_or(BridgeError::NotConfigured)?;
        Ok(client
            .create_session(&self.agent, self.model.as_deref(), &self.directory)
            .await?)
    }

    /// Sends a prompt with a chart preamble and returns the turn id used for traceability.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<String> {
        let client = self.client.as_ref().ok_or(BridgeError::NotConfigured)?;
        let turn_id = format!("turn_{}", chrono::Utc::now().timestamp_millis());
        let full = match self.preamble().await {
            Some(preamble) => format!("{preamble}\n\n{text}"),
            None => text.to_string(),
        };
        client.prompt(session_id, &full).await?;
        let _ = self.events.send(json!({
            "type": "chat.turn.started",
            "data": { "sessionID": session_id, "turnId": turn_id },
        }));
        Ok(turn_id)
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        let client = self.client.as_ref().ok_or(BridgeError::NotConfigured)?;
        Ok(client.interrupt(session_id).await?)
    }

    pub async fn messages(&self, session_id: &str) -> Result<Vec<Value>> {
        let client = self.client.as_ref().ok_or(BridgeError::NotConfigured)?;
        Ok(client.messages(session_id).await?)
    }

    async fn preamble(&self) -> Option<String> {
        let active = self.active_chart.read().await.clone()?;
        let contexts = self.contexts.read().await;
        build_preamble(contexts.get(&active)?)
    }

    pub async fn chart_attach(&self, chart_id: &str) -> Result<Value> {
        self.rpc("attach", json!({ "chartId": chart_id })).await
    }

    pub async fn chart_detach(&self, chart_id: &str) -> Result<Value> {
        let value = self.rpc("detach", json!({ "chartId": chart_id })).await?;
        let mut contexts = self.contexts.write().await;
        contexts.remove(chart_id);
        if self.active_chart.read().await.as_deref() == Some(chart_id) {
            *self.active_chart.write().await = contexts.keys().next().cloned();
        }
        Ok(value)
    }

    /// Forwards the browser's chart context to the plugin and caches it for prompt preambles.
    pub async fn chart_sync(&self, payload: Value) -> Result<Value> {
        if let Some(chart_id) = payload.get("chartId").and_then(|v| v.as_str()) {
            self.contexts.write().await.insert(chart_id.to_string(), payload.clone());
            *self.active_chart.write().await = Some(chart_id.to_string());
        }
        self.rpc("syncContext", payload).await
    }

    pub async fn chart_op_ack(&self, request_id: &str, result: Value) -> Result<Value> {
        self.rpc("opAck", json!({ "requestId": request_id, "result": result })).await
    }

    pub async fn chart_state_ack(&self, request_id: &str, result: Value) -> Result<Value> {
        self.rpc("stateAck", json!({ "requestId": request_id, "result": result })).await
    }

    async fn rpc(&self, method: &str, input: Value) -> Result<Value> {
        let client = self.client.as_ref().ok_or(BridgeError::NotConfigured)?;
        Ok(client.rpc("chart", method, input).await?)
    }
}

/// Events the browser cares about: chat streaming, step boundaries, and chart requests.
pub fn is_interesting(event_type: &str) -> bool {
    event_type.starts_with("session.text")
        || event_type.starts_with("session.step")
        || event_type.starts_with("session.execution")
        || event_type == "session.inbox.enqueued"
        || event_type == "session.inbox.delivered"
        || event_type == "chat.turn.started"
        || event_type.starts_with("rpc.chart.")
}

pub fn build_preamble(context: &Value) -> Option<String> {
    let symbol = context.get("symbol").and_then(|v| v.as_str())?;
    let interval = context.get("interval").and_then(|v| v.as_str()).unwrap_or("?");
    let range = match (
        context.get("from").and_then(|v| v.as_i64()),
        context.get("to").and_then(|v| v.as_i64()),
    ) {
        (Some(from), Some(to)) => format!(", visible {from} → {to} (epoch seconds)"),
        _ => String::new(),
    };
    Some(format!("Current chart: {symbol} · {interval}{range}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interesting_events_are_filtered() {
        assert!(is_interesting("session.text.delta"));
        assert!(is_interesting("session.step.ended"));
        assert!(is_interesting("session.execution.succeeded"));
        assert!(is_interesting("rpc.chart.op.request"));
        assert!(is_interesting("chat.turn.started"));
        assert!(!is_interesting("session.usage.updated"));
        assert!(!is_interesting("server.connected"));
        assert!(!is_interesting("session.instructions.updated"));
    }

    #[test]
    fn preamble_includes_symbol_interval_and_range() {
        let context = json!({ "chartId": "c1", "symbol": "Reliance Industries", "interval": "1day", "from": 100, "to": 200 });
        assert_eq!(
            build_preamble(&context).unwrap(),
            "Current chart: Reliance Industries · 1day, visible 100 → 200 (epoch seconds)."
        );
    }

    #[test]
    fn preamble_needs_a_symbol() {
        assert!(build_preamble(&json!({ "chartId": "c1" })).is_none());
    }
}
