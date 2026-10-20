//! Runs the language-agnostic conformance fixtures against the Rust journal with a small
//! in-test domain adapter. This is the second adapter for the shared suite: it exercises the
//! same cases as `packages/canvas-conformance/src/memory-target.ts`, but through the server's
//! real journal, capabilities, revisions, undo, and audit chain.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use amaterasu_server::journal::{AckInput, BatchItem, JournalError, JournalStore};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const CREATED_AT: &str = "2026-10-20T09:41:02Z";
const EPSILON: f64 = 1e-9;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy)]
struct Viewport {
    scale_x: f64,
    scale_y: f64,
    pan_x: f64,
    pan_y: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            scale_x: 1.0,
            scale_y: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
        }
    }
}

#[derive(Default)]
struct Domain {
    objects: BTreeMap<String, Point>,
    viewport: Viewport,
}

struct Harness {
    journal: JournalStore,
    db_path: PathBuf,
    doc_id: String,
    domain: Domain,
    doc_counter: u64,
    op_counter: u64,
    failures: Vec<String>,
}

impl Harness {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "amaterasu-conformance-{}-{label}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("journal.db");
        Self {
            journal: JournalStore::open(&db_path).unwrap(),
            db_path,
            doc_id: String::new(),
            domain: Domain::default(),
            doc_counter: 0,
            op_counter: 0,
            failures: Vec::new(),
        }
    }

    fn check(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        if !ok {
            self.failures.push(format!("{name}: {}", detail.into()));
        }
    }

    fn reset(&mut self, fixture: &Value) {
        self.doc_counter += 1;
        self.doc_id = format!("doc_conf_{}_{}", std::process::id(), self.doc_counter);
        self.domain = Domain::default();
        self.op_counter = 0;

        if let Some(objects) = fixture
            .get("setup")
            .and_then(|setup| setup.get("objects"))
            .and_then(Value::as_array)
        {
            for object in objects {
                let id = object["id"].as_str().unwrap().to_string();
                let point = point_from(&object["data"]).expect("seed point");
                self.domain.objects.insert(id, point);
            }
        }
        if let Some(capabilities) = fixture
            .get("setup")
            .and_then(|setup| setup.get("capabilities"))
            .and_then(Value::as_array)
        {
            for claims in capabilities {
                self.journal.mint_capability(claims.clone()).unwrap();
            }
        }
    }

    fn run(&mut self, fixture: &Value) {
        self.reset(fixture);
        let steps = fixture["steps"].as_array().expect("steps");
        let fixture_actor = fixture
            .get("actor")
            .cloned()
            .unwrap_or_else(|| json!({ "kind": "agent", "id": "conformance" }));
        let fixture_capability = fixture["capability"].as_str().unwrap_or("cap_write");
        let undo_capability = fixture["undoCapability"]
            .as_str()
            .unwrap_or(fixture_capability);
        let mut last_turn: Option<String> = None;
        let mut last_ack: Option<Value> = None;

        for (index, step) in steps.iter().enumerate() {
            let label = format!(
                "step {} ({})",
                index + 1,
                step["kind"].as_str().unwrap_or("?")
            );
            match step["kind"].as_str().unwrap_or_default() {
                "apply" => {
                    let op = &step["op"];
                    let turn = op
                        .get("turn")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("turn_{}", index + 1));
                    let seq = op.get("seq").and_then(Value::as_i64).unwrap_or(1);
                    let mut envelope = json!({
                        "v": 1,
                        "doc_id": self.doc_id,
                        "turn_id": turn,
                        "seq": seq,
                        "actor": op.get("actor").cloned().unwrap_or(fixture_actor.clone()),
                        "capability": op
                            .get("capability")
                            .and_then(Value::as_str)
                            .unwrap_or(fixture_capability),
                        "type": op["type"].clone(),
                        "target": op.get("target").cloned().unwrap_or_else(|| json!({ "kind": "obj" })),
                        "payload": op.get("payload").cloned().unwrap_or_else(|| json!({})),
                        "idempotency_key": op
                            .get("idempotency_key")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("{turn}:{seq}")),
                        "created_at": CREATED_AT,
                    });
                    if let Some(rationale) = op.get("rationale") {
                        envelope["rationale"] = rationale.clone();
                    }
                    if let Some(approval) = op.get("approval") {
                        envelope["approval"] = approval.clone();
                    }
                    let ack = self.apply(&envelope);
                    self.compare(&label, &ack, &step["expect"]);
                    if ack["status"] == "applied" {
                        last_turn = ack["turn_id"].as_str().map(str::to_string);
                    }
                    last_ack = Some(ack);
                }
                "apply_raw" => {
                    let mut envelope = step["envelope"].clone();
                    envelope["doc_id"] = json!(self.doc_id);
                    let ack = self.apply(&envelope);
                    self.compare(&label, &ack, &step["expect"]);
                    if ack["status"] == "applied" {
                        last_turn = ack["turn_id"].as_str().map(str::to_string);
                    }
                    last_ack = Some(ack);
                }
                "snapshot" => {
                    let expect = &step["expect"];
                    let revision = self.journal.meta(&self.doc_id).unwrap().revision;
                    if let Some(expected) = expect.get("revision").and_then(Value::as_i64) {
                        self.check(
                            &format!("{label}: revision"),
                            revision == expected,
                            format!("expected {expected}, got {revision}"),
                        );
                    }
                    if let Some(expected) = expect.get("objectCount").and_then(Value::as_u64) {
                        self.check(
                            &format!("{label}: object count"),
                            self.domain.objects.len() as u64 == expected,
                            format!("expected {expected}, got {}", self.domain.objects.len()),
                        );
                    }
                    if let Some(ids) = expect.get("objectIds").and_then(Value::as_array) {
                        let actual = self.domain.objects.keys().cloned().collect::<Vec<_>>();
                        let expected = ids
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>();
                        self.check(
                            &format!("{label}: object ids"),
                            actual == expected,
                            format!("expected {expected:?}, got {actual:?}"),
                        );
                    }
                    if let Some(data) = expect.get("data").and_then(Value::as_object) {
                        for (id, expected) in data {
                            let expected = point_from(expected).expect("expected point");
                            let actual = self.domain.objects.get(id).copied();
                            self.check(
                                &format!("{label}: data {id}"),
                                actual.is_some_and(|point| same_point(point, expected)),
                                format!("expected {expected:?}, got {actual:?}"),
                            );
                        }
                    }
                }
                "undo" => {
                    let reference = step["turn"].as_str().unwrap_or_default();
                    let turn = match reference {
                        "$last" => last_turn.clone(),
                        "$lastAckTurn" => last_ack
                            .as_ref()
                            .and_then(|ack| ack["turn_id"].as_str().map(str::to_string)),
                        other => Some(other.to_string()),
                    }
                    .expect("undo turn reference");
                    let actor = json!({ "kind": "human", "id": "conformance-user" });
                    let (new_turn, acks) = self.undo(&turn, &actor, undo_capability);
                    let ack = acks.first().cloned().unwrap_or(Value::Null);
                    self.compare(&label, &ack, &step["expect"]);
                    if ack["status"] == "applied" {
                        last_turn = new_turn;
                    }
                }
                "verify_audit" => {
                    let result = self.journal.verify(&self.doc_id).unwrap();
                    let expect = &step["expect"];
                    if let Some(expected) = expect.get("ok").and_then(Value::as_bool) {
                        self.check(
                            &format!("{label}: ok"),
                            result.ok == expected,
                            format!("expected {expected}, got {}", result.ok),
                        );
                    }
                    if let Some(expected) = expect.get("brokenAt").and_then(Value::as_i64) {
                        let actual = result.broken_at.map(|seq| seq - 1);
                        self.check(
                            &format!("{label}: brokenAt"),
                            actual == Some(expected),
                            format!("expected {expected}, got {actual:?}"),
                        );
                    }
                    if let Some(expected) = expect.get("length").and_then(Value::as_u64) {
                        let actual = self.journal.audit(&self.doc_id).unwrap().len() as u64;
                        self.check(
                            &format!("{label}: length"),
                            actual == expected,
                            format!("expected {expected}, got {actual}"),
                        );
                    }
                }
                "tamper_audit" => {
                    let index = step["index"].as_u64().expect("tamper index") as i64;
                    self.tamper(index + 1, &step["patch"]);
                    self.check(&format!("{label}: applied"), true, "");
                }
                "project" => {
                    let point = point_from(&step["point"]).unwrap();
                    let viewport = viewport_from(&step["viewport"]).unwrap();
                    let actual = Point {
                        x: point.x * viewport.scale_x + viewport.pan_x,
                        y: point.y * viewport.scale_y + viewport.pan_y,
                    };
                    let expected = point_from(&step["expect"]).unwrap();
                    self.check(
                        &format!("{label}: coordinates"),
                        same_point(actual, expected),
                        format!("expected {expected:?}, got {actual:?}"),
                    );
                }
                "unproject" => {
                    let point = point_from(&step["screen"]).unwrap();
                    let viewport = viewport_from(&step["viewport"]).unwrap();
                    let actual = Point {
                        x: (point.x - viewport.pan_x) / viewport.scale_x,
                        y: (point.y - viewport.pan_y) / viewport.scale_y,
                    };
                    let expected = point_from(&step["expect"]).unwrap();
                    self.check(
                        &format!("{label}: coordinates"),
                        same_point(actual, expected),
                        format!("expected {expected:?}, got {actual:?}"),
                    );
                }
                other => self.failures.push(format!("{label}: unknown step {other}")),
            }
        }
    }

    fn compare(&mut self, label: &str, ack: &Value, expect: &Value) {
        if let Some(expected) = expect.get("status").and_then(Value::as_str) {
            self.check(
                &format!("{label}: status"),
                ack["status"] == expected,
                format!("expected {expected}, got {}", ack["status"]),
            );
        }
        if let Some(expected) = expect.get("code").and_then(Value::as_str) {
            self.check(
                &format!("{label}: code"),
                ack["code"] == expected,
                format!("expected {expected}, got {}", ack["code"]),
            );
        }
        if let Some(expected) = expect.get("revision").and_then(Value::as_i64) {
            self.check(
                &format!("{label}: revision"),
                ack["revision"] == expected,
                format!("expected {expected}, got {}", ack["revision"]),
            );
        }
        if let Some(expected) = expect.get("replayed").and_then(Value::as_bool) {
            self.check(
                &format!("{label}: replayed"),
                ack["replayed"] == expected,
                format!("expected {expected}, got {}", ack["replayed"]),
            );
        }
        if let Some(expected) = expect.get("objectId").and_then(Value::as_str) {
            self.check(
                &format!("{label}: object id"),
                ack["result"]["object_id"] == expected,
                format!("expected {expected}, got {}", ack["result"]["object_id"]),
            );
        }
    }

    fn apply(&mut self, envelope: &Value) -> Value {
        let mut envelope = envelope.clone();
        envelope["doc_id"] = json!(self.doc_id);
        match self.journal.begin_single(&self.doc_id, envelope.clone()) {
            Ok(BatchItem::Replay(mut ack)) => {
                ack["replayed"] = json!(true);
                ack
            }
            Ok(BatchItem::Rejected(ack)) => ack,
            Ok(BatchItem::Pending(op)) => {
                let input = match self.domain_apply(&envelope) {
                    Ok((result, inverse)) => AckInput {
                        status: "applied".into(),
                        result: Some(result),
                        inverse: Some(Value::Array(inverse)),
                        ..AckInput::default()
                    },
                    Err((code, message)) => AckInput {
                        status: "rejected".into(),
                        rejected_by: Some("adapter".into()),
                        code: Some(code),
                        message: Some(message),
                        retryable: Some(false),
                        ..AckInput::default()
                    },
                };
                self.journal
                    .complete(&self.doc_id, &op.op_id, input)
                    .unwrap()
            }
            Err(JournalError::InvalidOp(message)) => {
                self.op_counter += 1;
                let revision = self.journal.meta(&self.doc_id).unwrap().revision;
                json!({
                    "v": 1,
                    "op_id": format!("op_invalid_{}", self.op_counter),
                    "turn_id": envelope.get("turn_id").cloned().unwrap_or(Value::Null),
                    "seq": envelope.get("seq").cloned().unwrap_or(Value::Null),
                    "status": "rejected",
                    "revision": revision,
                    "rejected_by": "server",
                    "code": "invalid_op",
                    "message": message,
                    "retryable": false,
                })
            }
            Err(error) => panic!("journal intake failed: {error}"),
        }
    }

    fn domain_apply(&mut self, envelope: &Value) -> Result<(Value, Vec<Value>), (String, String)> {
        let op_type = envelope["type"].as_str().unwrap_or_default();
        let target = &envelope["target"];
        let payload = &envelope["payload"];
        match op_type {
            "obj.point.create" => {
                let id = payload["id"]
                    .as_str()
                    .ok_or_else(|| ("invalid_op".into(), "create requires payload.id".into()))?;
                let point = point_from(&payload["data"])
                    .ok_or_else(|| ("invalid_op".into(), "create requires payload.data".into()))?;
                if self.domain.objects.contains_key(id) {
                    return Err(("duplicate_object_id".into(), format!("point {id} exists")));
                }
                self.domain.objects.insert(id.to_string(), point);
                Ok((
                    json!({ "ok": true, "object_id": id }),
                    vec![json!({
                        "type": "obj.point.delete",
                        "target": { "kind": "point", "id": id },
                        "payload": {},
                    })],
                ))
            }
            "obj.point.update" => {
                let id = target["id"]
                    .as_str()
                    .or_else(|| payload["id"].as_str())
                    .ok_or_else(|| ("invalid_op".into(), "update requires target.id".into()))?;
                let point = point_from(&payload["data"])
                    .ok_or_else(|| ("invalid_op".into(), "update requires payload.data".into()))?;
                let previous = self
                    .domain
                    .objects
                    .get(id)
                    .copied()
                    .ok_or_else(|| ("unknown_target".into(), format!("no point {id}")))?;
                self.domain.objects.insert(id.to_string(), point);
                Ok((
                    json!({ "ok": true, "object_id": id }),
                    vec![json!({
                        "type": "obj.point.update",
                        "target": { "kind": "point", "id": id },
                        "payload": { "data": { "x": previous.x, "y": previous.y } },
                    })],
                ))
            }
            "obj.point.delete" => {
                let id = target["id"]
                    .as_str()
                    .ok_or_else(|| ("invalid_op".into(), "delete requires target.id".into()))?;
                let previous = self
                    .domain
                    .objects
                    .remove(id)
                    .ok_or_else(|| ("unknown_target".into(), format!("no point {id}")))?;
                Ok((
                    json!({ "ok": true, "object_id": id }),
                    vec![json!({
                        "type": "obj.point.create",
                        "target": { "kind": "point", "id": id },
                        "payload": { "id": id, "data": { "x": previous.x, "y": previous.y } },
                    })],
                ))
            }
            "obj.viewport.set" => {
                let next = viewport_from(&payload["viewport"])
                    .ok_or_else(|| ("invalid_op".into(), "set requires payload.viewport".into()))?;
                let previous = self.domain.viewport;
                self.domain.viewport = next;
                Ok((
                    json!({ "ok": true }),
                    vec![json!({
                        "type": "obj.viewport.set",
                        "target": { "kind": "view" },
                        "payload": { "viewport": {
                            "scaleX": previous.scale_x,
                            "scaleY": previous.scale_y,
                            "panX": previous.pan_x,
                            "panY": previous.pan_y,
                        } },
                    })],
                ))
            }
            other => Err(("unknown_op_type".into(), format!("no handler for {other}"))),
        }
    }

    fn undo(
        &mut self,
        turn: &str,
        actor: &Value,
        capability: &str,
    ) -> (Option<String>, Vec<Value>) {
        match self
            .journal
            .plan_undo(&self.doc_id, turn, actor.clone(), capability)
        {
            Ok(plan) => {
                let mut acks = Vec::new();
                for envelope in &plan.envelopes {
                    acks.push(self.apply(envelope));
                }
                let applied = acks
                    .iter()
                    .all(|ack| ack["status"].as_str() == Some("applied"));
                if applied {
                    self.journal
                        .mark_undone(&self.doc_id, turn, &plan.undo_turn_id, actor.clone())
                        .unwrap();
                }
                (Some(plan.undo_turn_id), acks)
            }
            Err(JournalError::UnknownTurn(unknown)) => (
                None,
                vec![self.undo_rejection(
                    turn,
                    actor,
                    capability,
                    "unknown_target",
                    format!("no turn {unknown}"),
                )],
            ),
            Err(JournalError::AlreadyUndone(message)) => (
                None,
                vec![self.undo_rejection(turn, actor, capability, "already_undone", message)],
            ),
            Err(error) => panic!("undo failed: {error}"),
        }
    }

    fn undo_rejection(
        &mut self,
        turn: &str,
        actor: &Value,
        capability: &str,
        code: &str,
        message: String,
    ) -> Value {
        self.op_counter += 1;
        let envelope = json!({
            "v": 1,
            "doc_id": self.doc_id,
            "turn_id": format!("turn_undo_reject_{}", self.op_counter),
            "seq": 1,
            "actor": actor,
            "capability": capability,
            "type": "obj.point.undo",
            "target": { "kind": "turn", "id": turn },
            "payload": {},
            "idempotency_key": format!("undo:{}:{}", turn, self.op_counter),
            "created_at": CREATED_AT,
        });
        match self.journal.begin_single(&self.doc_id, envelope).unwrap() {
            BatchItem::Pending(op) => self
                .journal
                .complete(
                    &self.doc_id,
                    &op.op_id,
                    AckInput {
                        status: "rejected".into(),
                        rejected_by: Some("server".into()),
                        code: Some(code.into()),
                        message: Some(message),
                        retryable: Some(false),
                        ..AckInput::default()
                    },
                )
                .unwrap(),
            BatchItem::Rejected(ack) | BatchItem::Replay(ack) => ack,
        }
    }

    fn tamper(&mut self, seq: i64, patch: &Value) {
        let connection = Connection::open(&self.db_path).unwrap();
        let entry: String = connection
            .query_row(
                "SELECT entry FROM doc_audit WHERE doc_id = ?1 AND seq = ?2",
                params![self.doc_id, seq],
                |row| row.get(0),
            )
            .unwrap();
        let mut entry: Value = serde_json::from_str(&entry).unwrap();
        if let (Some(object), Some(patch)) = (entry.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                object.insert(key.clone(), value.clone());
            }
        }
        connection
            .execute(
                "UPDATE doc_audit SET entry = ?3 WHERE doc_id = ?1 AND seq = ?2",
                params![self.doc_id, seq, entry.to_string()],
            )
            .unwrap();
    }
}

fn point_from(value: &Value) -> Option<Point> {
    let x = value.get("x")?.as_f64()?;
    let y = value.get("y")?.as_f64()?;
    (x.is_finite() && y.is_finite()).then_some(Point { x, y })
}

fn viewport_from(value: &Value) -> Option<Viewport> {
    Some(Viewport {
        scale_x: value.get("scaleX")?.as_f64()?,
        scale_y: value.get("scaleY")?.as_f64()?,
        pan_x: value.get("panX")?.as_f64()?,
        pan_y: value.get("panY")?.as_f64()?,
    })
}

fn same_point(left: Point, right: Point) -> bool {
    (left.x - right.x).abs() < EPSILON && (left.y - right.y).abs() < EPSILON
}

#[test]
fn all_conformance_cases_pass() {
    let cases = Path::new(env!("CARGO_MANIFEST_DIR")).join("../spec/conformance/cases");
    let mut files = fs::read_dir(&cases)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files.len(), 6, "expected the six protocol fixtures");

    let mut failures = Vec::new();
    for path in files {
        let fixture: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let label = fixture["id"].as_str().unwrap_or("case").to_string();
        let mut harness = Harness::new(&label);
        harness.run(&fixture);
        if !harness.failures.is_empty() {
            failures.push(format!("{label}:\n  {}", harness.failures.join("\n  ")));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
