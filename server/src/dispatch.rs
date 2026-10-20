use std::{collections::HashMap, sync::Arc};

use serde_json::Value;
use tokio::sync::{Mutex, oneshot};

/// Tracks HTTP callers waiting for a browser ack of a dispatched op.
///
/// The browser remains the adapter: it applies the op, computes the inverse, and posts an ack.
/// A waiter resolves the submit request with the finalized ack, or times out and lets the API
/// record an `internal` rejection.
#[derive(Default)]
pub struct OpDispatch {
    waiters: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl OpDispatch {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn register(&self, op_id: &str) -> oneshot::Receiver<Value> {
        let (sender, receiver) = oneshot::channel();
        self.waiters.lock().await.insert(op_id.to_string(), sender);
        receiver
    }

    pub async fn resolve(&self, op_id: &str, ack: Value) {
        if let Some(sender) = self.waiters.lock().await.remove(op_id) {
            let _ = sender.send(ack);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn resolves_a_registered_waiter_once() {
        let dispatch = OpDispatch::new();
        let receiver = dispatch.register("op_1").await;
        dispatch
            .resolve("op_1", json!({ "status": "applied" }))
            .await;
        let ack = receiver.await.unwrap();
        assert_eq!(ack["status"], "applied");

        // A second resolve is a no-op rather than a panic.
        dispatch
            .resolve("op_1", json!({ "status": "applied" }))
            .await;
        dispatch.resolve("missing", json!({})).await;
    }
}
