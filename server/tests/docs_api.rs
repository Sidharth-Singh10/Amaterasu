use std::{path::PathBuf, sync::Arc, time::Duration};

use amaterasu_server::{
    api::AppState, bridge::Bridge, cache::Cache, config::Config, dispatch::OpDispatch,
    indmoney::IndmoneyClient, journal::JournalStore, workspace::WorkspaceStore,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderValue, Request, StatusCode, header::CONTENT_TYPE},
};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Harness {
    router: Router,
    events: tokio::sync::broadcast::Receiver<Value>,
    journal: Arc<JournalStore>,
    _dir: PathBuf,
}

impl Harness {
    fn token(&self, cap_id: &str) -> String {
        self.journal.capability_token(cap_id).unwrap()
    }
}

async fn harness(label: &str) -> Harness {
    let dir =
        std::env::temp_dir().join(format!("amaterasu-docs-api-{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let config = Config {
        bind: "127.0.0.1:0".into(),
        static_dir: None,
        data_dir: dir.clone(),
        base_url: "http://localhost".into(),
        app_url: "http://localhost".into(),
        indmoney_mcp_url: "http://localhost/mcp".into(),
        indmoney_scope: "market:read".into(),
        opencode_base_url: "http://localhost:4096".into(),
        opencode_password: None,
        opencode_agent: "chart-analyst".into(),
        opencode_model: None,
        opencode_directory: dir.to_string_lossy().into_owned(),
        workspaces_db: dir.join("workspaces.db"),
        journal_db: dir.join("journal.db"),
    };
    let journal = Arc::new(JournalStore::open(&config.journal_db).unwrap());
    let bridge = Bridge::new(&config, journal.clone());
    let events = bridge.subscribe();
    let indmoney = Arc::new(IndmoneyClient::new(&config, reqwest::Client::new()).await);
    let workspaces = Arc::new(WorkspaceStore::open(&config.workspaces_db).unwrap());
    let state = AppState {
        config,
        indmoney,
        cache: Arc::new(Cache::new()),
        bridge,
        journal: journal.clone(),
        dispatch: OpDispatch::new(),
        workspaces,
    };
    Harness {
        router: amaterasu_server::build_router(state),
        events,
        journal,
        _dir: dir,
    }
}

fn envelope(key: &str) -> Value {
    json!({
        "v": 1,
        "doc_id": "doc_api",
        "turn_id": "turn_1",
        "seq": 1,
        "actor": { "kind": "agent", "id": "chart-analyst" },
        "capability": "cap_local",
        "type": "chart.shape.create",
        "target": { "kind": "chart.shape" },
        "payload": {
            "op": {
                "op": "draw",
                "kind": "trendline",
                "points": [{ "t": 1, "p": 10 }, { "t": 2, "p": 20 }]
            }
        },
        "idempotency_key": key,
        "created_at": "2026-10-20T09:41:02Z"
    })
}

fn inverse() -> Value {
    json!([{
        "type": "chart.shape.delete",
        "target": { "kind": "chart.shape", "id": "shape_1" },
        "payload": { "op": { "op": "remove", "id": "shape_1" } }
    }])
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn post(path: &str, body: Value) -> Request<Body> {
    Request::post(path)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn with_token(mut request: Request<Body>, token: &str) -> Request<Body> {
    request.headers_mut().insert(
        "x-cg-capability",
        HeaderValue::from_str(token).expect("valid token"),
    );
    request
}

async fn next_doc_request(events: &mut tokio::sync::broadcast::Receiver<Value>) -> (String, Value) {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("dispatch event")
            .expect("stream open");
        if event["type"] == "doc.op.request" {
            let op_id = event["data"]["opId"].as_str().unwrap().to_string();
            return (op_id, event["data"]["envelope"].clone());
        }
    }
}

async fn ack(router: Router, doc_id: &str, op_id: &str, status: &str) -> Value {
    let response = router
        .oneshot(post(
            &format!("/api/docs/{doc_id}/acks"),
            json!({
                "acks": [{
                    "op_id": op_id,
                    "status": status,
                    "result": { "ok": status == "applied" },
                    "inverse": inverse(),
                    "snapshot": { "v": 1, "annotations": [], "series": [] }
                }]
            }),
        ))
        .await
        .unwrap();
    if response.status() != StatusCode::OK {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        panic!("ack failed {status}: {}", String::from_utf8_lossy(&bytes));
    }
    body_json(response).await
}

#[tokio::test]
async fn submit_waits_for_the_browser_ack_and_records_history() {
    let mut harness = harness("submit").await;
    let token = harness.token("cap_local");
    let request = with_token(
        post(
            "/api/docs/doc_api/ops",
            json!({ "ops": [envelope("key_1")] }),
        ),
        &token,
    );
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(request).await.unwrap() });

    let (op_id, dispatched) = next_doc_request(&mut harness.events).await;
    assert_eq!(dispatched["payload"]["op"]["op"], "draw");

    let ack = ack(harness.router.clone(), "doc_api", &op_id, "applied").await;
    assert_eq!(ack["acks"][0]["status"], "applied");
    assert_eq!(ack["acks"][0]["revision"], 1);

    let response = submitted.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["acks"][0]["op_id"], op_id);
    assert_eq!(body["acks"][0]["revision"], 1);

    let meta = body_json(
        harness
            .router
            .clone()
            .oneshot(
                Request::get("/api/docs/doc_api")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(meta["doc"]["revision"], 1);
    assert_eq!(meta["verification"]["ok"], true);

    let snapshot = body_json(
        harness
            .router
            .clone()
            .oneshot(
                Request::get("/api/docs/doc_api/snapshot")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(snapshot["snapshot"]["revision"], 1);
    assert_eq!(snapshot["snapshot"]["snapshot"]["v"], 1);

    let audit = body_json(
        harness
            .router
            .clone()
            .oneshot(
                Request::get("/api/docs/doc_api/audit")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(audit["entries"].as_array().unwrap().len(), 1);
    assert_eq!(audit["entries"][0]["status"], "applied");

    let ops = body_json(
        harness
            .router
            .clone()
            .oneshot(
                Request::get("/api/docs/doc_api/ops")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(ops["ops"][0]["op_id"], op_id);
    assert_eq!(ops["ops"][0]["undoes"], Value::Null);
    assert_eq!(ops["ops"][0]["undone_by"], Value::Null);
    assert_eq!(
        ops["ops"][0]["ack"]["inverse"][0]["type"],
        "chart.shape.delete"
    );
}

#[tokio::test]
async fn a_retried_batch_replays_the_original_ack_without_redispatching() {
    let mut harness = harness("retry").await;
    let token = harness.token("cap_local");
    let first = with_token(
        post(
            "/api/docs/doc_api/ops",
            json!({ "ops": [envelope("key_1")] }),
        ),
        &token,
    );
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(first).await.unwrap() });
    let (op_id, _) = next_doc_request(&mut harness.events).await;
    ack(harness.router.clone(), "doc_api", &op_id, "applied").await;
    let first_body = body_json(submitted.await.unwrap()).await;
    assert_eq!(first_body["acks"][0]["revision"], 1);

    let retried = harness
        .router
        .clone()
        .oneshot(with_token(
            post(
                "/api/docs/doc_api/ops",
                json!({ "ops": [envelope("key_1")] }),
            ),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(retried.status(), StatusCode::OK);
    let retried = body_json(retried).await;
    assert_eq!(retried["acks"][0]["op_id"], op_id);
    assert_eq!(retried["acks"][0]["revision"], 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), harness.events.recv())
            .await
            .is_err(),
        "a replay must not be dispatched to the browser again"
    );
}

#[tokio::test]
async fn malformed_ops_get_a_typed_rejection() {
    let harness = harness("malformed").await;
    let token = harness.token("cap_local");
    let mut bad = envelope("key_1");
    bad["type"] = json!("shape.create");
    let response = harness
        .router
        .oneshot(with_token(
            post("/api/docs/doc_api/ops", json!({ "ops": [bad] })),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["acks"][0]["status"], "rejected");
    assert_eq!(body["acks"][0]["code"], "invalid_op");
    assert_eq!(body["acks"][0]["revision"], 0);
}

#[tokio::test]
async fn undo_dispatches_the_inverse_as_a_new_turn() {
    let mut harness = harness("undo").await;
    let token = harness.token("cap_local");
    let undo_token = harness.token("cap_undo");
    let request = with_token(
        post(
            "/api/docs/doc_api/ops",
            json!({ "ops": [envelope("key_1")] }),
        ),
        &token,
    );
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    let (op_id, _) = next_doc_request(&mut harness.events).await;
    ack(harness.router.clone(), "doc_api", &op_id, "applied").await;
    submitted.await.unwrap();

    let undo_request = with_token(
        post("/api/docs/doc_api/turns/turn_1/undo", json!({})),
        &undo_token,
    );
    let router = harness.router.clone();
    let undone = tokio::spawn(async move { router.oneshot(undo_request).await.unwrap() });
    let (undo_op_id, dispatched) = next_doc_request(&mut harness.events).await;
    assert_eq!(dispatched["type"], "chart.shape.delete");
    assert_eq!(dispatched["payload"]["op"]["op"], "remove");

    let undo_ack = ack(harness.router.clone(), "doc_api", &undo_op_id, "applied").await;
    assert_eq!(undo_ack["acks"][0]["revision"], 2);

    let response = undone.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["applied"], true);
    assert!(
        body["undoTurnId"]
            .as_str()
            .unwrap()
            .starts_with("turn_undo_")
    );

    let meta = harness.journal.meta("doc_api").unwrap();
    assert_eq!(meta.revision, 2);
    assert_eq!(harness.journal.audit("doc_api").unwrap().len(), 2);

    let ops = harness.journal.list_ops("doc_api", 50).unwrap();
    let original = ops
        .iter()
        .find(|op| op["turn_id"] == "turn_1")
        .expect("original turn");
    assert_eq!(original["undone_by"], body["undoTurnId"]);
    let undo_turn = ops
        .iter()
        .find(|op| op["turn_id"] == body["undoTurnId"])
        .expect("undo turn");
    assert_eq!(undo_turn["undoes"], json!("turn_1"));

    let second = harness
        .router
        .clone()
        .oneshot(with_token(
            post("/api/docs/doc_api/turns/turn_1/undo", json!({})),
            &undo_token,
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second = body_json(second).await;
    assert_eq!(second["applied"], false);
    assert_eq!(second["acks"][0]["code"], "already_undone");
    assert_eq!(harness.journal.audit("doc_api").unwrap().len(), 3);
}

#[tokio::test]
async fn capability_denials_are_typed_acks_and_not_dispatched() {
    let mut harness = harness("capability-denial").await;
    let token = harness.token("cap_local");
    let mut denied = envelope("key_1");
    denied["actor"] = json!({ "kind": "agent", "id": "intruder" });

    let response = harness
        .router
        .clone()
        .oneshot(with_token(
            post("/api/docs/doc_api/ops", json!({ "ops": [denied] })),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["acks"][0]["status"], "rejected");
    assert_eq!(body["acks"][0]["code"], "capability_denied");
    assert_eq!(body["acks"][0]["revision"], 0);

    assert!(
        tokio::time::timeout(Duration::from_millis(200), harness.events.recv())
            .await
            .is_err(),
        "a capability rejection must not reach the browser"
    );
    let audit = harness.journal.audit("doc_api").unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["status"], "rejected");
}

#[tokio::test]
async fn an_approval_replays_the_rejected_op_once() {
    let mut harness = harness("approval").await;
    harness
        .journal
        .mint_capability(json!({
            "v": 1,
            "cap_id": "cap_guarded",
            "iss": "cg-local",
            "sub": { "actor_id": "chart-analyst" },
            "documents": ["*"],
            "op_types": ["chart.shape.*"],
            "permissions": ["read", "apply"],
            "approval": { "mode": "human", "op_types": ["chart.shape.delete"] },
            "issued_at": "2026-01-01T00:00:00Z",
            "expires_at": "2030-01-01T00:00:00Z"
        }))
        .unwrap();

    let guarded_token = harness.token("cap_guarded");
    let human_token = harness.token("cap_human");
    let mut delete = envelope("key_1");
    delete["type"] = json!("chart.shape.delete");
    delete["capability"] = json!("cap_guarded");
    let response = harness
        .router
        .clone()
        .oneshot(with_token(
            post("/api/docs/doc_api/ops", json!({ "ops": [delete] })),
            &guarded_token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let denied = body_json(response).await;
    assert_eq!(denied["acks"][0]["code"], "approval_required");
    let approval_id = denied["acks"][0]["suggestion"]["approval_id"]
        .as_str()
        .expect("approval id")
        .to_string();

    let approve_request = with_token(
        Request::post(format!("/api/docs/doc_api/approvals/{approval_id}"))
            .body(Body::empty())
            .unwrap(),
        &human_token,
    );
    let router = harness.router.clone();
    let approved = tokio::spawn(async move { router.oneshot(approve_request).await.unwrap() });

    let (op_id, dispatched) = next_doc_request(&mut harness.events).await;
    assert_eq!(dispatched["type"], "chart.shape.delete");
    assert_eq!(dispatched["approval"], approval_id);
    assert_eq!(dispatched["approved_by"]["id"], "local");
    ack(harness.router.clone(), "doc_api", &op_id, "applied").await;

    let response = approved.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["applied"], true);
    assert_eq!(body["acks"][0]["revision"], 1);

    assert!(harness.journal.approval(&approval_id).unwrap().used);
    assert_eq!(harness.journal.meta("doc_api").unwrap().revision, 1);
    let audit = harness.journal.audit("doc_api").unwrap();
    assert_eq!(audit.len(), 2);
    let approved_entry = audit
        .iter()
        .find(|entry| entry["status"] == "applied")
        .expect("approved audit entry");
    assert_eq!(approved_entry["approval"], approval_id);
    assert_eq!(approved_entry["approved_by"]["id"], "local");

    let reused = harness
        .router
        .clone()
        .oneshot(with_token(
            Request::post(format!("/api/docs/doc_api/approvals/{approval_id}"))
                .body(Body::empty())
                .unwrap(),
            &human_token,
        ))
        .await
        .unwrap();
    assert_eq!(reused.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let reused = body_json(reused).await;
    assert_eq!(reused["error"], "approval_invalid");
}

#[tokio::test]
async fn the_chart_http_path_applies_and_gates_ops() {
    let mut harness = harness("chart-http").await;
    let token = harness.token("cap_local");
    let request = with_token(
        post(
            "/api/chart/op",
            json!({
                "chartId": "doc_api",
                "requestId": "req_http_1",
                "op": {
                    "op": "draw",
                    "kind": "trendline",
                    "points": [{ "t": 1, "p": 10 }, { "t": 2, "p": 20 }]
                }
            }),
        ),
        &token,
    );
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    let (op_id, dispatched) = next_doc_request(&mut harness.events).await;
    assert_eq!(dispatched["payload"]["op"]["op"], "draw");
    ack(harness.router.clone(), "doc_api", &op_id, "applied").await;

    let response = submitted.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["ack"]["status"], "applied");
    assert_eq!(body["ack"]["revision"], 1);

    let denied = harness
        .router
        .clone()
        .oneshot(with_token(
            post(
                "/api/chart/op",
                json!({
                    "chartId": "doc_api",
                    "requestId": "req_http_2",
                    "op": { "op": "remove", "id": "shape_1" }
                }),
            ),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::OK);
    let denied = body_json(denied).await;
    assert_eq!(denied["ack"]["status"], "rejected");
    assert_eq!(denied["ack"]["code"], "approval_required");
    assert!(denied["ack"]["suggestion"]["approval_id"].is_string());
    assert!(
        tokio::time::timeout(Duration::from_millis(200), harness.events.recv())
            .await
            .is_err(),
        "a gated op must not reach the browser"
    );
    assert_eq!(harness.journal.meta("doc_api").unwrap().revision, 1);
}

#[tokio::test]
async fn writes_require_a_signed_capability_token() {
    let harness = harness("tokens").await;
    let missing = harness
        .router
        .clone()
        .oneshot(post(
            "/api/docs/doc_api/ops",
            json!({ "ops": [envelope("token_missing")] }),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);

    let response = harness
        .router
        .clone()
        .oneshot(
            Request::get("/api/capabilities/cap_local/token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let token = body["token"].as_str().expect("token").to_string();
    assert!(token.starts_with("cg1."));

    let key = body_json(
        harness
            .router
            .clone()
            .oneshot(
                Request::get("/api/capabilities/key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert!(
        key["publicKey"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );

    let tampered = harness
        .router
        .clone()
        .oneshot(with_token(
            post(
                "/api/docs/doc_api/ops",
                json!({ "ops": [envelope("token_tampered")] }),
            ),
            &format!("{token}x"),
        ))
        .await
        .unwrap();
    assert_eq!(tampered.status(), StatusCode::FORBIDDEN);

    let mut bad = envelope("token_valid");
    bad["type"] = json!("shape.create");
    let accepted = harness
        .router
        .clone()
        .oneshot(with_token(
            post("/api/docs/doc_api/ops", json!({ "ops": [bad] })),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let accepted = body_json(accepted).await;
    assert_eq!(accepted["acks"][0]["code"], "invalid_op");
}

#[tokio::test]
async fn ten_shapes_in_one_turn_undo_together() {
    let mut harness = harness("ten-shapes").await;
    let token = harness.token("cap_local");
    let undo_token = harness.token("cap_undo");
    let ops = (1..=10)
        .map(|index| {
            let mut envelope = envelope(&format!("bulk_{index}"));
            envelope["turn_id"] = json!("turn_bulk");
            envelope["seq"] = json!(index);
            envelope
        })
        .collect::<Vec<_>>();

    let request = with_token(post("/api/docs/doc_api/ops", json!({ "ops": ops })), &token);
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    for _ in 0..10 {
        let (op_id, _) = next_doc_request(&mut harness.events).await;
        ack(harness.router.clone(), "doc_api", &op_id, "applied").await;
    }
    let response = submitted.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["acks"].as_array().unwrap().len(), 10);
    assert_eq!(harness.journal.meta("doc_api").unwrap().revision, 10);
    assert_eq!(harness.journal.audit("doc_api").unwrap().len(), 10);

    let undo_request = with_token(
        post("/api/docs/doc_api/turns/turn_bulk/undo", json!({})),
        &undo_token,
    );
    let router = harness.router.clone();
    let undone = tokio::spawn(async move { router.oneshot(undo_request).await.unwrap() });
    for _ in 0..10 {
        let (op_id, _) = next_doc_request(&mut harness.events).await;
        ack(harness.router.clone(), "doc_api", &op_id, "applied").await;
    }
    let response = undone.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["applied"], true);
    assert_eq!(harness.journal.meta("doc_api").unwrap().revision, 20);
    assert_eq!(harness.journal.audit("doc_api").unwrap().len(), 20);
    assert_eq!(
        harness.journal.list_ops("doc_api", 1).unwrap()[0]["undoes"],
        json!("turn_bulk")
    );
}

#[tokio::test]
async fn a_rejected_op_can_self_correct_with_the_suggestion() {
    let mut harness = harness("self-correct").await;
    let token = harness.token("cap_local");
    let request = with_token(
        post(
            "/api/docs/doc_api/ops",
            json!({ "ops": [envelope("correct_1")] }),
        ),
        &token,
    );
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    let (op_id, _) = next_doc_request(&mut harness.events).await;

    let rejected = harness
        .router
        .clone()
        .oneshot(post(
            "/api/docs/doc_api/acks",
            json!({
                "acks": [{
                    "op_id": op_id,
                    "status": "rejected",
                    "rejected_by": "adapter",
                    "code": "anchor_out_of_range",
                    "message": "point is before the loaded window",
                    "retryable": true,
                    "suggestion": { "t": 1730800000 },
                    "inverse": [],
                    "snapshot": { "v": 1, "annotations": [], "series": [] }
                }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::OK);
    let response = submitted.await.unwrap();
    let body = body_json(response).await;
    assert_eq!(body["acks"][0]["status"], "rejected");
    assert_eq!(body["acks"][0]["suggestion"]["t"], 1730800000);

    let retry = with_token(
        post(
            "/api/docs/doc_api/ops",
            json!({ "ops": [envelope("correct_2")] }),
        ),
        &token,
    );
    let router = harness.router.clone();
    let retried = tokio::spawn(async move { router.oneshot(retry).await.unwrap() });
    let (retry_op_id, _) = next_doc_request(&mut harness.events).await;
    ack(harness.router.clone(), "doc_api", &retry_op_id, "applied").await;
    let response = retried.await.unwrap();
    let body = body_json(response).await;
    assert_eq!(body["acks"][0]["status"], "applied");
    assert_eq!(harness.journal.meta("doc_api").unwrap().revision, 1);
}

#[tokio::test]
async fn the_graph_adapter_capability_is_seeded_and_scoped() {
    let mut harness = harness("graph-capability").await;
    let token = harness.token("cap_graph");
    let mut envelope = envelope("graph_1");
    envelope["actor"] = json!({ "kind": "agent", "id": "weave-agent" });
    envelope["capability"] = json!("cap_graph");
    envelope["type"] = json!("graph.node.create");
    envelope["target"] = json!({ "kind": "graph.node" });
    envelope["payload"] = json!({
        "op": { "op": "node.create", "id": "n1", "label": "Common Ground", "kind": "concept" }
    });

    let request = with_token(
        post("/api/docs/doc_api/ops", json!({ "ops": [envelope] })),
        &token,
    );
    let router = harness.router.clone();
    let submitted = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    let (op_id, dispatched) = next_doc_request(&mut harness.events).await;
    assert_eq!(dispatched["type"], "graph.node.create");
    assert_eq!(dispatched["payload"]["op"]["op"], "node.create");
    ack(harness.router.clone(), "doc_api", &op_id, "applied").await;

    let response = submitted.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["acks"][0]["status"], "applied");
    assert_eq!(harness.journal.meta("doc_api").unwrap().revision, 1);
}
