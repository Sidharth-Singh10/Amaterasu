use std::{
    path::Path,
    sync::Mutex,
};

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

/// Per-symbol documents (annotations + computed series) persisted as JSON.
/// One row per symbol; the browser owns the content and pushes debounced snapshots.
pub const MAX_PAYLOAD_BYTES: usize = 1_048_576;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid workspace key: {0}")]
    InvalidKey(String),
    #[error("payload too large ({0} bytes, max {MAX_PAYLOAD_BYTES})")]
    PayloadTooLarge(usize),
    #[error("payload must be a JSON object")]
    InvalidPayload,
}

pub struct WorkspaceStore {
    connection: Mutex<Connection>,
}

impl WorkspaceStore {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS workspace_docs (
               key        TEXT PRIMARY KEY,
               payload    TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<(String, i64)>, WorkspaceError> {
        validate_key(key)?;
        let connection = self.connection.lock().expect("workspace lock poisoned");
        let row = connection
            .query_row(
                "SELECT payload, updated_at FROM workspace_docs WHERE key = ?1",
                params![key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    pub fn put(&self, key: &str, payload: &str) -> Result<i64, WorkspaceError> {
        validate_key(key)?;
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err(WorkspaceError::PayloadTooLarge(payload.len()));
        }
        if !serde_json::from_str::<serde_json::Value>(payload)
            .map(|value| value.is_object())
            .unwrap_or(false)
        {
            return Err(WorkspaceError::InvalidPayload);
        }
        let updated_at = chrono::Utc::now().timestamp_millis();
        let connection = self.connection.lock().expect("workspace lock poisoned");
        connection.execute(
            "INSERT INTO workspace_docs (key, payload, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            params![key, payload, updated_at],
        )?;
        Ok(updated_at)
    }
}

fn validate_key(key: &str) -> Result<(), WorkspaceError> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if valid {
        Ok(())
    } else {
        Err(WorkspaceError::InvalidKey(key.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(label: &str) -> WorkspaceStore {
        let dir = std::env::temp_dir().join(format!("amaterasu-ws-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        WorkspaceStore::open(&dir.join("workspaces.db")).unwrap()
    }

    #[test]
    fn round_trips_and_upserts() {
        let store = temp_store("roundtrip");
        assert!(store.get("INDS01052").unwrap().is_none());
        let first = store
            .put("INDS01052", r#"{"v":1,"annotations":[],"series":[]}"#)
            .unwrap();
        let second = store
            .put("INDS01052", r#"{"v":1,"annotations":[{"id":"a1"}],"series":[]}"#)
            .unwrap();
        assert!(second >= first);
        let (payload, updated_at) = store.get("INDS01052").unwrap().unwrap();
        assert!(payload.contains("a1"));
        assert_eq!(updated_at, second);
    }

    #[test]
    fn rejects_bad_keys_and_payloads() {
        let store = temp_store("reject");
        assert!(matches!(store.get("bad key"), Err(WorkspaceError::InvalidKey(_))));
        assert!(matches!(store.get(""), Err(WorkspaceError::InvalidKey(_))));
        assert!(matches!(
            store.put("ok", "[1,2,3]"),
            Err(WorkspaceError::InvalidPayload)
        ));
        assert!(matches!(
            store.put("ok", "not json"),
            Err(WorkspaceError::InvalidPayload)
        ));
        let big = format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_BYTES));
        assert!(matches!(
            store.put("ok", &big),
            Err(WorkspaceError::PayloadTooLarge(_))
        ));
    }
}
