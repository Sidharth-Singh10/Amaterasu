//! Capability claims and the local capability registry.
//!
//! v0 mints capabilities locally and keeps them in memory. The envelope carries only the
//! `cap_id`; the registry owns the claims. A hosted issuer can replace the registry with a
//! signed-token verifier without changing the journal, because the journal only asks whether an
//! envelope is allowed and, if not, for a typed rejection.

use std::{collections::HashMap, fs, io::Write, path::Path, sync::Mutex};

use anyhow::Context;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("unknown capability: {0}")]
    Unknown(String),
    #[error("invalid token format")]
    Format,
    #[error("invalid token signature")]
    Signature,
    #[error("invalid token encoding: {0}")]
    Encoding(#[from] base64::DecodeError),
    #[error("invalid token claims: {0}")]
    Claims(#[from] serde_json::Error),
}

/// Ed25519 issuer for `tn1.<claims>.<signature>` capability tokens. The local key is persisted
/// so tokens survive restarts; hosted deployments would publish the public key to verifiers.
pub struct TokenIssuer {
    signing: SigningKey,
}

impl TokenIssuer {
    pub fn ephemeral() -> Self {
        Self {
            signing: SigningKey::from_bytes(&rand::random::<[u8; 32]>()),
        }
    }

    pub fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let bytes = rand::random::<[u8; 32]>();
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).with_context(|| {
                        format!("creating capability key directory {}", parent.display())
                    })?;
                }
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options
                    .open(path)
                    .with_context(|| format!("creating capability key {}", path.display()))?;
                file.write_all(&bytes)?;
                bytes.to_vec()
            }
            Err(error) => return Err(error.into()),
        };
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("capability key must be exactly 32 bytes"))?;
        Ok(Self {
            signing: SigningKey::from_bytes(&seed),
        })
    }

    pub fn mint(&self, claims: &CapabilityClaims) -> Result<String, TokenError> {
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
        let input = format!("tn1.{encoded}");
        let signature = self.signing.sign(input.as_bytes());
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
    }

    pub fn verify(&self, token: &str) -> Result<CapabilityClaims, TokenError> {
        let mut parts = token.split('.');
        if parts.next() != Some("tn1") {
            return Err(TokenError::Format);
        }
        let payload = parts.next().ok_or(TokenError::Format)?;
        let signature = parts.next().ok_or(TokenError::Format)?;
        if parts.next().is_some() {
            return Err(TokenError::Format);
        }
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature)?)
            .map_err(|_| TokenError::Signature)?;
        let input = format!("tn1.{payload}");
        self.signing
            .verifying_key()
            .verify(input.as_bytes(), &signature)
            .map_err(|_| TokenError::Signature)?;
        let claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload)?)?;
        Ok(claims)
    }

    pub fn public_key_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing.verifying_key().to_bytes())
    }
}

/// How an op is admitted: immediately, or after a human issues a one-shot approval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalPolicy {
    pub mode: String,
    #[serde(default)]
    pub op_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitySubject {
    pub actor_id: String,
    #[serde(default)]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityClaims {
    pub v: u32,
    pub cap_id: String,
    pub iss: String,
    pub sub: CapabilitySubject,
    pub documents: Vec<String>,
    pub op_types: Vec<String>,
    pub permissions: Vec<String>,
    pub approval: ApprovalPolicy,
    pub issued_at: String,
    pub expires_at: String,
}

/// A protocol-level rejection produced before an adapter sees the op.
#[derive(Debug, Clone, Serialize)]
pub struct Rejection {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub rejected_by: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<Value>,
}

impl Rejection {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            rejected_by: "server",
            suggestion: None,
        }
    }
}

#[derive(Debug, Clone)]
struct ApprovalRecord {
    op_id: Option<String>,
    cap_id: String,
    doc_id: String,
    op_type: String,
    idempotency_key: String,
    expires_at: DateTime<Utc>,
    used: bool,
}

/// A pending approval as seen by the API. `op_id` points at the journaled attempt that asked
/// for approval; the approval endpoint reloads that envelope and applies it with the id attached.
#[derive(Debug, Clone)]
pub struct ApprovalTarget {
    pub op_id: Option<String>,
    pub cap_id: String,
    pub doc_id: String,
    pub op_type: String,
    pub idempotency_key: String,
    pub expires_at: DateTime<Utc>,
    pub used: bool,
}

pub struct CapabilityRegistry {
    claims: Mutex<HashMap<String, CapabilityClaims>>,
    approvals: Mutex<HashMap<String, ApprovalRecord>>,
    issuer: TokenIssuer,
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::local()
    }
}

impl CapabilityRegistry {
    /// Seeds the capabilities the local app needs: the agent bridge, a human undo capability,
    /// and a human local capability. Destructive agent ops require a one-shot human approval;
    /// the Journal panel surfaces the pending attempt and applies it on approval.
    pub fn local() -> Self {
        Self::with_issuer(TokenIssuer::ephemeral())
    }

    pub fn with_issuer(issuer: TokenIssuer) -> Self {
        let now = Utc::now();
        let registry = Self {
            claims: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            issuer,
        };
        registry.mint(CapabilityClaims {
            v: 1,
            cap_id: "cap_local".into(),
            iss: "tenon-local".into(),
            sub: CapabilitySubject {
                actor_id: "chart-analyst".into(),
                session: None,
            },
            documents: vec!["*".into()],
            op_types: vec!["chart.*.*".into(), "chart.op.apply".into()],
            permissions: vec![
                "read".into(),
                "apply".into(),
                "undo".into(),
                "export".into(),
            ],
            approval: ApprovalPolicy {
                mode: "human".into(),
                op_types: vec![
                    "chart.shape.delete".into(),
                    "chart.shape.clear".into(),
                    "chart.series.delete".into(),
                ],
            },
            issued_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            expires_at: (now + Duration::days(3650)).to_rfc3339_opts(SecondsFormat::Secs, true),
        });
        registry.mint(CapabilityClaims {
            v: 1,
            cap_id: "cap_human".into(),
            iss: "tenon-local".into(),
            sub: CapabilitySubject {
                actor_id: "local".into(),
                session: None,
            },
            documents: vec!["*".into()],
            op_types: vec![
                "chart.*.*".into(),
                "chart.*".into(),
                "graph.*.*".into(),
                "graph.merge".into(),
            ],
            permissions: vec![
                "read".into(),
                "apply".into(),
                "undo".into(),
                "export".into(),
            ],
            approval: ApprovalPolicy {
                mode: "auto".into(),
                op_types: vec![],
            },
            issued_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            expires_at: (now + Duration::days(3650)).to_rfc3339_opts(SecondsFormat::Secs, true),
        });
        registry.mint(CapabilityClaims {
            v: 1,
            cap_id: "cap_undo".into(),
            iss: "tenon-local".into(),
            sub: CapabilitySubject {
                actor_id: "local".into(),
                session: None,
            },
            documents: vec!["*".into()],
            op_types: vec!["chart.*.*".into(), "graph.*.*".into(), "graph.merge".into()],
            permissions: vec!["read".into(), "apply".into(), "undo".into()],
            approval: ApprovalPolicy {
                mode: "auto".into(),
                op_types: vec![],
            },
            issued_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            expires_at: (now + Duration::days(3650)).to_rfc3339_opts(SecondsFormat::Secs, true),
        });
        registry.mint(CapabilityClaims {
            v: 1,
            cap_id: "cap_graph".into(),
            iss: "tenon-local".into(),
            sub: CapabilitySubject {
                actor_id: "weave-agent".into(),
                session: None,
            },
            documents: vec!["*".into()],
            op_types: vec!["graph.*.*".into(), "graph.merge".into()],
            permissions: vec![
                "read".into(),
                "apply".into(),
                "undo".into(),
                "export".into(),
            ],
            approval: ApprovalPolicy {
                mode: "human".into(),
                op_types: vec![
                    "graph.node.delete".into(),
                    "graph.edge.delete".into(),
                    "graph.merge".into(),
                ],
            },
            issued_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            expires_at: (now + Duration::days(3650)).to_rfc3339_opts(SecondsFormat::Secs, true),
        });
        registry
    }

    pub fn mint(&self, claims: CapabilityClaims) {
        self.claims
            .lock()
            .expect("capability lock poisoned")
            .insert(claims.cap_id.clone(), claims);
    }

    pub fn mint_json(&self, value: Value) -> Result<(), serde_json::Error> {
        let claims: CapabilityClaims = serde_json::from_value(value)?;
        self.mint(claims);
        Ok(())
    }

    /// Rebinds a local capability to the configured agent name. The seeded `cap_local` assumes
    /// `chart-analyst`; an install with `OPENCODE_AGENT` set needs the token to follow.
    pub fn bind_actor(&self, cap_id: &str, actor_id: &str) {
        if let Some(claims) = self
            .claims
            .lock()
            .expect("capability lock poisoned")
            .get_mut(cap_id)
        {
            claims.sub.actor_id = actor_id.to_string();
        }
    }

    pub fn token_for(&self, cap_id: &str) -> Result<String, TokenError> {
        let claims = self
            .claims
            .lock()
            .expect("capability lock poisoned")
            .get(cap_id)
            .cloned()
            .ok_or_else(|| TokenError::Unknown(cap_id.to_string()))?;
        self.issuer.mint(&claims)
    }

    pub fn token_for_claims(&self, claims: &CapabilityClaims) -> Result<String, TokenError> {
        self.issuer.mint(claims)
    }

    pub fn verify_token(&self, token: &str) -> Result<CapabilityClaims, TokenError> {
        self.issuer.verify(token)
    }

    pub fn public_key(&self) -> String {
        self.issuer.public_key_base64()
    }

    /// Returns `None` when the envelope is in scope, otherwise a typed rejection. Approval
    /// suggestions are minted here so the rejected attempt can point at a one-shot id.
    pub fn verify(
        &self,
        envelope: &Value,
        now: DateTime<Utc>,
        op_id: Option<&str>,
    ) -> Option<Rejection> {
        let Some(cap_id) = field(envelope, "capability") else {
            return Some(Rejection::new(
                "capability_denied",
                "missing capability",
                false,
            ));
        };
        let claims = {
            let claims = self.claims.lock().expect("capability lock poisoned");
            claims.get(cap_id).cloned()
        };
        let Some(claims) = claims else {
            return Some(Rejection::new(
                "capability_denied",
                "unknown capability",
                false,
            ));
        };

        let expires = match DateTime::parse_from_rfc3339(&claims.expires_at) {
            Ok(expires) => expires.with_timezone(&Utc),
            Err(_) => {
                return Some(Rejection::new(
                    "capability_denied",
                    "capability has an invalid expiry",
                    false,
                ));
            }
        };
        if expires <= now {
            return Some(Rejection::new(
                "capability_expired",
                "capability expired",
                true,
            ));
        }

        let actor = envelope.get("actor");
        let actor_id = actor
            .and_then(|actor| actor.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if claims.sub.actor_id != actor_id {
            return Some(Rejection::new(
                "capability_denied",
                "capability is bound to another actor",
                false,
            ));
        }
        let session = actor
            .and_then(|actor| actor.get("session"))
            .and_then(Value::as_str);
        if let (Some(expected), Some(actual)) = (claims.sub.session.as_deref(), session)
            && expected != actual
        {
            return Some(Rejection::new(
                "capability_denied",
                "capability is bound to another session",
                false,
            ));
        }

        let doc_id = field(envelope, "doc_id").unwrap_or_default();
        if !claims
            .documents
            .iter()
            .any(|pattern| matches_pattern(pattern, doc_id))
        {
            return Some(Rejection::new(
                "capability_denied",
                "document is outside the capability scope",
                false,
            ));
        }

        let op_type = field(envelope, "type").unwrap_or_default();
        if !claims
            .op_types
            .iter()
            .any(|pattern| matches_pattern(pattern, op_type))
        {
            return Some(Rejection::new(
                "capability_denied",
                "op type is outside the capability scope",
                false,
            ));
        }

        if !claims
            .permissions
            .iter()
            .any(|permission| permission == "apply")
        {
            if claims
                .permissions
                .iter()
                .any(|permission| permission == "propose")
            {
                let approval_id = self.issue_approval(&claims, envelope, now, op_id);
                return Some(Rejection {
                    code: "approval_required",
                    message: "this capability may propose but not apply".into(),
                    retryable: true,
                    rejected_by: "server",
                    suggestion: Some(json!({ "approval_id": approval_id })),
                });
            }
            return Some(Rejection::new(
                "capability_denied",
                "capability has no apply permission",
                false,
            ));
        }

        if claims.approval.mode == "human"
            && claims
                .approval
                .op_types
                .iter()
                .any(|pattern| matches_pattern(pattern, op_type))
        {
            let key = field(envelope, "idempotency_key").unwrap_or_default();
            let approval_id = field(envelope, "approval");
            match approval_id {
                None => {
                    let approval_id = self.issue_approval(&claims, envelope, now, op_id);
                    return Some(Rejection {
                        code: "approval_required",
                        message: "this op needs human approval".into(),
                        retryable: true,
                        rejected_by: "server",
                        suggestion: Some(json!({ "approval_id": approval_id })),
                    });
                }
                Some(approval_id) => {
                    if !self.consume_approval(
                        approval_id,
                        &claims.cap_id,
                        doc_id,
                        op_type,
                        key,
                        now,
                    ) {
                        return Some(Rejection::new(
                            "approval_invalid",
                            "approval does not match this op",
                            false,
                        ));
                    }
                }
            }
        }

        None
    }

    fn issue_approval(
        &self,
        claims: &CapabilityClaims,
        envelope: &Value,
        now: DateTime<Utc>,
        op_id: Option<&str>,
    ) -> String {
        let doc_id = field(envelope, "doc_id").unwrap_or_default();
        let op_type = field(envelope, "type").unwrap_or_default();
        let key = field(envelope, "idempotency_key").unwrap_or_default();
        let mut approvals = self.approvals.lock().expect("approval lock poisoned");

        if let Some((approval_id, record)) = approvals.iter_mut().find(|(_, record)| {
            !record.used
                && record.expires_at > now
                && record.cap_id == claims.cap_id
                && record.doc_id == doc_id
                && record.op_type == op_type
                && record.idempotency_key == key
        }) {
            if record.op_id.is_none() {
                record.op_id = op_id.map(str::to_string);
            }
            return approval_id.clone();
        }

        let approval_id = format!("appr_{:032x}", rand::random::<u128>());
        approvals.insert(
            approval_id.clone(),
            ApprovalRecord {
                op_id: op_id.map(str::to_string),
                cap_id: claims.cap_id.clone(),
                doc_id: doc_id.to_string(),
                op_type: op_type.to_string(),
                idempotency_key: key.to_string(),
                expires_at: now + Duration::minutes(5),
                used: false,
            },
        );
        approval_id
    }

    pub fn approval(&self, approval_id: &str) -> Option<ApprovalTarget> {
        let approvals = self.approvals.lock().expect("approval lock poisoned");
        approvals.get(approval_id).map(|record| ApprovalTarget {
            op_id: record.op_id.clone(),
            cap_id: record.cap_id.clone(),
            doc_id: record.doc_id.clone(),
            op_type: record.op_type.clone(),
            idempotency_key: record.idempotency_key.clone(),
            expires_at: record.expires_at,
            used: record.used,
        })
    }

    fn consume_approval(
        &self,
        approval_id: &str,
        cap_id: &str,
        doc_id: &str,
        op_type: &str,
        key: &str,
        now: DateTime<Utc>,
    ) -> bool {
        let mut approvals = self.approvals.lock().expect("approval lock poisoned");
        let Some(record) = approvals.get_mut(approval_id) else {
            return false;
        };
        if record.used
            || record.expires_at <= now
            || record.cap_id != cap_id
            || record.doc_id != doc_id
            || record.op_type != op_type
            || record.idempotency_key != key
        {
            return false;
        }
        record.used = true;
        true
    }
}

fn field<'a>(envelope: &'a Value, key: &str) -> Option<&'a str> {
    envelope.get(key).and_then(Value::as_str)
}

/// Mirrors the TypeScript `matchesPattern`: same number of dot segments, `*` matches a whole
/// segment, and a segment ending in `*` matches the prefix.
pub fn matches_pattern(pattern: &str, value: &str) -> bool {
    let pattern = pattern.split('.').collect::<Vec<_>>();
    let value = value.split('.').collect::<Vec<_>>();
    pattern.len() == value.len()
        && pattern
            .iter()
            .zip(value.iter())
            .all(|(pattern, value)| segment_matches(pattern, value))
}

fn segment_matches(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return value.starts_with(prefix);
    }
    pattern == value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(cap_id: &str, actor: &str, permissions: &[&str], mode: &str) -> CapabilityClaims {
        let now = Utc::now();
        CapabilityClaims {
            v: 1,
            cap_id: cap_id.into(),
            iss: "tenon-local".into(),
            sub: CapabilitySubject {
                actor_id: actor.into(),
                session: None,
            },
            documents: vec!["doc_*".into()],
            op_types: vec!["chart.shape.*".into()],
            permissions: permissions.iter().map(|value| (*value).into()).collect(),
            approval: ApprovalPolicy {
                mode: mode.into(),
                op_types: vec!["chart.shape.delete".into()],
            },
            issued_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            expires_at: (now + Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        }
    }

    fn envelope(cap_id: &str, actor: &str, op_type: &str) -> Value {
        json!({
            "v": 1,
            "doc_id": "doc_1",
            "turn_id": "turn_1",
            "seq": 1,
            "actor": { "kind": "agent", "id": actor },
            "capability": cap_id,
            "type": op_type,
            "target": { "kind": "chart.shape" },
            "payload": {},
            "idempotency_key": "key_1",
            "created_at": "2026-10-20T09:41:02Z"
        })
    }

    #[test]
    fn wildcard_matching_matches_the_typescript_rules() {
        assert!(matches_pattern("chart.shape.*", "chart.shape.create"));
        assert!(!matches_pattern("chart.shape.*", "chart.series.create"));
        assert!(matches_pattern("doc_*", "doc_1"));
        assert!(matches_pattern("chart.*.create", "chart.shape.create"));
        assert!(matches_pattern("*", "doc_1"));
        assert!(!matches_pattern("chart.*", "chart.shape.create"));
    }

    #[test]
    fn read_only_capabilities_are_denied() {
        let registry = CapabilityRegistry::default();
        registry.mint(claims("cap_read", "chart-analyst", &["read"], "auto"));
        let rejection = registry
            .verify(
                &envelope("cap_read", "chart-analyst", "chart.shape.create"),
                Utc::now(),
                None,
            )
            .unwrap();
        assert_eq!(rejection.code, "capability_denied");
        assert!(!rejection.retryable);
    }

    #[test]
    fn expired_capabilities_are_retryable() {
        let registry = CapabilityRegistry::default();
        let mut expired = claims("cap_expired", "chart-analyst", &["apply"], "auto");
        expired.expires_at = "2020-01-02T00:00:00Z".into();
        registry.mint(expired);
        let rejection = registry
            .verify(
                &envelope("cap_expired", "chart-analyst", "chart.shape.create"),
                Utc::now(),
                None,
            )
            .unwrap();
        assert_eq!(rejection.code, "capability_expired");
        assert!(rejection.retryable);
    }

    #[test]
    fn actor_and_scope_mismatches_are_denied() {
        let registry = CapabilityRegistry::default();
        registry.mint(claims("cap_write", "chart-analyst", &["apply"], "auto"));
        let wrong_actor = registry
            .verify(
                &envelope("cap_write", "intruder", "chart.shape.create"),
                Utc::now(),
                None,
            )
            .unwrap();
        assert_eq!(wrong_actor.code, "capability_denied");
        let wrong_type = registry
            .verify(
                &envelope("cap_write", "chart-analyst", "chart.view.set"),
                Utc::now(),
                None,
            )
            .unwrap();
        assert_eq!(wrong_type.code, "capability_denied");
        let mut wrong_doc = envelope("cap_write", "chart-analyst", "chart.shape.create");
        wrong_doc["doc_id"] = json!("other_1");
        let rejection = registry.verify(&wrong_doc, Utc::now(), None).unwrap();
        assert_eq!(rejection.code, "capability_denied");
    }

    #[test]
    fn human_approval_is_one_shot() {
        let registry = CapabilityRegistry::default();
        registry.mint(claims("cap_guarded", "chart-analyst", &["apply"], "human"));
        let mut delete = envelope("cap_guarded", "chart-analyst", "chart.shape.delete");
        let rejection = registry.verify(&delete, Utc::now(), None).unwrap();
        assert_eq!(rejection.code, "approval_required");
        assert!(rejection.retryable);
        let approval_id = rejection.suggestion.unwrap()["approval_id"]
            .as_str()
            .unwrap()
            .to_string();

        delete["approval"] = json!(approval_id);
        assert!(registry.verify(&delete, Utc::now(), None).is_none());
        let reused = registry.verify(&delete, Utc::now(), None).unwrap();
        assert_eq!(reused.code, "approval_invalid");
    }

    #[test]
    fn tokens_round_trip_and_reject_tampering() {
        let registry = CapabilityRegistry::default();
        let token = registry.token_for("cap_local").unwrap();
        assert!(token.starts_with("tn1."));
        let claims = registry.verify_token(&token).unwrap();
        assert_eq!(claims.cap_id, "cap_local");
        assert!(!registry.public_key().is_empty());

        let parts = token.split('.').collect::<Vec<_>>();
        let mut payload = parts[1].to_string();
        let first = payload.remove(0);
        payload.insert(0, if first == 'A' { 'B' } else { 'A' });
        let tampered = format!("tn1.{payload}.{}", parts[2]);
        assert!(registry.verify_token(&tampered).is_err());
        assert!(registry.token_for("cap_missing").is_err());
    }

    #[test]
    fn issuer_persists_the_key_and_reproduces_tokens() {
        let dir = std::env::temp_dir().join(format!("amaterasu-issuer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("capability.key");
        let claims = claims("cap_local", "chart-analyst", &["apply"], "auto");
        let issuer = TokenIssuer::load_or_create(&path).unwrap();
        let first = issuer.mint(&claims).unwrap();
        let reloaded = TokenIssuer::load_or_create(&path).unwrap();
        assert_eq!(first, reloaded.mint(&claims).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn unknown_capabilities_are_denied() {
        let registry = CapabilityRegistry::default();
        let rejection = registry
            .verify(
                &envelope("cap_missing", "chart-analyst", "chart.shape.create"),
                Utc::now(),
                None,
            )
            .unwrap();
        assert_eq!(rejection.code, "capability_denied");
    }
}
