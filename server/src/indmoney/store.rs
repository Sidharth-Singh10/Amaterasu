use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::oauth::{RegisteredClient, TokenSet};

/// Persisted INDmoney auth state (client registration + tokens) in one JSON file
/// with 0600 permissions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredAuth {
    pub client: Option<RegisteredClient>,
    pub tokens: Option<TokenSet>,
}

pub struct AuthStore {
    path: PathBuf,
}

impl AuthStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("indmoney-auth.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&self) -> StoredAuth {
        match tokio::fs::read_to_string(&self.path).await {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => StoredAuth::default(),
        }
    }

    pub async fn save(&self, auth: &StoredAuth) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let raw = serde_json::to_vec_pretty(auth)?;
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &raw).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = tokio::fs::metadata(&tmp).await?.permissions();
            perms.set_mode(0o600);
            tokio::fs::set_permissions(&tmp, perms).await?;
        }
        tokio::fs::rename(&tmp, &self.path).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("amaterasu-store-{}-{label}", std::process::id()))
    }

    #[tokio::test]
    async fn round_trips_and_creates_parent_dirs() {
        let dir = temp_dir("roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let store = AuthStore::new(&dir);
        assert!(store.load().await.client.is_none());

        let auth = StoredAuth {
            client: Some(RegisteredClient {
                client_id: "c1".into(),
                client_secret: Some("s1".into()),
                redirect_uri: "http://127.0.0.1:8787/cb".into(),
            }),
            tokens: Some(TokenSet {
                access_token: "a".into(),
                refresh_token: Some("r".into()),
                expires_at: 123,
                scope: Some("market:read".into()),
            }),
        };
        store.save(&auth).await.unwrap();
        let loaded = store.load().await;
        assert_eq!(loaded.client.unwrap().client_id, "c1");
        assert_eq!(loaded.tokens.unwrap().refresh_token.as_deref(), Some("r"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn corrupt_file_loads_as_default() {
        let dir = temp_dir("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("indmoney-auth.json"), "{not json").unwrap();
        let store = AuthStore::new(&dir);
        assert!(store.load().await.client.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
