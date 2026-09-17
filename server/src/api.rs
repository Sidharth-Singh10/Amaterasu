use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    cache::Cache,
    config::Config,
    indmoney::{IndmoneyClient, IndmoneyError, normalize},
};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub indmoney: Arc<IndmoneyClient>,
    pub cache: Arc<Cache>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/indmoney/status", get(indmoney_status))
        .route("/api/indmoney/connect", get(indmoney_connect))
        .route("/api/indmoney/oauth/callback", get(indmoney_callback))
        .route("/api/search", get(search))
        .route("/api/candles", get(candles))
        .route("/api/quote", get(quote))
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
        return Redirect::temporary(&format!("{app_url}/?indmoney=error&message=missing+code+or+state"));
    };
    match state.indmoney.complete_connect(&code, &callback_state).await {
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
    Ok(Json(json!({ "results": normalize::normalize_search(&payload) })))
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
    let cache_key = format!("candles:{}:{}:{}", query.ind_key, query.interval, query.lookback);
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
                .call_tool_json("get_indian_stocks_details", json!({ "ind_keys": [ind_key] }))
                .await
        })
        .await?;
    let quote = normalize::normalize_quote(&payload, &query.ind_key)
        .ok_or_else(|| ApiError::Upstream(format!("no quote for {}", query.ind_key)))?;
    Ok(Json(quote))
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
    BadRequest(String),
    Upstream(String),
    Internal(String),
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
            ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            ApiError::Upstream(message) => (StatusCode::BAD_GATEWAY, "upstream", message),
            ApiError::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", message),
        };
        let mut body = json!({ "error": code, "message": message });
        if matches!(status, StatusCode::SERVICE_UNAVAILABLE | StatusCode::UNAUTHORIZED) {
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
