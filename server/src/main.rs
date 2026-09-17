use std::{sync::Arc, time::Duration};

use amaterasu_server::{
    api::AppState,
    build_router,
    cache::Cache,
    config::Config,
    indmoney::IndmoneyClient,
};
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env();
    let http = reqwest::Client::builder()
        .user_agent(format!("amaterasu/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()?;

    let indmoney = Arc::new(IndmoneyClient::new(&config, http).await);
    let state = AppState {
        config: config.clone(),
        indmoney,
        cache: Arc::new(Cache::new()),
    };

    let mut app = build_router(state);
    if let Some(dir) = &config.static_dir {
        let index = dir.join("index.html");
        anyhow::ensure!(index.is_file(), "static index not found: {}", index.display());
        // SPA fallback: unknown paths serve index.html with a 200 (not_found_service would force 404).
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(&index)));
        tracing::info!(static_dir = %dir.display(), "serving built frontend");
    }

    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, data_dir = %config.data_dir.display(), "amaterasu-server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
