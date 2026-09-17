use std::path::PathBuf;

use anyhow::Context;
use axum::{Json, Router, routing::get};
use serde_json::json;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

/// Amaterasu backend skeleton (Phase 0).
///
/// Phase 1 fills this in with: INDmoney MCP client + OAuth, candle cache, and the REST
/// surface. Phase 2 adds the OpenCode bridge (RPC + event fan-out + SSE). For now it
/// proves the toolchain, serves a health probe, and hosts the built frontend when present.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let bind = std::env::var("AMATERASU_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let static_dir = std::env::var("AMATERASU_STATIC_DIR").ok().map(PathBuf::from);

    let mut app = Router::new().route("/api/health", get(health));

    if let Some(dir) = static_dir {
        let index = dir.join("index.html");
        anyhow::ensure!(index.is_file(), "static index not found: {}", index.display());
        // SPA fallback: unknown paths serve index.html so client-side routing works.
        app = app.fallback_service(ServeDir::new(&dir).not_found_service(ServeFile::new(&index)));
        tracing::info!(static_dir = %dir.display(), "serving built frontend");
    }

    let app = app.layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    tracing::info!(%bind, "amaterasu-server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "service": "amaterasu-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
