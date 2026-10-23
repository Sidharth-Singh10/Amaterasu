use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Redirect, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    bridge::{Bridge, BridgeError},
    cache::Cache,
    capability::CapabilityClaims,
    config::Config,
    dispatch::OpDispatch,
    indmoney::{IndmoneyClient, IndmoneyError, normalize},
    journal::{self, AckInput, BatchItem, JournalError, JournalStore},
    workspace::{WorkspaceError, WorkspaceStore},
};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub indmoney: Arc<IndmoneyClient>,
    pub cache: Arc<Cache>,
    pub bridge: Arc<Bridge>,
    pub journal: Arc<JournalStore>,
    pub dispatch: Arc<OpDispatch>,
    pub workspaces: Arc<WorkspaceStore>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/capabilities", post(capability_mint))
        .route("/api/capabilities/key", get(capability_key))
        .route("/api/capabilities/{cap_id}/token", get(capability_token))
        .route("/api/indmoney/status", get(indmoney_status))
        .route("/api/indmoney/connect", get(indmoney_connect))
        .route("/api/indmoney/oauth/callback", get(indmoney_callback))
        .route("/api/search", get(search))
        .route("/api/candles", get(candles))
        .route("/api/quote", get(quote))
        .route("/api/stream", get(stream))
        .route("/api/chat/session", post(chat_session))
        .route("/api/chat/{sessionID}/prompt", post(chat_prompt))
        .route("/api/chat/{sessionID}/interrupt", post(chat_interrupt))
        .route("/api/chat/{sessionID}/messages", get(chat_messages))
        .route("/api/chart/attach", post(chart_attach))
        .route("/api/chart/detach", post(chart_detach))
        .route("/api/chart/sync", post(chart_sync))
        .route("/api/chart/op", post(chart_submit_op))
        .route("/api/chart/op-ack", post(chart_op_ack))
        .route("/api/chart/state-ack", post(chart_state_ack))
        .route("/api/docs/{doc_id}", get(doc_meta))
        .route("/api/docs/{doc_id}/snapshot", get(doc_snapshot))
        .route("/api/docs/{doc_id}/ops", get(doc_ops).post(doc_submit_ops))
        .route("/api/docs/{doc_id}/records", post(doc_record_ops))
        .route("/api/docs/{doc_id}/acks", post(doc_acks))
        .route("/api/docs/{doc_id}/audit", get(doc_audit))
        .route("/api/docs/{doc_id}/turns/{turn_id}/undo", post(doc_undo))
        .route(
            "/api/docs/{doc_id}/approvals/{approval_id}",
            post(doc_approve),
        )
        .route(
            "/api/workspace/{key}",
            get(workspace_get).put(workspace_put),
        )
}

fn require_local_bind(state: &AppState) -> Result<(), ApiError> {
    if state.config.bind.starts_with("127.0.0.1")
        || state.config.bind.starts_with("localhost")
        || state.config.bind.starts_with("[::1]")
    {
        return Ok(());
    }
    Err(ApiError::Forbidden(
        "capability_denied",
        "local capability minting is disabled on a non-loopback bind".into(),
    ))
}

async fn capability_mint(
    State(state): State<AppState>,
    Json(claims): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_local_bind(&state)?;
    Ok(Json(state.journal.mint_capability_token(claims)?))
}

async fn capability_key(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "publicKey": state.journal.capability_public_key() }))
}

async fn capability_token(
    State(state): State<AppState>,
    Path(cap_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_local_bind(&state)?;
    let token = state.journal.capability_token(&cap_id)?;
    Ok(Json(json!({ "capability": cap_id, "token": token })))
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "amaterasu-server",
        "version": env!("CARGO_PKG_VERSION"),
        "cacheEntries": state.cache.len().await,
    }))
}

async fn indmoney_status(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::to_value(state.indmoney.status().await).unwrap_or(Value::Null))
}

async fn indmoney_connect(State(state): State<AppState>) -> Result<Redirect, ApiError> {
    let url = state.indmoney.start_connect().await?;
    Ok(Redirect::temporary(&url))
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn indmoney_callback(
    State(state): State<AppState>,
    Query(query): Query<CallbackQuery>,
) -> Redirect {
    let app_url = state.config.app_url.trim_end_matches('/');
    if let Some(error) = query.error {
        let description = query.error_description.unwrap_or_default();
        return Redirect::temporary(&format!(
            "{app_url}/?indmoney=error&message={}",
            urlencoding::encode(&format!("{error}: {description}"))
        ));
    }
    let (Some(code), Some(callback_state)) = (query.code, query.state) else {
        return Redirect::temporary(&format!(
            "{app_url}/?indmoney=error&message=missing+code+or+state"
        ));
    };
    match state
        .indmoney
        .complete_connect(&code, &callback_state)
        .await
    {
        Ok(()) => Redirect::temporary(&format!("{app_url}/?indmoney=connected")),
        Err(error) => {
            tracing::warn!(%error, "indmoney connect failed");
            Redirect::temporary(&format!(
                "{app_url}/?indmoney=error&message={}",
                urlencoding::encode(&error.to_string())
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let term = query.q.trim().to_string();
    if term.len() < 2 {
        return Ok(Json(json!({ "results": [] })));
    }
    if term.len() > 64 {
        return Err(ApiError::BadRequest("query too long".into()));
    }
    let cache_key = format!("search:{term}");
    let payload = state
        .cache
        .get_or_fetch(&cache_key, Duration::from_secs(600), || async {
            state
                .indmoney
                .call_tool_json(
                    "lookup_ind_keys",
                    json!({ "names": [term], "filter_type": "IN_STOCKS" }),
                )
                .await
        })
        .await?;
    Ok(Json(
        json!({ "results": normalize::normalize_search(&payload) }),
    ))
}

const INTERVALS: [&str; 9] = [
    "1minute",
    "5minute",
    "15minute",
    "30minute",
    "60minute",
    "240minute",
    "1day",
    "1week",
    "1month",
];
const LOOKBACKS: [&str; 4] = ["1d", "7d", "14d", "1y"];

#[derive(Debug, Deserialize)]
struct CandlesQuery {
    ind_key: String,
    interval: String,
    lookback: String,
}

async fn candles(
    State(state): State<AppState>,
    Query(query): Query<CandlesQuery>,
) -> Result<Json<Value>, ApiError> {
    if !INTERVALS.contains(&query.interval.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "interval must be one of {INTERVALS:?}"
        )));
    }
    if !LOOKBACKS.contains(&query.lookback.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "lookback must be one of {LOOKBACKS:?}"
        )));
    }
    let cache_key = format!(
        "candles:{}:{}:{}",
        query.ind_key, query.interval, query.lookback
    );
    let ind_key = query.ind_key.clone();
    let interval = query.interval.clone();
    let lookback = query.lookback.clone();
    let payload = state
        .cache
        .get_or_fetch(&cache_key, candles_ttl(&interval), || async {
            state
                .indmoney
                .call_tool_json(
                    "get_indian_stocks_ohlc",
                    json!({ "ind_key": ind_key, "interval": interval, "lookback": lookback }),
                )
                .await
        })
        .await?;
    let candles = normalize::normalize_candles(&payload)?;
    Ok(Json(json!({
        "indKey": query.ind_key,
        "interval": query.interval,
        "lookback": query.lookback,
        "count": candles.len(),
        "candles": candles,
        "source": "indmoney",
        "fetchedAt": chrono::Utc::now().timestamp(),
    })))
}

#[derive(Debug, Deserialize)]
struct QuoteQuery {
    ind_key: String,
}

async fn quote(
    State(state): State<AppState>,
    Query(query): Query<QuoteQuery>,
) -> Result<Json<Value>, ApiError> {
    let ind_key = query.ind_key.clone();
    let cache_key = format!("quote:{ind_key}");
    let payload = state
        .cache
        .get_or_fetch(&cache_key, Duration::from_secs(15), || async {
            state
                .indmoney
                .call_tool_json(
                    "get_indian_stocks_details",
                    json!({ "ind_keys": [ind_key] }),
                )
                .await
        })
        .await?;
    let quote = normalize::normalize_quote(&payload, &query.ind_key)
        .ok_or_else(|| ApiError::Upstream(format!("no quote for {}", query.ind_key)))?;
    Ok(Json(quote))
}

/// Unified SSE stream: chat streaming events, step boundaries, and chart-bridge requests.
async fn stream(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.bridge.subscribe();
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        use tokio::sync::broadcast::error::RecvError;
        match receiver.recv().await {
            Ok(value) => Some((Ok(Event::default().data(value.to_string())), receiver)),
            Err(RecvError::Lagged(skipped)) => {
                let notice = json!({ "type": "stream.lagged", "data": { "skipped": skipped } });
                Some((Ok(Event::default().data(notice.to_string())), receiver))
            }
            Err(RecvError::Closed) => None,
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn chat_session(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let session_id = state.bridge.create_session().await?;
    Ok(Json(json!({ "sessionID": session_id })))
}

#[derive(Debug, Deserialize)]
struct PromptBody {
    text: String,
}

async fn chat_prompt(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<Json<Value>, ApiError> {
    if body.text.trim().is_empty() {
        return Err(ApiError::BadRequest("text is required".into()));
    }
    let turn_id = state.bridge.prompt(&session_id, &body.text).await?;
    Ok(Json(json!({ "turnId": turn_id })))
}

async fn chat_interrupt(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.bridge.interrupt(&session_id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn chat_messages(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let messages = state.bridge.messages(&session_id).await?;
    Ok(Json(json!({ "messages": messages })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartIdBody {
    chart_id: String,
}

async fn chart_attach(
    State(state): State<AppState>,
    Json(body): Json<ChartIdBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.bridge.chart_attach(&body.chart_id).await?))
}

async fn chart_detach(
    State(state): State<AppState>,
    Json(body): Json<ChartIdBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.bridge.chart_detach(&body.chart_id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartSyncBody {
    chart_id: String,
    symbol: String,
    interval: String,
    from: Option<f64>,
    to: Option<f64>,
}

async fn chart_sync(
    State(state): State<AppState>,
    Json(body): Json<ChartSyncBody>,
) -> Result<Json<Value>, ApiError> {
    let payload = json!({
        "chartId": body.chart_id,
        "symbol": body.symbol,
        "interval": body.interval,
        "from": body.from,
        "to": body.to,
    });
    Ok(Json(state.bridge.chart_sync(payload).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestAckBody {
    request_id: String,
    result: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartOpBody {
    chart_id: String,
    op: Value,
    request_id: Option<String>,
}

/// Pre-application submit for the chart adapter. The envelope is journaled and capability-checked
/// before the browser sees the op; the request blocks until the adapter acks.
async fn chart_submit_op(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChartOpBody>,
) -> Result<Json<Value>, ApiError> {
    require_token(&state, &headers, "cap_local")?;
    let chart_id = body.chart_id;
    let request_id = body
        .request_id
        .unwrap_or_else(|| format!("req_{}", journal::random_id()));
    let data = json!({
        "requestId": request_id,
        "chartId": &chart_id,
        "op": body.op,
    });
    let envelope = journal::chart_op_envelope(&data, &state.config.opencode_agent)
        .ok_or_else(|| ApiError::BadRequest("chartId, requestId, and op.op are required".into()))?;
    let acks = dispatch_batch(&state, &chart_id, &[envelope]).await?;
    Ok(Json(json!({
        "ack": acks.into_iter().next().unwrap_or(Value::Null),
    })))
}

async fn chart_op_ack(
    State(state): State<AppState>,
    Json(body): Json<RequestAckBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        state
            .bridge
            .chart_op_ack(&body.request_id, body.result)
            .await?,
    ))
}

async fn chart_state_ack(
    State(state): State<AppState>,
    Json(body): Json<RequestAckBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        state
            .bridge
            .chart_state_ack(&body.request_id, body.result)
            .await?,
    ))
}

async fn doc_meta(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let doc = state.journal.meta(&doc_id)?;
    let verification = state.journal.verify(&doc_id)?;
    Ok(Json(json!({ "doc": doc, "verification": verification })))
}

#[derive(Debug, Deserialize)]
struct DocOpsQuery {
    limit: Option<i64>,
}

async fn doc_snapshot(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let snapshot = state.journal.snapshot(&doc_id)?;
    Ok(Json(json!({ "docId": doc_id, "snapshot": snapshot })))
}

async fn doc_ops(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
    Query(query): Query<DocOpsQuery>,
) -> Result<Json<Value>, ApiError> {
    let ops = state.journal.list_ops(&doc_id, query.limit.unwrap_or(50))?;
    Ok(Json(json!({ "docId": doc_id, "ops": ops })))
}

async fn doc_audit(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let entries = state.journal.audit(&doc_id)?;
    let verification = state.journal.verify(&doc_id)?;
    Ok(Json(json!({
        "docId": doc_id,
        "entries": entries,
        "verification": verification,
    })))
}

#[derive(Debug, Deserialize)]
struct SubmitOpsBody {
    ops: Vec<Value>,
}

async fn doc_submit_ops(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<SubmitOpsBody>,
) -> Result<Json<Value>, ApiError> {
    if body.ops.is_empty() {
        return Err(ApiError::BadRequest("ops must not be empty".into()));
    }
    require_batch_token(&state, &headers, &body.ops)?;
    let acks = match dispatch_batch(&state, &doc_id, &body.ops).await {
        Ok(acks) => acks,
        Err(ApiError::Protocol("invalid_op", message)) => {
            // A malformed envelope has no journal row, but the caller still gets a typed ack.
            let revision = state
                .journal
                .meta(&doc_id)
                .map(|meta| meta.revision)
                .unwrap_or(0);
            let turn_id = body
                .ops
                .first()
                .and_then(|envelope| envelope.get("turn_id"))
                .and_then(Value::as_str)
                .unwrap_or("turn_invalid");
            let seq = body
                .ops
                .first()
                .and_then(|envelope| envelope.get("seq"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            vec![json!({
                "v": 1,
                "op_id": format!("op_invalid_{}", journal::random_id()),
                "turn_id": turn_id,
                "seq": seq,
                "status": "rejected",
                "revision": revision,
                "rejected_by": "server",
                "code": "invalid_op",
                "message": message,
                "retryable": false,
            })]
        }
        Err(error) => return Err(error),
    };
    Ok(Json(json!({ "docId": doc_id, "acks": acks })))
}

#[derive(Debug, Deserialize)]
struct RecordItem {
    envelope: Value,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    inverse: Option<Value>,
    #[serde(default)]
    snapshot: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RecordBody {
    records: Vec<RecordItem>,
}

/// Records edits the browser adapter has already applied. There is no dispatch wait; the
/// server assigns ids/revisions and writes the audit entry in one transaction.
async fn doc_record_ops(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RecordBody>,
) -> Result<Json<Value>, ApiError> {
    if body.records.is_empty() {
        return Err(ApiError::BadRequest("records must not be empty".into()));
    }
    let envelopes = body
        .records
        .iter()
        .map(|record| record.envelope.clone())
        .collect::<Vec<_>>();
    require_batch_token(&state, &headers, &envelopes)?;

    let records = body
        .records
        .into_iter()
        .map(|record| {
            (
                record.envelope,
                AckInput {
                    status: "applied".into(),
                    result: record.result,
                    inverse: record.inverse,
                    snapshot: record.snapshot,
                    ..AckInput::default()
                },
            )
        })
        .collect::<Vec<_>>();
    let acks = state.journal.record_batch(&doc_id, &records)?;
    Ok(Json(json!({ "docId": doc_id, "acks": acks })))
}

#[derive(Debug, Deserialize)]
struct DocAckItem {
    op_id: String,
    #[serde(flatten)]
    ack: AckInput,
}

#[derive(Debug, Deserialize)]
struct DocAckBody {
    acks: Vec<DocAckItem>,
}

async fn doc_acks(
    State(state): State<AppState>,
    Path(doc_id): Path<String>,
    Json(body): Json<DocAckBody>,
) -> Result<Json<Value>, ApiError> {
    let mut acks = Vec::with_capacity(body.acks.len());
    for item in body.acks {
        let ack = state.journal.complete(&doc_id, &item.op_id, item.ack)?;
        state.dispatch.resolve(&item.op_id, ack.clone()).await;
        acks.push(ack);
    }
    Ok(Json(json!({ "docId": doc_id, "acks": acks })))
}

#[derive(Debug, Default, Deserialize)]
struct UndoBody {
    actor: Option<Value>,
}

async fn doc_undo(
    State(state): State<AppState>,
    Path((doc_id, turn_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<UndoBody>,
) -> Result<Json<Value>, ApiError> {
    let claims = require_token(&state, &headers, "cap_undo")?;
    let actor = body
        .actor
        .unwrap_or_else(|| json!({ "kind": "human", "id": claims.sub.actor_id }));
    let capability = claims.cap_id;
    let plan = match state
        .journal
        .plan_undo(&doc_id, &turn_id, actor.clone(), &capability)
    {
        Ok(plan) => plan,
        Err(JournalError::UnknownTurn(unknown)) => {
            let ack = record_undo_rejection(
                &state,
                &doc_id,
                &turn_id,
                &actor,
                &capability,
                "unknown_target",
                format!("no turn {unknown}"),
            )?;
            return Ok(Json(json!({
                "docId": doc_id,
                "undoTurnId": Value::Null,
                "applied": false,
                "acks": [ack],
            })));
        }
        Err(JournalError::AlreadyUndone(message)) => {
            let ack = record_undo_rejection(
                &state,
                &doc_id,
                &turn_id,
                &actor,
                &capability,
                "already_undone",
                message,
            )?;
            return Ok(Json(json!({
                "docId": doc_id,
                "undoTurnId": Value::Null,
                "applied": false,
                "acks": [ack],
            })));
        }
        Err(error) => return Err(error.into()),
    };
    let acks = dispatch_batch(&state, &doc_id, &plan.envelopes).await?;
    let applied = acks
        .iter()
        .all(|ack| ack.get("status").and_then(Value::as_str) == Some("applied"));
    if applied {
        state
            .journal
            .mark_undone(&doc_id, &turn_id, &plan.undo_turn_id, actor)?;
    }
    Ok(Json(json!({
        "docId": doc_id,
        "undoTurnId": plan.undo_turn_id,
        "applied": applied,
        "acks": acks,
    })))
}

async fn doc_approve(
    State(state): State<AppState>,
    Path((doc_id, approval_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_token(&state, &headers, "cap_human")?;
    let target = state.journal.approval(&approval_id).ok_or_else(|| {
        ApiError::Protocol("approval_invalid", "unknown or expired approval".into())
    })?;
    if target.used {
        return Err(ApiError::Protocol(
            "approval_invalid",
            "approval was already used".into(),
        ));
    }
    if target.expires_at <= Utc::now() {
        return Err(ApiError::Protocol(
            "approval_invalid",
            "approval expired".into(),
        ));
    }
    if target.doc_id != doc_id {
        return Err(ApiError::Protocol(
            "approval_invalid",
            "approval belongs to another document".into(),
        ));
    }
    let op_id = target.op_id.clone().ok_or_else(|| {
        ApiError::Protocol("approval_invalid", "approval has no target op".into())
    })?;
    let Some(mut envelope) = state.journal.rejected_envelope(&doc_id, &op_id)? else {
        return Err(ApiError::Protocol(
            "approval_invalid",
            "the rejected op is no longer available".into(),
        ));
    };

    let Some(object) = envelope.as_object_mut() else {
        return Err(ApiError::Internal(
            "stored envelope is not an object".into(),
        ));
    };
    object.insert("approval".into(), json!(approval_id.clone()));
    object.insert("turn_id".into(), json!(format!("turn_approval_{op_id}")));
    object.insert("seq".into(), json!(0));
    object.insert(
        "approved_by".into(),
        json!({ "kind": "human", "id": "local" }),
    );
    // A request id is unique per bridge request; the approval is a new op.
    object.remove("request_id");
    object.remove("op_id");
    // The human is approving the op against the current document state.
    object.remove("expected_revision");

    let acks = dispatch_batch(&state, &doc_id, &[envelope]).await?;
    let applied = acks
        .iter()
        .all(|ack| ack.get("status").and_then(Value::as_str) == Some("applied"));
    Ok(Json(json!({
        "docId": doc_id,
        "approvalId": approval_id,
        "applied": applied,
        "acks": acks,
    })))
}

/// Verifies a capability token, requires a specific cap id, and registers its claims for the
/// journal check. Token verification is signature-only here; expiry and scope are enforced when
/// the envelope is journaled.
fn require_token(
    state: &AppState,
    headers: &HeaderMap,
    cap_id: &str,
) -> Result<CapabilityClaims, ApiError> {
    let token = headers
        .get("x-cg-capability")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::Forbidden("capability_denied", "missing X-CG-Capability token".into())
        })?;
    let claims = state
        .journal
        .verify_capability_token(token)
        .map_err(|error| ApiError::Forbidden("capability_denied", error.to_string()))?;
    if claims.cap_id != cap_id {
        return Err(ApiError::Forbidden(
            "capability_denied",
            format!("token is for {}, not {cap_id}", claims.cap_id),
        ));
    }
    state.journal.register_capability(claims.clone());
    Ok(claims)
}

fn require_batch_token(
    state: &AppState,
    headers: &HeaderMap,
    ops: &[Value],
) -> Result<CapabilityClaims, ApiError> {
    let required = ops
        .first()
        .and_then(|envelope| envelope.get("capability"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("each envelope needs a capability".into()))?;
    if !ops
        .iter()
        .all(|envelope| envelope.get("capability").and_then(Value::as_str) == Some(required))
    {
        return Err(ApiError::Forbidden(
            "capability_denied",
            "a batch may only use the token's capability".into(),
        ));
    }
    require_token(state, headers, required)
}

/// Journals an undo rejection (unknown or already-undone turn) so the attempt is auditable.
fn record_undo_rejection(
    state: &AppState,
    doc_id: &str,
    turn_id: &str,
    actor: &Value,
    capability: &str,
    code: &str,
    message: String,
) -> Result<Value, ApiError> {
    let envelope = json!({
        "v": 1,
        "doc_id": doc_id,
        "turn_id": format!("turn_undo_reject_{}", journal::random_id()),
        "seq": 0,
        "actor": actor,
        "capability": capability,
        "type": "chart.turn.undo",
        "target": { "kind": "turn", "id": turn_id },
        "payload": {},
        "rationale": format!("undo rejected: {code}"),
        "idempotency_key": format!("undo_reject_{}", journal::random_id()),
        "created_at": journal::now_iso(),
    });
    match state.journal.begin_single(doc_id, envelope)? {
        BatchItem::Pending(op) => Ok(state.journal.complete(
            doc_id,
            &op.op_id,
            AckInput {
                status: "rejected".into(),
                rejected_by: Some("server".into()),
                code: Some(code.into()),
                message: Some(message),
                retryable: Some(false),
                ..AckInput::default()
            },
        )?),
        BatchItem::Rejected(ack) | BatchItem::Replay(ack) => Ok(ack),
    }
}

/// Journals a batch, dispatches fresh ops to the browser, and waits for its acks.
async fn dispatch_batch(
    state: &AppState,
    doc_id: &str,
    envelopes: &[Value],
) -> Result<Vec<Value>, ApiError> {
    let items = state.journal.begin_batch(doc_id, envelopes)?;
    let mut pending = Vec::new();
    let mut acks: Vec<Option<Value>> = Vec::with_capacity(items.len());

    for item in items {
        match item {
            BatchItem::Replay(ack) => acks.push(Some(ack)),
            BatchItem::Rejected(ack) => acks.push(Some(ack)),
            BatchItem::Pending(op) if !op.fresh => acks.push(Some(json!({
                "v": 1,
                "op_id": op.op_id,
                "turn_id": op.turn_id,
                "seq": op.seq,
                "status": "rejected",
                "rejected_by": "server",
                "code": "conflict",
                "message": "the op is already in flight",
                "retryable": true,
            }))),
            BatchItem::Pending(op) => {
                let receiver = state.dispatch.register(&op.op_id).await;
                state.bridge.broadcast(json!({
                    "type": "doc.op.request",
                    "data": {
                        "docId": doc_id,
                        "opId": op.op_id,
                        "turnId": op.turn_id,
                        "seq": op.seq,
                        "envelope": op.envelope,
                    }
                }));
                pending.push((op.op_id, receiver, acks.len()));
                acks.push(None);
            }
        }
    }

    for (op_id, receiver, index) in pending {
        let ack = match tokio::time::timeout(Duration::from_secs(15), receiver).await {
            Ok(Ok(ack)) => ack,
            _ => state.journal.complete(
                doc_id,
                &op_id,
                AckInput {
                    status: "rejected".into(),
                    rejected_by: Some("server".into()),
                    code: Some("internal".into()),
                    message: Some("the client did not acknowledge the op in time".into()),
                    retryable: Some(true),
                    ..AckInput::default()
                },
            )?,
        };
        acks[index] = Some(ack);
    }

    Ok(acks
        .into_iter()
        .map(|ack| ack.unwrap_or(Value::Null))
        .collect())
}

async fn workspace_get(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    match state.workspaces.get(&key) {
        Ok(Some((payload, updated_at))) => {
            let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            Ok(Json(
                json!({ "key": key, "payload": payload, "updatedAt": updated_at }),
            ))
        }
        Ok(None) => Ok(Json(
            json!({ "key": key, "payload": null, "updatedAt": null }),
        )),
        Err(error) => Err(ApiError::BadRequest(error.to_string())),
    }
}

#[derive(Debug, Deserialize)]
struct WorkspacePutBody {
    payload: Value,
}

async fn workspace_put(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<WorkspacePutBody>,
) -> Result<Json<Value>, ApiError> {
    let payload = body.payload.to_string();
    state
        .workspaces
        .put(&key, &payload)
        .map(|updated_at| Json(json!({ "ok": true, "updatedAt": updated_at })))
        .map_err(|error| ApiError::BadRequest(error.to_string()))
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        ApiError::BadRequest(error.to_string())
    }
}

impl From<JournalError> for ApiError {
    fn from(error: JournalError) -> Self {
        match error {
            JournalError::InvalidDocId(message) => ApiError::Protocol("invalid_doc_id", message),
            JournalError::InvalidOp(message) => ApiError::Protocol("invalid_op", message),
            JournalError::IdempotencyConflict => ApiError::Protocol(
                "idempotency_conflict",
                "idempotency key was already used with a different payload".into(),
            ),
            JournalError::UnknownTurn(turn_id) => {
                ApiError::Protocol("unknown_turn", format!("unknown turn: {turn_id}"))
            }
            JournalError::AlreadyUndone(message) => ApiError::Protocol("already_undone", message),
            JournalError::UnknownOp(op_id) => {
                ApiError::Protocol("unknown_op", format!("unknown op: {op_id}"))
            }
            JournalError::Sqlite(inner) => ApiError::Internal(inner.to_string()),
            JournalError::Json(inner) => ApiError::Internal(inner.to_string()),
            JournalError::Token(inner) => {
                ApiError::Protocol("capability_denied", inner.to_string())
            }
        }
    }
}

/// TTLs sized to the poll cadence: intraday bars turn over quickly, daily bars slowly.
fn candles_ttl(interval: &str) -> Duration {
    match interval {
        "1minute" => Duration::from_secs(15),
        "5minute" | "15minute" | "30minute" | "60minute" | "240minute" => Duration::from_secs(45),
        _ => Duration::from_secs(180),
    }
}

/// API errors map to a stable JSON shape the frontend switches on.
pub enum ApiError {
    NotConnected,
    Unauthorized,
    ChatNotConfigured,
    BadRequest(String),
    /// A protocol-level rejection with a stable machine-readable code.
    Protocol(&'static str, String),
    Forbidden(&'static str, String),
    Upstream(String),
    Internal(String),
}

impl From<BridgeError> for ApiError {
    fn from(error: BridgeError) -> Self {
        match error {
            BridgeError::NotConfigured => ApiError::ChatNotConfigured,
            BridgeError::OpenCode(inner) => ApiError::Upstream(inner.to_string()),
        }
    }
}

impl From<IndmoneyError> for ApiError {
    fn from(error: IndmoneyError) -> Self {
        match error {
            IndmoneyError::NotConnected => ApiError::NotConnected,
            IndmoneyError::Unauthorized => ApiError::Unauthorized,
            IndmoneyError::Normalize(inner) => ApiError::Upstream(inner.to_string()),
            other => ApiError::Upstream(other.to_string()),
        }
    }
}

impl From<normalize::NormalizeError> for ApiError {
    fn from(error: normalize::NormalizeError) -> Self {
        ApiError::Upstream(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            ApiError::NotConnected => (
                StatusCode::SERVICE_UNAVAILABLE,
                "not_connected",
                "INDmoney is not connected".to_string(),
            ),
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "INDmoney authorization expired; reconnect required".to_string(),
            ),
            ApiError::ChatNotConfigured => (
                StatusCode::SERVICE_UNAVAILABLE,
                "chat_not_configured",
                "the agent bridge is not configured (OPENCODE_PASSWORD is unset)".to_string(),
            ),
            ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            ApiError::Protocol(code, message) => (StatusCode::UNPROCESSABLE_ENTITY, code, message),
            ApiError::Forbidden(code, message) => (StatusCode::FORBIDDEN, code, message),
            ApiError::Upstream(message) => (StatusCode::BAD_GATEWAY, "upstream", message),
            ApiError::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", message),
        };
        let mut body = json!({ "error": code, "message": message });
        if matches!(
            status,
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::UNAUTHORIZED
        ) {
            body["connectUrl"] = json!("/api/indmoney/connect");
        }
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candle_ttls_are_ordered_by_interval_speed() {
        assert!(candles_ttl("1minute") < candles_ttl("15minute"));
        assert!(candles_ttl("15minute") < candles_ttl("1day"));
    }
}
