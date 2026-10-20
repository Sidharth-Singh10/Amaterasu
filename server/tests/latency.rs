use std::time::Instant;

use amaterasu_server::journal::{AckInput, BatchItem, JournalStore};
use serde_json::{Value, json};

fn envelope(index: usize) -> Value {
    json!({
        "v": 1,
        "doc_id": "doc_latency",
        "turn_id": format!("turn_{index}"),
        "seq": 0,
        "actor": { "kind": "agent", "id": "chart-analyst" },
        "capability": "cap_local",
        "type": "chart.shape.create",
        "target": { "kind": "chart.shape" },
        "payload": {},
        "idempotency_key": format!("latency_{index}"),
        "created_at": "2026-10-20T09:41:02Z"
    })
}

#[test]
fn journal_p95_ack_is_under_50ms() {
    let dir = std::env::temp_dir().join(format!("amaterasu-latency-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = JournalStore::open(&dir.join("journal.db")).unwrap();

    let mut samples = Vec::with_capacity(200);
    for index in 0..200 {
        let started = Instant::now();
        let op = match store.begin_single("doc_latency", envelope(index)).unwrap() {
            BatchItem::Pending(op) => op,
            other => panic!("expected pending, got {other:?}"),
        };
        store
            .complete(
                "doc_latency",
                &op.op_id,
                AckInput {
                    status: "applied".into(),
                    result: Some(json!({ "ok": true })),
                    inverse: Some(json!([])),
                    snapshot: Some(json!({ "v": 1, "annotations": [], "series": [] })),
                    ..AckInput::default()
                },
            )
            .unwrap();
        samples.push(started.elapsed().as_micros());
    }
    samples.sort_unstable();
    let p95 = samples[(samples.len() * 95) / 100];
    eprintln!("journal p95 ack: {p95} µs over {} ops", samples.len());
    assert!(p95 < 50_000, "p95 was {p95} µs");
}
