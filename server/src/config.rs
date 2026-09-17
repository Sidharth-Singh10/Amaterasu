use std::{env, path::PathBuf};

/// Runtime configuration, all from environment variables (see README / deploy runbook).
#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    /// Directory holding the built frontend; when set, the service serves it with an SPA fallback.
    pub static_dir: Option<PathBuf>,
    /// Directory for persisted state (INDmoney tokens). Created on demand.
    pub data_dir: PathBuf,
    /// Public URL of this service; the OAuth redirect_uri is derived from it.
    pub base_url: String,
    /// Where the browser is sent after a successful connect (dev: the Vite app).
    pub app_url: String,
    pub indmoney_mcp_url: String,
    pub indmoney_scope: String,
    /// OpenCode server used for chat/agent features. Chat is disabled without a password.
    pub opencode_base_url: String,
    pub opencode_password: Option<String>,
    pub opencode_agent: String,
    pub opencode_directory: String,
}

impl Config {
    pub fn from_env() -> Self {
        let bind = env::var("AMATERASU_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
        let base_url =
            env::var("AMATERASU_BASE_URL").unwrap_or_else(|_| format!("http://{bind}"));
        let app_url = env::var("AMATERASU_APP_URL").unwrap_or_else(|_| base_url.clone());
        Self {
            bind,
            static_dir: env::var("AMATERASU_STATIC_DIR").ok().map(PathBuf::from),
            data_dir: env::var("AMATERASU_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_data_dir()),
            base_url,
            app_url,
            indmoney_mcp_url: env::var("INDMONEY_MCP_URL")
                .unwrap_or_else(|_| "https://mcp.indmoney.com/mcp".to_string()),
            indmoney_scope: env::var("INDMONEY_SCOPE")
                .unwrap_or_else(|_| "market:read portfolio:read".to_string()),
            opencode_base_url: env::var("OPENCODE_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:4096".to_string()),
            opencode_password: env::var("OPENCODE_PASSWORD").ok(),
            opencode_agent: env::var("OPENCODE_AGENT")
                .unwrap_or_else(|_| "chart-analyst".to_string()),
            opencode_directory: env::var("OPENCODE_DIRECTORY").unwrap_or_else(|_| {
                // Walk up from the working directory looking for the agent project
                // (`<ancestor>/opencode/opencode.jsonc`), the same way config discovery does.
                let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                let mut candidate = Some(cwd.as_path());
                while let Some(directory) = candidate {
                    let nested = directory.join("opencode");
                    if nested.join("opencode.jsonc").is_file() {
                        return nested.to_string_lossy().into_owned();
                    }
                    candidate = directory.parent();
                }
                cwd.to_string_lossy().into_owned()
            }),
        }
    }

    pub fn redirect_uri(&self) -> String {
        format!(
            "{}/api/indmoney/oauth/callback",
            self.base_url.trim_end_matches('/')
        )
    }
}

fn default_data_dir() -> PathBuf {
    if let Ok(dir) = env::var("XDG_DATA_HOME") {
        return PathBuf::from(dir).join("amaterasu");
    }
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".local/share/amaterasu");
    }
    PathBuf::from("/tmp/amaterasu")
}
