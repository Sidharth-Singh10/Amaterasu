pub mod api;
pub mod bridge;
pub mod cache;
pub mod config;
pub mod indmoney;
pub mod opencode;

use axum::Router;
use tower_http::trace::TraceLayer;

/// Builds the application router. Kept in the library so integration tests can drive it.
pub fn build_router(state: api::AppState) -> Router {
    api::routes().with_state(state).layer(TraceLayer::new_for_http())
}
