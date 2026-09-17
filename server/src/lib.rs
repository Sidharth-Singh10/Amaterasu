pub mod api;
pub mod cache;
pub mod config;
pub mod indmoney;

use axum::Router;
use tower_http::trace::TraceLayer;

/// Builds the application router. Kept in the library so integration tests can drive it.
pub fn build_router(state: api::AppState) -> Router {
    api::routes().with_state(state).layer(TraceLayer::new_for_http())
}
