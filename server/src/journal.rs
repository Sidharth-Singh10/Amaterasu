//! Append-only op journal for Common Ground documents.
//!
//! The journal is authoritative for op ids, per-document revisions, idempotency, turn
//! boundaries, and the audit chain. It does **not** hold a domain reducer: applied results and
//! inverse ops come from the adapter (the browser) in the ack.
//!
//! Phase 1a journals at dispatch time on the existing chart bridge. Capability checks run at
//! intake, before an op is returned to an adapter; a rejected attempt is still journaled and
//! audited. Human approval records are in-memory and one-shot.

use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use thiserror::Error;

use crate::capability::{CapabilityRegistry, Rejection};

/// Maximum encoded envelope size accepted by the journal.
pub const MAX_ENVELOPE_BYTES: usize = 1_048_576;
const GENESIS_PREFIX: &str = "blake3:";

#[derive(Debug, Error)]
pub enum JournalError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid op: {0}")]
    InvalidOp(String),
    #[error("idempotency key was already used with a different payload")]
    IdempotencyConflict,
    #[error("unknown turn: {0}")]
    UnknownTurn(String),
    #[error("turn was already undone: {0}")]
    AlreadyUndone(String),
    #[error("unknown op: {0}")]
    UnknownOp(String),
    #[error("invalid document id: {0}")]
    InvalidDocId(String),
}

#[derive(Debug, Clone)]
pub struct PendingOp {
    pub op_id: String,
    pub seq: i64,
    pub turn_id: String,
    pub envelope: Value,
    /// False when an identical op was already pending (a retry), so it must not be dispatched twice.
    pub fresh: bool,
}

#[derive(Debug, Clone)]
pub enum BatchItem {
    Pending(PendingOp),
    /// The op was already applied under this idempotency key; return the stored ack.
    Replay(Value),
    /// The op was journaled and rejected at intake (capability, scope, or approval).
    Rejected(Value),
}

#[derive(Debug, Default, Deserialize)]
pub struct AckInput {
    pub status: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub inverse: Option<Value>,
    #[serde(default)]
    pub rejected_by: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub retryable: Option<bool>,
    #[serde(default)]
    pub suggestion: Option<Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DocMeta {
    pub doc_id: String,
    pub revision: i64,
    pub next_seq: i64,
    pub pending: i64,
    pub audit_seq: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VerifyResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UndoPlan {
    pub undo_turn_id: String,
    pub envelopes: Vec<Value>,
}

pub struct JournalStore {
    connection: Mutex<Connection>,
    capabilities: CapabilityRegistry,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS doc_meta (
  doc_id     TEXT PRIMARY KEY,
  revision   INTEGER NOT NULL DEFAULT 0,
  next_seq   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_ops (
  doc_id          TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  op_id           TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  request_id      TEXT,
  status          TEXT NOT NULL,
  envelope        TEXT NOT NULL,
  ack             TEXT,
  inverse         TEXT,
  revision        INTEGER,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  PRIMARY KEY (doc_id, seq),
  UNIQUE (doc_id, op_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS doc_ops_request
  ON doc_ops(doc_id, request_id) WHERE request_id IS NOT NULL;

-- Only applied ops are idempotency-cached; a rejected attempt may be retried with the same key.
CREATE UNIQUE INDEX IF NOT EXISTS doc_ops_applied_key
  ON doc_ops(doc_id, idempotency_key) WHERE status = 'applied';

CREATE INDEX IF NOT EXISTS doc_ops_turn
  ON doc_ops(doc_id, turn_id, seq);

CREATE TABLE IF NOT EXISTS doc_turns (
  doc_id     TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  actor      TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  undoes     TEXT,
  undone_by  TEXT,
  PRIMARY KEY (doc_id, turn_id)
);

CREATE TABLE IF NOT EXISTS doc_audit (
  doc_id    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  revision  INTEGER NOT NULL,
  op_id     TEXT NOT NULL,
  turn_id   TEXT NOT NULL,
  status    TEXT NOT NULL,
  entry     TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  PRIMARY KEY (doc_id, seq)
);
"#;

impl JournalStore {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection: Mutex::new(connection),
            capabilities: CapabilityRegistry::local(),
        })
    }

    /// Rebinds the local agent capability when `OPENCODE_AGENT` is not `chart-analyst`.
    pub fn bind_local_agent(&self, agent_id: &str) {
        self.capabilities.bind_actor("cap_local", agent_id);
    }

    /// Registers a capability for local use. Hosted deployments replace this with token
    /// verification against an issuer key.
    pub fn mint_capability(&self, claims: Value) -> Result<(), JournalError> {
        self.capabilities
            .mint_json(claims)
            .map_err(JournalError::Json)
    }

    /// Looks up a pending one-shot approval without consuming it.
    pub fn approval(&self, approval_id: &str) -> Option<crate::capability::ApprovalTarget> {
        self.capabilities.approval(approval_id)
    }

    /// The original rejected envelope for an approval's target op.
    pub fn rejected_envelope(
        &self,
        doc_id: &str,
        op_id: &str,
    ) -> Result<Option<Value>, JournalError> {
        validate_doc_id(doc_id)?;
        let connection = self.connection.lock().expect("journal lock poisoned");
        let envelope: Option<String> = connection
            .query_row(
                "SELECT envelope FROM doc_ops
                 WHERE doc_id = ?1 AND op_id = ?2 AND status = 'rejected'",
                params![doc_id, op_id],
                |row| row.get(0),
            )
            .optional()?;
        envelope
            .map(|envelope| serde_json::from_str(&envelope).map_err(JournalError::from))
            .transpose()
    }

    /// Applies a batch in order. Returns one item per input envelope.
    pub fn begin_batch(
        &self,
        doc_id: &str,
        envelopes: &[Value],
    ) -> Result<Vec<BatchItem>, JournalError> {
        validate_doc_id(doc_id)?;
        let mut connection = self.connection.lock().expect("journal lock poisoned");
        let transaction = connection.transaction()?;
        ensure_doc_tx(&transaction, doc_id)?;

        let mut items = Vec::with_capacity(envelopes.len());
        for envelope in envelopes {
            items.push(begin_one_tx(
                &transaction,
                &self.capabilities,
                doc_id,
                envelope,
            )?);
        }
        transaction.commit()?;
        Ok(items)
    }

    pub fn begin_single(&self, doc_id: &str, envelope: Value) -> Result<BatchItem, JournalError> {
        self.begin_batch(doc_id, &[envelope])
            .map(|mut items| items.remove(0))
    }

    /// Finalizes an op with the adapter's ack. Idempotent: finalizing twice returns the stored ack.
    pub fn complete(
        &self,
        doc_id: &str,
        op_id: &str,
        input: AckInput,
    ) -> Result<Value, JournalError> {
        validate_doc_id(doc_id)?;
        let mut connection = self.connection.lock().expect("journal lock poisoned");
        let transaction = connection.transaction()?;

        let row = transaction
            .query_row(
                "SELECT turn_id, seq, status, envelope, ack FROM doc_ops
                 WHERE doc_id = ?1 AND op_id = ?2",
                params![doc_id, op_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| JournalError::UnknownOp(op_id.to_string()))?;
        let (turn_id, seq, status, envelope_json, stored_ack) = row;

        if status != "pending" {
            if let Some(ack) = stored_ack {
                return Ok(serde_json::from_str(&ack)?);
            }
            return Err(JournalError::UnknownOp(op_id.to_string()));
        }

        let envelope: Value = serde_json::from_str(&envelope_json)?;
        let ack = finalize_tx(&transaction, doc_id, op_id, &turn_id, seq, &envelope, input)?;
        transaction.commit()?;
        Ok(ack)
    }

    /// Finds an op by the request id carried in the envelope (the existing chart bridge).
    pub fn complete_by_request(
        &self,
        request_id: &str,
        input: AckInput,
    ) -> Result<Option<Value>, JournalError> {
        let (doc_id, op_id) = {
            let connection = self.connection.lock().expect("journal lock poisoned");
            let row = connection
                .query_row(
                    "SELECT doc_id, op_id FROM doc_ops WHERE request_id = ?1",
                    params![request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            match row {
                Some(row) => row,
                None => return Ok(None),
            }
        };
        self.complete(&doc_id, &op_id, input).map(Some)
    }

    pub fn meta(&self, doc_id: &str) -> Result<DocMeta, JournalError> {
        validate_doc_id(doc_id)?;
        let connection = self.connection.lock().expect("journal lock poisoned");
        ensure_doc(&connection, doc_id)?;
        connection
            .query_row(
                "SELECT m.revision, m.next_seq,
                        (SELECT COUNT(*) FROM doc_ops o WHERE o.doc_id = m.doc_id AND o.status = 'pending'),
                        (SELECT COALESCE(MAX(seq), 0) FROM doc_audit a WHERE a.doc_id = m.doc_id)
                 FROM doc_meta m WHERE m.doc_id = ?1",
                params![doc_id],
                |row| {
                    Ok(DocMeta {
                        doc_id: doc_id.to_string(),
                        revision: row.get(0)?,
                        next_seq: row.get(1)?,
                        pending: row.get(2)?,
                        audit_seq: row.get(3)?,
                    })
                },
            )
            .map_err(JournalError::from)
    }

    /// Most recent ops first, capped so a history panel cannot pull an unbounded log.
    pub fn list_ops(&self, doc_id: &str, limit: i64) -> Result<Vec<Value>, JournalError> {
        validate_doc_id(doc_id)?;
        let connection = self.connection.lock().expect("journal lock poisoned");
        let mut statement = connection.prepare(
            "SELECT o.seq, o.op_id, o.turn_id, o.status, o.revision, o.envelope, o.ack,
                    t.undoes, t.undone_by
             FROM doc_ops o
             JOIN doc_turns t ON t.doc_id = o.doc_id AND t.turn_id = o.turn_id
             WHERE o.doc_id = ?1 ORDER BY o.seq DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![doc_id, limit.clamp(1, 200)], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (seq, op_id, turn_id, status, revision, envelope, ack, undoes, undone_by) = row?;
            Ok(json!({
                "seq": seq,
                "op_id": op_id,
                "turn_id": turn_id,
                "status": status,
                "revision": revision,
                "envelope": serde_json::from_str::<Value>(&envelope)?,
                "ack": ack
                    .map(|ack| serde_json::from_str::<Value>(&ack))
                    .transpose()?,
                "undoes": undoes,
                "undone_by": undone_by,
            }))
        })
        .collect()
    }

    pub fn audit(&self, doc_id: &str) -> Result<Vec<Value>, JournalError> {
        validate_doc_id(doc_id)?;
        let connection = self.connection.lock().expect("journal lock poisoned");
        let mut statement =
            connection.prepare("SELECT entry FROM doc_audit WHERE doc_id = ?1 ORDER BY seq ASC")?;
        statement
            .query_map(params![doc_id], |row| row.get::<_, String>(0))?
            .map(|entry| {
                entry
                    .map_err(JournalError::from)
                    .and_then(|entry| serde_json::from_str(&entry).map_err(JournalError::from))
            })
            .collect()
    }

    pub fn verify(&self, doc_id: &str) -> Result<VerifyResult, JournalError> {
        let entries = self.audit(doc_id)?;
        let mut previous = genesis_hash();
        for (index, entry) in entries.iter().enumerate() {
            let expected_seq = (index + 1) as i64;
            let seq = entry.get("seq").and_then(Value::as_i64);
            if seq != Some(expected_seq) {
                return Ok(VerifyResult {
                    ok: false,
                    broken_at: Some(expected_seq),
                    reason: Some(format!("expected seq {expected_seq}, found {seq:?}")),
                });
            }
            if entry.get("prev_hash").and_then(Value::as_str) != Some(previous.as_str()) {
                return Ok(VerifyResult {
                    ok: false,
                    broken_at: Some(expected_seq),
                    reason: Some("prev_hash does not link to the previous entry".into()),
                });
            }
            let recomputed = hash_entry(&previous, entry)?;
            if entry.get("hash").and_then(Value::as_str) != Some(recomputed.as_str()) {
                return Ok(VerifyResult {
                    ok: false,
                    broken_at: Some(expected_seq),
                    reason: Some("digest mismatch".into()),
                });
            }
            previous = recomputed;
        }
        Ok(VerifyResult {
            ok: true,
            broken_at: None,
            reason: None,
        })
    }

    /// Builds the inverse batch for a turn as a new turn. The caller is responsible for
    /// dispatching it and then calling [`Self::mark_undone`] once every ack is applied.
    pub fn plan_undo(
        &self,
        doc_id: &str,
        turn_id: &str,
        actor: Value,
        capability: &str,
    ) -> Result<UndoPlan, JournalError> {
        validate_doc_id(doc_id)?;
        let connection = self.connection.lock().expect("journal lock poisoned");

        let turn = connection
            .query_row(
                "SELECT undone_by FROM doc_turns WHERE doc_id = ?1 AND turn_id = ?2",
                params![doc_id, turn_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| JournalError::UnknownTurn(turn_id.to_string()))?;
        if let Some(undo_turn) = turn {
            return Err(JournalError::AlreadyUndone(format!(
                "{turn_id} was undone by {undo_turn}"
            )));
        }

        let mut statement = connection.prepare(
            "SELECT inverse FROM doc_ops
             WHERE doc_id = ?1 AND turn_id = ?2 AND status = 'applied' ORDER BY seq ASC",
        )?;
        let mut inverses: Vec<Value> = Vec::new();
        for row in statement.query_map(params![doc_id, turn_id], |row| row.get::<_, String>(0))? {
            let current: Value = serde_json::from_str(&row?)?;
            let array = current.as_array().ok_or_else(|| {
                JournalError::InvalidOp("stored inverse is not an array".to_string())
            })?;
            inverses.extend(array.iter().cloned());
        }
        inverses.reverse();
        if inverses.is_empty() {
            return Err(JournalError::InvalidOp(format!(
                "turn {turn_id} has no reversible ops"
            )));
        }

        let undo_turn_id = format!("turn_undo_{}", random_id());
        let created_at = now_iso();
        let mut envelopes = Vec::with_capacity(inverses.len());
        for (index, inverse) in inverses.iter().enumerate() {
            let object = inverse.as_object().ok_or_else(|| {
                JournalError::InvalidOp("inverse entries must be objects".to_string())
            })?;
            let op_type = object
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| JournalError::InvalidOp("inverse entry needs type".into()))?;
            let target = object
                .get("target")
                .cloned()
                .ok_or_else(|| JournalError::InvalidOp("inverse entry needs target".into()))?;
            let payload = object.get("payload").cloned().unwrap_or_else(|| json!({}));
            let seq = (index + 1) as i64;
            envelopes.push(json!({
                "v": 1,
                "doc_id": doc_id,
                "turn_id": undo_turn_id,
                "seq": seq,
                "actor": actor.clone(),
                "capability": capability,
                "type": op_type,
                "target": target,
                "payload": payload,
                "rationale": format!("undo of {turn_id}"),
                "idempotency_key": format!("{undo_turn_id}:{seq}"),
                "created_at": created_at.clone(),
            }));
        }

        Ok(UndoPlan {
            undo_turn_id,
            envelopes,
        })
    }

    pub fn mark_undone(
        &self,
        doc_id: &str,
        turn_id: &str,
        undo_turn_id: &str,
        actor: Value,
    ) -> Result<(), JournalError> {
        validate_doc_id(doc_id)?;
        let connection = self.connection.lock().expect("journal lock poisoned");
        let now = now_ms();
        connection.execute(
            "UPDATE doc_turns SET undone_by = ?1 WHERE doc_id = ?2 AND turn_id = ?3",
            params![undo_turn_id, doc_id, turn_id],
        )?;
        connection.execute(
            "INSERT INTO doc_turns (doc_id, turn_id, actor, started_at, undoes)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(doc_id, turn_id) DO UPDATE SET undoes = excluded.undoes",
            params![doc_id, undo_turn_id, actor.to_string(), now, turn_id],
        )?;
        Ok(())
    }

    /// Fails ops that were dispatched but never acknowledged (browser closed, tab lost).
    pub fn expire_pending(&self, max_age_secs: i64) -> Result<usize, JournalError> {
        let cutoff = now_ms() - max_age_secs.max(1) * 1000;
        let pending: Vec<(String, String)> = {
            let connection = self.connection.lock().expect("journal lock poisoned");
            let mut statement = connection.prepare(
                "SELECT doc_id, op_id FROM doc_ops WHERE status = 'pending' AND created_at < ?1",
            )?;
            statement
                .query_map(params![cutoff], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<_, _>>()?
        };
        let mut expired = 0;
        for (doc_id, op_id) in pending {
            self.complete(
                &doc_id,
                &op_id,
                AckInput {
                    status: "rejected".into(),
                    rejected_by: Some("server".into()),
                    code: Some("internal".into()),
                    message: Some("the client did not acknowledge the op in time".into()),
                    retryable: Some(true),
                    ..AckInput::default()
                },
            )?;
            expired += 1;
        }
        Ok(expired)
    }
}

fn begin_one_tx(
    transaction: &rusqlite::Transaction<'_>,
    capabilities: &CapabilityRegistry,
    doc_id: &str,
    envelope: &Value,
) -> Result<BatchItem, JournalError> {
    validate_envelope(envelope, doc_id)?;
    let fingerprint = canonical_json(envelope)?;

    let key = envelope
        .get("idempotency_key")
        .and_then(Value::as_str)
        .expect("validated");

    let applied: Option<(String, String)> = transaction
        .query_row(
            "SELECT ack, fingerprint FROM doc_ops
             WHERE doc_id = ?1 AND idempotency_key = ?2 AND status = 'applied'",
            params![doc_id, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((ack, stored_fingerprint)) = applied {
        if stored_fingerprint != fingerprint {
            return Err(JournalError::IdempotencyConflict);
        }
        return Ok(BatchItem::Replay(serde_json::from_str(&ack)?));
    }

    let pending: Option<(String, i64, String, String)> = transaction
        .query_row(
            "SELECT op_id, seq, turn_id, fingerprint FROM doc_ops
             WHERE doc_id = ?1 AND idempotency_key = ?2 AND status = 'pending'
             ORDER BY seq DESC LIMIT 1",
            params![doc_id, key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((op_id, seq, turn_id, stored_fingerprint)) = pending {
        if stored_fingerprint != fingerprint {
            return Err(JournalError::IdempotencyConflict);
        }
        let stored: String = transaction.query_row(
            "SELECT envelope FROM doc_ops WHERE doc_id = ?1 AND op_id = ?2",
            params![doc_id, op_id],
            |row| row.get(0),
        )?;
        return Ok(BatchItem::Pending(PendingOp {
            op_id,
            seq,
            turn_id,
            envelope: serde_json::from_str(&stored)?,
            fresh: false,
        }));
    }

    let turn_id = envelope
        .get("turn_id")
        .and_then(Value::as_str)
        .expect("validated")
        .to_string();
    let requested_seq = envelope.get("seq").and_then(Value::as_i64).unwrap_or(0);
    let next_seq: i64 = transaction.query_row(
        "SELECT next_seq FROM doc_meta WHERE doc_id = ?1",
        params![doc_id],
        |row| row.get(0),
    )?;
    let seq = if requested_seq > 0 {
        let taken: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM doc_ops WHERE doc_id = ?1 AND seq = ?2)",
            params![doc_id, requested_seq],
            |row| row.get(0),
        )?;
        if taken { next_seq } else { requested_seq }
    } else {
        next_seq
    };
    transaction.execute(
        "UPDATE doc_meta SET next_seq = MAX(next_seq, ?2) WHERE doc_id = ?1",
        params![doc_id, seq + 1],
    )?;

    let op_id = format!("op_{}", random_id());
    let request_id = envelope.get("request_id").and_then(Value::as_str);

    let mut stored = envelope.clone();
    if let Some(object) = stored.as_object_mut() {
        object.insert("op_id".into(), json!(op_id));
        object.insert("seq".into(), json!(seq));
    }

    transaction.execute(
        "INSERT INTO doc_ops
           (doc_id, seq, op_id, turn_id, idempotency_key, fingerprint, request_id,
            status, envelope, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)",
        params![
            doc_id,
            seq,
            op_id,
            turn_id,
            key,
            fingerprint,
            request_id,
            stored.to_string(),
            now_ms()
        ],
    )?;

    let actor = envelope
        .get("actor")
        .cloned()
        .expect("validated")
        .to_string();
    transaction.execute(
        "INSERT INTO doc_turns (doc_id, turn_id, actor, started_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(doc_id, turn_id) DO UPDATE SET ended_at = excluded.started_at",
        params![doc_id, turn_id, actor, now_ms()],
    )?;

    let stale_revision = match envelope.get("expected_revision").and_then(Value::as_i64) {
        Some(expected) => {
            let current: i64 = transaction.query_row(
                "SELECT revision FROM doc_meta WHERE doc_id = ?1",
                params![doc_id],
                |row| row.get(0),
            )?;
            (expected != current).then(|| Rejection {
                code: "revision_conflict",
                message: format!("expected revision {expected}, current revision {current}"),
                retryable: true,
                rejected_by: "server",
                suggestion: None,
            })
        }
        None => None,
    };
    let rejection =
        stale_revision.or_else(|| capabilities.verify(envelope, chrono::Utc::now(), Some(&op_id)));
    if let Some(rejection) = rejection {
        let ack = finalize_tx(
            transaction,
            doc_id,
            &op_id,
            &turn_id,
            seq,
            &stored,
            AckInput {
                status: "rejected".into(),
                rejected_by: Some(rejection.rejected_by.into()),
                code: Some(rejection.code.into()),
                message: Some(rejection.message),
                retryable: Some(rejection.retryable),
                suggestion: rejection.suggestion,
                ..AckInput::default()
            },
        )?;
        return Ok(BatchItem::Rejected(ack));
    }

    Ok(BatchItem::Pending(PendingOp {
        op_id,
        seq,
        turn_id,
        envelope: stored,
        fresh: true,
    }))
}

fn finalize_tx(
    transaction: &rusqlite::Transaction<'_>,
    doc_id: &str,
    op_id: &str,
    turn_id: &str,
    seq: i64,
    envelope: &Value,
    input: AckInput,
) -> Result<Value, JournalError> {
    let status = match input.status.as_str() {
        "applied" | "rejected" => input.status.as_str(),
        other => {
            return Err(JournalError::InvalidOp(format!(
                "ack status must be applied or rejected, got {other}"
            )));
        }
    };
    let op_type = envelope
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let verb = op_type.rsplit('.').next().unwrap_or_default();
    let mut revision: i64 = transaction.query_row(
        "SELECT revision FROM doc_meta WHERE doc_id = ?1",
        params![doc_id],
        |row| row.get(0),
    )?;

    let inverse = input.inverse.unwrap_or_else(|| json!([]));
    if !inverse.is_array() {
        return Err(JournalError::InvalidOp(
            "ack inverse must be an array".to_string(),
        ));
    }

    let ack = if status == "applied" {
        if verb != "set" {
            revision += 1;
            transaction.execute(
                "UPDATE doc_meta SET revision = ?2 WHERE doc_id = ?1",
                params![doc_id, revision],
            )?;
        }
        json!({
            "v": 1,
            "op_id": op_id,
            "turn_id": turn_id,
            "seq": seq,
            "status": "applied",
            "revision": revision,
            "result": input.result.unwrap_or_else(|| json!({})),
            "inverse": inverse.clone(),
        })
    } else {
        let code = input
            .code
            .ok_or_else(|| JournalError::InvalidOp("rejected ack requires a code".to_string()))?;
        let message = input.message.ok_or_else(|| {
            JournalError::InvalidOp("rejected ack requires a message".to_string())
        })?;
        let mut ack = Map::new();
        ack.insert("v".into(), json!(1));
        ack.insert("op_id".into(), json!(op_id));
        ack.insert("turn_id".into(), json!(turn_id));
        ack.insert("seq".into(), json!(seq));
        ack.insert("status".into(), json!("rejected"));
        ack.insert("revision".into(), json!(revision));
        ack.insert(
            "rejected_by".into(),
            json!(input.rejected_by.unwrap_or_else(|| "server".into())),
        );
        ack.insert("code".into(), json!(code));
        ack.insert("message".into(), json!(message));
        ack.insert("retryable".into(), json!(input.retryable.unwrap_or(false)));
        if let Some(suggestion) = input.suggestion {
            ack.insert("suggestion".into(), suggestion);
        }
        Value::Object(ack)
    };

    transaction.execute(
        "UPDATE doc_ops
         SET status = ?3, ack = ?4, inverse = ?5, revision = ?6, completed_at = ?7
         WHERE doc_id = ?1 AND op_id = ?2",
        params![
            doc_id,
            op_id,
            status,
            ack.to_string(),
            inverse.to_string(),
            revision,
            now_ms()
        ],
    )?;

    // Audit entries are append-only and include rejections.
    let audit_seq: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM doc_audit WHERE doc_id = ?1",
        params![doc_id],
        |row| row.get(0),
    )?;
    let previous: String = transaction
        .query_row(
            "SELECT hash FROM doc_audit WHERE doc_id = ?1 ORDER BY seq DESC LIMIT 1",
            params![doc_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(genesis_hash);

    let mut body = Map::new();
    body.insert("v".into(), json!(1));
    body.insert("doc_id".into(), json!(doc_id));
    body.insert("seq".into(), json!(audit_seq));
    body.insert("revision".into(), json!(revision));
    body.insert("op_id".into(), json!(op_id));
    body.insert("turn_id".into(), json!(turn_id));
    body.insert("status".into(), json!(status));
    body.insert(
        "actor".into(),
        envelope.get("actor").cloned().unwrap_or(Value::Null),
    );
    body.insert(
        "capability".into(),
        envelope.get("capability").cloned().unwrap_or(Value::Null),
    );
    body.insert("type".into(), json!(op_type));
    body.insert(
        "target".into(),
        envelope.get("target").cloned().unwrap_or(Value::Null),
    );
    if let Some(rationale) = envelope.get("rationale") {
        body.insert("rationale".into(), rationale.clone());
    }
    body.insert(
        "created_at".into(),
        envelope
            .get("created_at")
            .cloned()
            .unwrap_or_else(|| json!(now_iso())),
    );
    let entry_body = Value::Object(body);
    let hash = hash_entry(&previous, &entry_body)?;
    let mut entry = entry_body;
    if let Some(object) = entry.as_object_mut() {
        object.insert("prev_hash".into(), json!(previous));
        object.insert("hash".into(), json!(hash));
    }

    transaction.execute(
        "INSERT INTO doc_audit
           (doc_id, seq, revision, op_id, turn_id, status, entry, prev_hash, hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            doc_id,
            audit_seq,
            revision,
            op_id,
            turn_id,
            status,
            entry.to_string(),
            previous,
            hash
        ],
    )?;
    transaction.execute(
        "UPDATE doc_turns SET ended_at = ?3 WHERE doc_id = ?1 AND turn_id = ?2",
        params![doc_id, turn_id, now_ms()],
    )?;

    Ok(ack)
}

fn validate_envelope(envelope: &Value, doc_id: &str) -> Result<(), JournalError> {
    let object = envelope
        .as_object()
        .ok_or_else(|| JournalError::InvalidOp("envelope must be an object".into()))?;
    let encoded = serde_json::to_string(envelope)?;
    if encoded.len() > MAX_ENVELOPE_BYTES {
        return Err(JournalError::InvalidOp(format!(
            "envelope is {} bytes (max {MAX_ENVELOPE_BYTES})",
            encoded.len()
        )));
    }
    if object.get("v").and_then(Value::as_i64) != Some(1) {
        return Err(JournalError::InvalidOp("v must be 1".into()));
    }
    if object.get("doc_id").and_then(Value::as_str) != Some(doc_id) {
        return Err(JournalError::InvalidOp(
            "doc_id does not match the route".into(),
        ));
    }
    let non_empty = |field: &str| -> Result<(), JournalError> {
        match object.get(field).and_then(Value::as_str) {
            Some(value) if !value.is_empty() && value.len() <= 256 => Ok(()),
            _ => Err(JournalError::InvalidOp(format!(
                "{field} must be a non-empty string"
            ))),
        }
    };
    for field in ["turn_id", "capability", "idempotency_key"] {
        non_empty(field)?;
    }
    let op_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| JournalError::InvalidOp("type must be a string".into()))?;
    if op_type.split('.').count() < 3 || op_type.split('.').any(|segment| segment.is_empty()) {
        return Err(JournalError::InvalidOp(
            "type must be <domain>.<object>.<verb>".into(),
        ));
    }
    if object.get("seq").and_then(Value::as_i64).unwrap_or(0) < 0 {
        return Err(JournalError::InvalidOp("seq must be positive".into()));
    }
    let actor = object
        .get("actor")
        .and_then(Value::as_object)
        .ok_or_else(|| JournalError::InvalidOp("actor must be an object".into()))?;
    if !matches!(
        actor.get("kind").and_then(Value::as_str),
        Some("human" | "agent" | "system")
    ) {
        return Err(JournalError::InvalidOp(
            "actor.kind must be human, agent, or system".into(),
        ));
    }
    if actor
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(JournalError::InvalidOp("actor.id is required".into()));
    }
    let target = object
        .get("target")
        .and_then(Value::as_object)
        .ok_or_else(|| JournalError::InvalidOp("target must be an object".into()))?;
    if target
        .get("kind")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(JournalError::InvalidOp("target.kind is required".into()));
    }
    if !object.get("payload").is_some_and(Value::is_object) {
        return Err(JournalError::InvalidOp("payload must be an object".into()));
    }
    let created_at = object
        .get("created_at")
        .and_then(Value::as_str)
        .ok_or_else(|| JournalError::InvalidOp("created_at is required".into()))?;
    chrono::DateTime::parse_from_rfc3339(created_at)
        .map_err(|_| JournalError::InvalidOp("created_at must be RFC 3339".into()))?;
    if let Some(expected) = object.get("expected_revision")
        && expected.as_i64().is_none_or(|value| value < 0)
    {
        return Err(JournalError::InvalidOp(
            "expected_revision must be a non-negative integer".into(),
        ));
    }
    Ok(())
}

fn validate_doc_id(doc_id: &str) -> Result<(), JournalError> {
    let valid = !doc_id.is_empty()
        && doc_id.len() <= 128
        && doc_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character));
    if valid {
        Ok(())
    } else {
        Err(JournalError::InvalidDocId(doc_id.to_string()))
    }
}

fn ensure_doc(connection: &Connection, doc_id: &str) -> Result<(), JournalError> {
    connection.execute(
        "INSERT INTO doc_meta (doc_id, revision, next_seq, created_at)
         VALUES (?1, 0, 1, ?2) ON CONFLICT(doc_id) DO NOTHING",
        params![doc_id, now_ms()],
    )?;
    Ok(())
}

fn ensure_doc_tx(
    transaction: &rusqlite::Transaction<'_>,
    doc_id: &str,
) -> Result<(), JournalError> {
    transaction.execute(
        "INSERT INTO doc_meta (doc_id, revision, next_seq, created_at)
         VALUES (?1, 0, 1, ?2) ON CONFLICT(doc_id) DO NOTHING",
        params![doc_id, now_ms()],
    )?;
    Ok(())
}

/// Canonical JSON: serde_json's map is a BTreeMap, so keys are sorted; no whitespace.
pub fn canonical_json(value: &Value) -> Result<String, JournalError> {
    Ok(serde_json::to_string(value)?)
}

pub fn genesis_hash() -> String {
    format!("{GENESIS_PREFIX}{}", "0".repeat(64))
}

/// `blake3(utf8(prev_hash) || "\n" || utf8(canonical_json(entry without hash/prev_hash)))`.
pub fn hash_entry(previous: &str, entry: &Value) -> Result<String, JournalError> {
    let mut body = entry.clone();
    if let Some(object) = body.as_object_mut() {
        object.remove("hash");
        object.remove("prev_hash");
    }
    let canonical = serde_json::to_string(&body)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(previous.as_bytes());
    hasher.update(b"\n");
    hasher.update(canonical.as_bytes());
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn random_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// Wraps the existing chart bridge's `op.request` payload in a protocol envelope.
///
/// The chart adapter still speaks the chart DSL; the envelope gives the journal a stable
/// type/target/actor so the op can be audited, and the payload carries the adapter op through
/// unchanged. The journal assigns `seq` (0 here means "next").
pub fn chart_op_envelope(data: &Value, agent_id: &str) -> Option<Value> {
    let request_id = data.get("requestId")?.as_str()?;
    let chart_id = data.get("chartId")?.as_str()?;
    let op = data.get("op")?.as_object()?;
    let kind = op.get("op")?.as_str()?;
    let source = op.get("source").and_then(Value::as_object);
    let session = source
        .and_then(|source| source.get("sessionID"))
        .and_then(Value::as_str);
    let message = source
        .and_then(|source| source.get("messageID"))
        .and_then(Value::as_str);
    let turn_id = match (session, message) {
        (Some(session), Some(message)) => format!("turn_{session}:{message}"),
        _ => format!("turn_req_{request_id}"),
    };

    let mut actor = Map::new();
    actor.insert("kind".into(), json!("agent"));
    actor.insert("id".into(), json!(agent_id));
    if let Some(session) = session {
        actor.insert("session".into(), json!(session));
    }
    if let Some(message) = message {
        actor.insert("message".into(), json!(message));
    }

    Some(json!({
        "v": 1,
        "doc_id": chart_id,
        "turn_id": turn_id,
        "seq": 0,
        "actor": Value::Object(actor),
        "capability": "cap_local",
        "type": chart_op_type(kind),
        "target": chart_op_target(op),
        "payload": { "op": op },
        "rationale": format!("agent chart op: {kind}"),
        "idempotency_key": request_id,
        "request_id": request_id,
        "created_at": now_iso(),
    }))
}

fn chart_op_type(kind: &str) -> &'static str {
    match kind {
        "draw" => "chart.shape.create",
        "update" => "chart.shape.update",
        "remove" => "chart.shape.delete",
        "clear" => "chart.shape.clear",
        "add_series" => "chart.series.upsert",
        "remove_series" => "chart.series.delete",
        "set_view" => "chart.view.set",
        _ => "chart.op.apply",
    }
}

fn chart_op_target(op: &Map<String, Value>) -> Value {
    match op.get("op").and_then(Value::as_str).unwrap_or_default() {
        "draw" | "update" | "remove" => {
            let mut target = json!({ "kind": "chart.shape" });
            if let Some(id) = op.get("id") {
                target["id"] = id.clone();
            }
            target
        }
        "add_series" | "remove_series" => {
            let mut target = json!({ "kind": "chart.series" });
            if let Some(id) = op.get("id") {
                target["id"] = id.clone();
            }
            target
        }
        "set_view" => json!({ "kind": "chart.view" }),
        _ => json!({ "kind": "chart" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(label: &str) -> JournalStore {
        let dir =
            std::env::temp_dir().join(format!("amaterasu-journal-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        JournalStore::open(&dir.join("journal.db")).unwrap()
    }

    fn envelope(seq: i64, key: &str, payload: Value) -> Value {
        json!({
            "v": 1,
            "doc_id": "doc_test",
            "turn_id": "turn_1",
            "seq": seq,
            "actor": { "kind": "agent", "id": "chart-analyst", "session": "ses_1" },
            "capability": "cap_local",
            "type": "chart.shape.create",
            "target": { "kind": "chart.shape" },
            "payload": payload,
            "rationale": "test",
            "idempotency_key": key,
            "created_at": "2026-10-20T09:41:02Z"
        })
    }

    fn pending(item: BatchItem) -> PendingOp {
        match item {
            BatchItem::Pending(op) => op,
            BatchItem::Replay(other) => panic!("expected pending, got replay {other}"),
            BatchItem::Rejected(other) => panic!("expected pending, got rejection {other}"),
        }
    }

    fn applied(store: &JournalStore, op: &PendingOp, inverse: Value) -> Value {
        store
            .complete(
                "doc_test",
                &op.op_id,
                AckInput {
                    status: "applied".into(),
                    result: Some(json!({ "ok": true })),
                    inverse: Some(inverse),
                    ..AckInput::default()
                },
            )
            .unwrap()
    }

    #[test]
    fn begin_and_complete_assigns_ids_and_a_revision() {
        let store = temp_store("apply");
        let op = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        assert!(op.op_id.starts_with("op_"));
        assert_eq!(op.seq, 1);

        let ack = applied(
            &store,
            &op,
            json!([{ "type": "chart.shape.delete", "target": { "kind": "chart.shape", "id": "s1" }, "payload": {} }]),
        );
        assert_eq!(ack["status"], "applied");
        assert_eq!(ack["revision"], 1);
        assert_eq!(ack["turn_id"], "turn_1");
        assert_eq!(store.meta("doc_test").unwrap().revision, 1);
        assert_eq!(store.audit("doc_test").unwrap().len(), 1);
        assert!(store.verify("doc_test").unwrap().ok);
    }

    #[test]
    fn reapplying_the_same_key_replays_the_original_ack() {
        let store = temp_store("replay");
        let first = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        let ack = applied(&store, &first, json!([]));

        let replay = store
            .begin_single("doc_test", envelope(1, "k1", json!({})))
            .unwrap();
        match replay {
            BatchItem::Replay(value) => {
                assert_eq!(value["op_id"], ack["op_id"]);
                assert_eq!(value["revision"], 1);
            }
            BatchItem::Pending(_) | BatchItem::Rejected(_) => panic!("expected a replay"),
        }
        assert_eq!(store.audit("doc_test").unwrap().len(), 1);
    }

    #[test]
    fn same_key_with_a_different_payload_conflicts() {
        let store = temp_store("conflict");
        let op = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({ "a": 1 })))
                .unwrap(),
        );
        applied(&store, &op, json!([]));
        let error = store
            .begin_single("doc_test", envelope(1, "k1", json!({ "a": 2 })))
            .unwrap_err();
        assert!(matches!(error, JournalError::IdempotencyConflict));
    }

    #[test]
    fn rejections_are_audited_and_can_be_retried() {
        let store = temp_store("reject");
        let op = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        let ack = store
            .complete(
                "doc_test",
                &op.op_id,
                AckInput {
                    status: "rejected".into(),
                    rejected_by: Some("adapter".into()),
                    code: Some("anchor_out_of_range".into()),
                    message: Some("outside the loaded window".into()),
                    retryable: Some(true),
                    ..AckInput::default()
                },
            )
            .unwrap();
        assert_eq!(ack["revision"], 0);
        assert_eq!(ack["code"], "anchor_out_of_range");
        assert_eq!(store.audit("doc_test").unwrap().len(), 1);
        assert!(store.verify("doc_test").unwrap().ok);

        // The same key is retryable after a rejection.
        let retry = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        let ack = applied(&store, &retry, json!([]));
        assert_eq!(ack["revision"], 1);
        assert_eq!(store.audit("doc_test").unwrap().len(), 2);
    }

    #[test]
    fn undo_plan_reverses_the_turn_and_rejects_a_second_undo() {
        let store = temp_store("undo");
        let first = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        applied(
            &store,
            &first,
            json!([{ "type": "chart.shape.delete", "target": { "kind": "chart.shape", "id": "s1" }, "payload": {} }]),
        );
        let second = pending(
            store
                .begin_single("doc_test", envelope(2, "k2", json!({})))
                .unwrap(),
        );
        applied(
            &store,
            &second,
            json!([{ "type": "chart.shape.update", "target": { "kind": "chart.shape", "id": "s1" }, "payload": { "op": {} } }]),
        );

        let actor = json!({ "kind": "human", "id": "user" });
        let plan = store
            .plan_undo("doc_test", "turn_1", actor.clone(), "cap_undo")
            .unwrap();
        assert_eq!(plan.envelopes.len(), 2);
        assert_eq!(plan.envelopes[0]["type"], "chart.shape.update");
        assert_eq!(plan.envelopes[1]["type"], "chart.shape.delete");
        assert_eq!(plan.envelopes[0]["turn_id"], plan.undo_turn_id);
        assert_eq!(plan.envelopes[0]["seq"], 1);

        store
            .mark_undone("doc_test", "turn_1", &plan.undo_turn_id, actor)
            .unwrap();
        let error = store
            .plan_undo(
                "doc_test",
                "turn_1",
                json!({ "kind": "human", "id": "user" }),
                "cap_undo",
            )
            .unwrap_err();
        assert!(matches!(error, JournalError::AlreadyUndone(_)));
    }

    #[test]
    fn complete_by_request_finds_the_journaled_op() {
        let store = temp_store("request");
        let mut value = envelope(1, "k1", json!({}));
        value["request_id"] = json!("req_1");
        let op = pending(store.begin_single("doc_test", value).unwrap());
        let ack = store
            .complete_by_request(
                "req_1",
                AckInput {
                    status: "applied".into(),
                    result: Some(json!({ "ok": true })),
                    inverse: Some(json!([])),
                    ..AckInput::default()
                },
            )
            .unwrap()
            .expect("request should be journaled");
        assert_eq!(ack["op_id"], op.op_id);
        assert!(
            store
                .complete_by_request("missing", AckInput::default())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn verify_detects_tampering_at_the_right_entry() {
        let store = temp_store("tamper");
        for seq in 1..=3 {
            let op = pending(
                store
                    .begin_single("doc_test", envelope(seq, &format!("k{seq}"), json!({})))
                    .unwrap(),
            );
            applied(&store, &op, json!([]));
        }
        assert!(store.verify("doc_test").unwrap().ok);

        {
            let connection = store.connection.lock().unwrap();
            connection
                .execute(
                    "UPDATE doc_audit SET entry = replace(entry, '\"applied\"', '\"rejected\"')
                     WHERE doc_id = 'doc_test' AND seq = 2",
                    [],
                )
                .unwrap();
        }
        let result = store.verify("doc_test").unwrap();
        assert!(!result.ok);
        assert_eq!(result.broken_at, Some(2));
    }

    #[test]
    fn canonical_json_is_key_sorted() {
        let value = json!({ "b": 1, "a": { "d": 4, "c": 3 } });
        assert_eq!(
            canonical_json(&value).unwrap(),
            r#"{"a":{"c":3,"d":4},"b":1}"#
        );
    }

    #[test]
    fn malformed_envelopes_are_refused() {
        let store = temp_store("invalid");
        let mut bad = envelope(1, "k1", json!({}));
        bad["target"] = json!(null);
        let error = store.begin_single("doc_test", bad).unwrap_err();
        assert!(matches!(error, JournalError::InvalidOp(_)));

        let mut bad_type = envelope(1, "k2", json!({}));
        bad_type["type"] = json!("shape.create");
        let error = store.begin_single("doc_test", bad_type).unwrap_err();
        assert!(matches!(error, JournalError::InvalidOp(_)));
    }

    #[test]
    fn set_ops_do_not_bump_the_revision() {
        let store = temp_store("set");
        let mut value = envelope(1, "k1", json!({}));
        value["type"] = json!("chart.view.set");
        let op = pending(store.begin_single("doc_test", value).unwrap());
        let ack = applied(&store, &op, json!([]));
        assert_eq!(ack["revision"], 0);
        assert_eq!(store.meta("doc_test").unwrap().revision, 0);
    }

    #[test]
    fn chart_events_become_auditable_envelopes() {
        let data = json!({
            "requestId": "req_1",
            "chartId": "9c1f0d6e-8a5b-4c3d-9e2f-1a2b3c4d5e6f",
            "op": {
                "op": "draw",
                "kind": "line",
                "points": [{ "time": 100, "price": 10 }],
                "source": { "sessionID": "ses_1", "messageID": "msg_1" }
            }
        });
        let envelope = chart_op_envelope(&data, "chart-analyst").unwrap();
        assert_eq!(envelope["type"], "chart.shape.create");
        assert_eq!(envelope["target"]["kind"], "chart.shape");
        assert_eq!(envelope["turn_id"], "turn_ses_1:msg_1");
        assert_eq!(envelope["request_id"], "req_1");
        assert_eq!(envelope["idempotency_key"], "req_1");
        assert_eq!(envelope["payload"]["op"]["op"], "draw");

        let view = json!({
            "requestId": "req_2",
            "chartId": "doc_1",
            "op": { "op": "set_view", "from": 1, "to": 2 }
        });
        let envelope = chart_op_envelope(&view, "chart-analyst").unwrap();
        assert_eq!(envelope["type"], "chart.view.set");
        assert_eq!(envelope["target"]["kind"], "chart.view");

        assert!(chart_op_envelope(&json!({ "chartId": "doc_1" }), "agent").is_none());
    }

    fn capability_json(
        cap_id: &str,
        actor: &str,
        permissions: &[&str],
        mode: &str,
        op_types: &[&str],
        expires_at: &str,
    ) -> Value {
        json!({
            "v": 1,
            "cap_id": cap_id,
            "iss": "cg-local",
            "sub": { "actor_id": actor },
            "documents": ["*"],
            "op_types": op_types,
            "permissions": permissions,
            "approval": { "mode": mode, "op_types": ["chart.shape.delete"] },
            "issued_at": "2026-01-01T00:00:00Z",
            "expires_at": expires_at
        })
    }

    #[test]
    fn capability_denials_are_journaled_and_retryable() {
        let store = temp_store("capability");
        store
            .mint_capability(capability_json(
                "cap_read",
                "chart-analyst",
                &["read"],
                "auto",
                &["chart.shape.*"],
                "2030-01-01T00:00:00Z",
            ))
            .unwrap();

        let mut denied = envelope(1, "k1", json!({}));
        denied["capability"] = json!("cap_read");
        match store.begin_single("doc_test", denied).unwrap() {
            BatchItem::Rejected(ack) => {
                assert_eq!(ack["status"], "rejected");
                assert_eq!(ack["code"], "capability_denied");
                assert_eq!(ack["revision"], 0);
            }
            other => panic!("expected a capability rejection, got {other:?}"),
        }
        assert_eq!(store.audit("doc_test").unwrap().len(), 1);

        // The rejected key is not cached, so the same key can be retried with a valid scope.
        let op = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        let ack = applied(&store, &op, json!([]));
        assert_eq!(ack["revision"], 1);
        assert_eq!(store.audit("doc_test").unwrap().len(), 2);
    }

    #[test]
    fn expired_capabilities_are_retryable_rejections() {
        let store = temp_store("capability-expired");
        store
            .mint_capability(capability_json(
                "cap_expired",
                "chart-analyst",
                &["apply"],
                "auto",
                &["chart.shape.*"],
                "2020-01-02T00:00:00Z",
            ))
            .unwrap();
        let mut denied = envelope(1, "k1", json!({}));
        denied["capability"] = json!("cap_expired");
        match store.begin_single("doc_test", denied).unwrap() {
            BatchItem::Rejected(ack) => {
                assert_eq!(ack["code"], "capability_expired");
                assert_eq!(ack["retryable"], true);
            }
            other => panic!("expected an expiry rejection, got {other:?}"),
        }
    }

    #[test]
    fn stale_expected_revisions_are_retryable_rejections() {
        let store = temp_store("revision");
        let first = pending(
            store
                .begin_single("doc_test", envelope(1, "k1", json!({})))
                .unwrap(),
        );
        applied(&store, &first, json!([]));

        let mut stale = envelope(2, "k2", json!({}));
        stale["expected_revision"] = json!(0);
        match store.begin_single("doc_test", stale).unwrap() {
            BatchItem::Rejected(ack) => {
                assert_eq!(ack["code"], "revision_conflict");
                assert_eq!(ack["retryable"], true);
                assert_eq!(ack["revision"], 1);
            }
            other => panic!("expected a revision conflict, got {other:?}"),
        }

        let mut retry = envelope(3, "k3", json!({}));
        retry["expected_revision"] = json!(1);
        let op = pending(store.begin_single("doc_test", retry).unwrap());
        let ack = applied(&store, &op, json!([]));
        assert_eq!(ack["revision"], 2);
        assert_eq!(store.audit("doc_test").unwrap().len(), 3);
    }

    #[test]
    fn human_approval_is_journaled_and_one_shot() {
        let store = temp_store("capability-approval");
        store
            .mint_capability(capability_json(
                "cap_guarded",
                "chart-analyst",
                &["read", "apply"],
                "human",
                &["chart.shape.*"],
                "2030-01-01T00:00:00Z",
            ))
            .unwrap();

        let mut delete = envelope(1, "k1", json!({}));
        delete["type"] = json!("chart.shape.delete");
        delete["capability"] = json!("cap_guarded");
        let approval_id = match store.begin_single("doc_test", delete.clone()).unwrap() {
            BatchItem::Rejected(ack) => {
                assert_eq!(ack["code"], "approval_required");
                ack["suggestion"]["approval_id"]
                    .as_str()
                    .expect("approval suggestion")
                    .to_string()
            }
            other => panic!("expected an approval request, got {other:?}"),
        };

        delete["approval"] = json!(approval_id);
        let op = pending(store.begin_single("doc_test", delete.clone()).unwrap());
        let ack = applied(&store, &op, json!([]));
        assert_eq!(ack["revision"], 1);

        // The approval is consumed; a new key with the same id is refused.
        delete["idempotency_key"] = json!("k2");
        match store.begin_single("doc_test", delete).unwrap() {
            BatchItem::Rejected(ack) => assert_eq!(ack["code"], "approval_invalid"),
            other => panic!("expected a rejected reuse, got {other:?}"),
        }
        assert_eq!(store.audit("doc_test").unwrap().len(), 3);
    }
}
