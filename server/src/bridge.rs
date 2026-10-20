use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{RwLock, broadcast};

use crate::{
    config::Config,
    journal::{self, AckInput, BatchItem, JournalStore},
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
    journal: Arc<JournalStore>,
    agent: String,
    model: Option<String>,
    directory: String,
}

impl Bridge {
    pub fn new(config: &Config, journal: Arc<JournalStore>) -> Arc<Self> {
        let (events, _) = broadcast::channel(512);
        Arc::new(Self {
            client: OpenCodeClient::from_config(config),
            events,
            contexts: RwLock::new(HashMap::new()),
            active_chart: RwLock::new(None),
            journal,
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

    /// Sends a server-originated event (journal dispatch, undo) to every browser tab.
    pub fn broadcast(&self, event: Value) {
        let _ = self.events.send(event);
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

    fn forward(self: &Arc<Self>, mut event: Value) {
        let event_type = event
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        if !is_interesting(event_type) {
            return;
        }
        let dispatch = if event_type == "rpc.chart.op.request" {
            self.journal_chart_op(&mut event)
        } else {
            true
        };
        if dispatch {
            let _ = self.events.send(event);
        }
    }

    /// Journals an agent chart op before it reaches the browser and annotates the event with its
    /// doc/op/turn ids. Returns false when this is a retry that must not be dispatched twice.
    fn journal_chart_op(self: &Arc<Self>, event: &mut Value) -> bool {
        let Some(envelope) = event
            .get("data")
            .and_then(|data| journal::chart_op_envelope(data, &self.agent))
        else {
            return true;
        };
        let Some(doc_id) = envelope
            .get("doc_id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return true;
        };
        match self.journal.begin_single(&doc_id, envelope) {
            Ok(BatchItem::Pending(op)) if op.fresh => {
                if let Some(data) = event.get_mut("data").and_then(Value::as_object_mut) {
                    data.insert("docId".into(), json!(doc_id));
                    data.insert("opId".into(), json!(op.op_id));
                    data.insert("turnId".into(), json!(op.turn_id));
                    data.insert("seq".into(), json!(op.seq));
                }
                true
            }
            Ok(BatchItem::Pending(_)) => {
                tracing::debug!(
                    doc_id,
                    "chart op is already in flight; skipping duplicate dispatch"
                );
                false
            }
            Ok(BatchItem::Replay(_)) => {
                tracing::debug!(
                    doc_id,
                    "chart op was already applied; skipping duplicate dispatch"
                );
                false
            }
            Ok(BatchItem::Rejected(ack)) => {
                self.reject_chart_op(event, &ack);
                false
            }
            Err(error) => {
                tracing::warn!(%error, doc_id, "chart op journaling failed; dispatching unjournaled");
                true
            }
        }
    }

    /// Delivers an intake rejection directly to the chart plugin, without showing the op to the
    /// browser. The plugin resolves the pending tool call with the typed code and suggestion.
    fn reject_chart_op(self: &Arc<Self>, event: &Value, ack: &Value) {
        let Some(request_id) = event
            .get("data")
            .and_then(|data| data.get("requestId"))
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let result = json!({
            "ok": false,
            "code": ack.get("code").cloned().unwrap_or(Value::Null),
            "message": ack.get("message").cloned().unwrap_or(Value::Null),
            "retryable": ack.get("retryable").cloned().unwrap_or(Value::Null),
            "suggestion": ack.get("suggestion").cloned().unwrap_or(Value::Null),
        });
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = bridge
                .rpc(
                    "opAck",
                    json!({ "requestId": request_id, "result": result }),
                )
                .await
            {
                tracing::warn!(%error, "failed to deliver an op rejection to the chart bridge");
            }
        });
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
            self.contexts
                .write()
                .await
                .insert(chart_id.to_string(), payload.clone());
            *self.active_chart.write().await = Some(chart_id.to_string());
        }
        self.rpc("syncContext", payload).await
    }

    pub async fn chart_op_ack(&self, request_id: &str, mut result: Value) -> Result<Value> {
        match self
            .journal
            .complete_by_request(request_id, ack_from_result(&result))
        {
            Ok(Some(ack)) => {
                if let (Some(object), Some(revision)) =
                    (result.as_object_mut(), ack.get("revision"))
                {
                    object.insert("revision".into(), revision.clone());
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, request_id, "journaling chart ack failed; forwarding anyway");
            }
        }
        self.rpc(
            "opAck",
            json!({ "requestId": request_id, "result": result }),
        )
        .await
    }

    pub async fn chart_state_ack(&self, request_id: &str, result: Value) -> Result<Value> {
        self.rpc(
            "stateAck",
            json!({ "requestId": request_id, "result": result }),
        )
        .await
    }

    async fn rpc(&self, method: &str, input: Value) -> Result<Value> {
        let client = self.client.as_ref().ok_or(BridgeError::NotConfigured)?;
        Ok(client.rpc("chart", method, input).await?)
    }
}

/// Maps the chart adapter's existing `OpResult` onto the journal's typed ack.
fn ack_from_result(result: &Value) -> AckInput {
    let inverse = result.get("inverse").cloned();
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        return AckInput {
            status: "applied".into(),
            result: Some(result.clone()),
            inverse,
            snapshot: result.get("snapshot").cloned(),
            ..AckInput::default()
        };
    }

    let unresolved = result
        .get("unresolved")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let warnings: Vec<String> = result
        .get("warnings")
        .and_then(Value::as_array)
        .map(|warnings| {
            warnings
                .iter()
                .filter_map(|warning| warning.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let code = if unresolved > 0 {
        "anchor_out_of_range"
    } else {
        "invalid_op"
    };
    let message = if warnings.is_empty() {
        result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the chart adapter rejected the op")
            .to_string()
    } else {
        warnings.join("; ")
    };
    AckInput {
        status: "rejected".into(),
        result: Some(result.clone()),
        inverse,
        rejected_by: Some("adapter".into()),
        code: Some(code.into()),
        message: Some(message),
        retryable: Some(false),
        suggestion: result.get("suggestion").cloned(),
        snapshot: result.get("snapshot").cloned(),
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
    let interval = context
        .get("interval")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
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
    fn adapter_results_map_to_typed_acks() {
        let applied = ack_from_result(&json!({
            "ok": true,
            "inverse": [{ "type": "chart.shape.delete" }],
        }));
        assert_eq!(applied.status, "applied");
        assert!(applied.inverse.is_some());

        let rejected = ack_from_result(&json!({
            "ok": false,
            "unresolved": [{ "index": 0 }],
            "warnings": ["point is outside the loaded window"],
            "suggestion": { "t": 1730800000 },
            "inverse": [],
        }));
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.code.as_deref(), Some("anchor_out_of_range"));
        assert_eq!(
            rejected.message.as_deref(),
            Some("point is outside the loaded window")
        );
        assert_eq!(rejected.retryable, Some(false));
        assert_eq!(rejected.suggestion, Some(json!({ "t": 1730800000 })));
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
