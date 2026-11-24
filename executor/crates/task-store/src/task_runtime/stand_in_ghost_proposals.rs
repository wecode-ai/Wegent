//! Device-owned Ghost evaluations. Only the owner's proposal transaction can apply a prompt.
use super::personal_stand_in::read_personal;
use super::stand_in_memories::training_cases_on;
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}

fn owner_key(user: i64, device: &str, role: Option<&str>) -> String {
    json!([user, device, role]).to_string()
}

fn evidence_refs(evidence: &Value) -> Result<BTreeMap<&str, i64>, TaskRuntimeError> {
    let entries = evidence
        .as_array()
        .filter(|entries| entries.len() >= 2)
        .ok_or_else(|| {
            invalid("Ghost evaluation requires training and independent evaluation evidence")
        })?;
    let mut refs = BTreeMap::new();
    for row in entries {
        let id = row["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("Missing training case id"))?;
        let version = row["version"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid("Missing training case version"))?;
        if refs.insert(id, version).is_some() {
            return Err(invalid("Repeated training case"));
        }
    }
    Ok(refs)
}

fn fingerprint(evidence: &Value) -> Result<String, TaskRuntimeError> {
    let bytes =
        serde_json::to_vec(&evidence_refs(evidence)?).map_err(|_| invalid("Invalid evidence"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn decided(
    connection: &Connection,
    owner: &str,
    digest: &str,
    version: i64,
) -> Result<bool, TaskRuntimeError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_items WHERE name=?1 AND resource_type='ghost_evaluation'
         AND sha256=?2 AND (version=?3 OR status IN ('accepted','rejected','reverted')))",
        params![owner, digest, version],
        |row| row.get(0),
    )?)
}

fn identity<'a>(
    settings: &'a mut Value,
    role: Option<&str>,
) -> Result<&'a mut Value, TaskRuntimeError> {
    match role {
        Some(id) => settings["roles"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|row| row["id"] == id))
            .ok_or_else(|| invalid("Training role is no longer available")),
        None => Ok(&mut settings["primary"]),
    }
}

fn role_device_matches(settings: &Value, role: Option<&str>, device: &str) -> bool {
    super::personal_stand_in::stand_in_identities(settings)
        .iter()
        .any(|identity| {
            identity["id"] == role.unwrap_or("@primary") && identity["executionDeviceId"] == device
        })
}

fn visible_cases(
    connection: &Connection,
    user: i64,
    device: &str,
    role: Option<&str>,
    evidence: &Value,
) -> Result<Option<Vec<Value>>, TaskRuntimeError> {
    let refs = evidence_refs(evidence)?;
    let cases = training_cases_on(
        connection,
        user,
        device,
        role.unwrap_or("@primary"),
        Some(evidence),
    )?
    .into_iter()
    .filter(|case| {
        case["id"]
            .as_str()
            .and_then(|id| refs.get(id).copied())
            .is_some_and(|version| case["version"] == version)
    })
    .collect::<Vec<_>>();
    Ok((cases.len() == refs.len()).then_some(cases))
}

pub(super) fn forget_evidence(
    connection: &Connection,
    user: i64,
    case_id: &str,
) -> Result<(), TaskRuntimeError> {
    connection.execute(
        "UPDATE loop_items SET status='obsolete',metadata=json_object('roleId',json_extract(metadata,'$.roleId')),updated_at=?3
        WHERE resource_type='ghost_evaluation' AND user_id=?1 AND status='pending' AND EXISTS (
        SELECT 1 FROM json_each(metadata,'$.evidence') WHERE json_extract(value,'$.id')=?2)",
        params![user, case_id, now()],
    )?;
    Ok(())
}

/// Settings and the candidate share the same optimistic base revision.
pub(super) fn retire_stale_candidates(
    connection: &Connection,
    user: i64,
    version: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute("UPDATE loop_items SET status='obsolete',metadata=json_object('roleId',json_extract(metadata,'$.roleId')),updated_at=?3 WHERE
        resource_type='ghost_evaluation' AND user_id=?1 AND status='pending' AND version<>?2",
        params![user,version.as_i64(),now()])?;
    Ok(())
}

impl LocalTaskStore {
    /// Re-check the selected evidence and role opt-in in the same snapshot as the prompt revision.
    pub fn ghost_evaluation_is_current(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        version: i64,
        evidence: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let settings = read_personal(&tx, user, device)?;
        Ok(settings["version"] == version
            && visible_cases(&tx, user, device, role, evidence)?.is_some())
    }

    pub fn has_ghost_evidence_decision(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        base_version: i64,
        evidence: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        let connection = self.connection()?;
        decided(
            &connection,
            &owner_key(user, device, role),
            &fingerprint(evidence)?,
            base_version,
        )
    }

    pub fn record_ghost_evaluation_no_change(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        base_version: i64,
        evidence: &Value,
    ) -> Result<(), TaskRuntimeError> {
        self.record_ghost_evaluation(user, device, role, base_version, evidence, None)
            .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn propose_trained_ghost(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        base_version: i64,
        candidate_prompt: &str,
        summary: &str,
        evidence: &Value,
        evaluation: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        let refs = evidence_refs(evidence)?;
        let comparisons = evaluation
            .as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or_else(|| invalid("Missing Ghost evaluation comparisons"))?;
        if candidate_prompt.trim().is_empty()
            || summary.trim().is_empty()
            || comparisons.iter().any(|row| {
                !row["caseId"]
                    .as_str()
                    .is_some_and(|id| refs.contains_key(id))
                    || ["baseline", "candidate", "reason"].iter().any(|key| {
                        !row[*key]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                    })
            })
        {
            return Err(invalid("Invalid evaluated Ghost proposal"));
        }
        let data = json!({"prompt":candidate_prompt,"summary":summary,"evaluation":evaluation,"evidence":evidence});
        self.record_ghost_evaluation(user, device, role, base_version, evidence, Some(data))
    }

    fn record_ghost_evaluation(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        base_version: i64,
        evidence: &Value,
        candidate: Option<Value>,
    ) -> Result<bool, TaskRuntimeError> {
        let owner = owner_key(user, device, role);
        let digest = fingerprint(evidence)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if decided(&tx, &owner, &digest, base_version)? {
            return Ok(false);
        }
        let mut settings = read_personal(&tx, user, device)?;
        if settings["version"] != base_version
            || visible_cases(&tx, user, device, role, evidence)?.is_none()
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let profile = identity(&mut settings, role)?;
        if profile["selfLearningEnabled"] != true {
            return Err(invalid("Assistant learning is disabled"));
        }
        let status = if candidate.is_some() {
            "pending"
        } else {
            "unchanged"
        };
        let mut data = candidate.unwrap_or_else(|| json!({}));
        if status == "pending" && profile["prompt"] == data["prompt"] {
            return Ok(false);
        }
        data["roleId"] = json!(role);
        // The optional learning service owns these indexes; first use does not affect desktop startup.
        tx.execute_batch("CREATE INDEX IF NOT EXISTS ix_ghost_evaluation_owner
            ON loop_items(name,status,version) WHERE resource_type='ghost_evaluation';
            CREATE INDEX IF NOT EXISTS ix_ghost_pending_user ON loop_items(user_id,device_id,version)
            WHERE resource_type='ghost_evaluation' AND status='pending'")?;
        let id = format!("ghost:{}", Uuid::new_v4());
        tx.execute("INSERT INTO loop_items (id,resource_type,name,user_id,device_id,version,sha256,status,metadata,created_at,updated_at)
            VALUES (?1,'ghost_evaluation',?2,?3,?4,?5,?6,?7,?8,?9,?9)",params![id,owner,user,device,base_version,digest,status,data.to_string(),now()])?;
        tx.commit()?;
        Ok(true)
    }

    /// Manual conversation drafts keep their existing slot and take precedence over background work.
    pub fn stand_in_proposal_for_device(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let manual = super::stand_in_proposals::manual_proposal_on(&tx, user, role)?;
        if !manual.is_null() {
            return Ok(manual);
        }
        let mut statement = tx.prepare(
            "SELECT id,metadata FROM loop_items WHERE resource_type='ghost_evaluation'
             AND name=?1 AND status='pending' AND version=(
                 SELECT json_extract(metadata,'$.version') FROM loop_items WHERE id=?2 AND resource_type='personal_stand_in'
             ) ORDER BY created_at,id",
        )?;
        let mut rows = statement.query(params![
            owner_key(user, device, role),
            super::personal_stand_in::personal_key(user)
        ])?;
        while let Some(row) = rows.next()? {
            let data: Value = serde_json::from_str(&row.get::<_, String>(1)?)
                .map_err(|_| invalid("Invalid Ghost proposal"))?;
            let Some(cases) = visible_cases(&tx, user, device, role, &data["evidence"])? else {
                continue;
            };
            let mut draft = read_personal(&tx, user, device)?;
            let profile = identity(&mut draft, role)?;
            if profile["selfLearningEnabled"] != true {
                return Ok(Value::Null);
            }
            let previous = profile["prompt"].clone();
            profile["prompt"] = data["prompt"].clone();
            let id: String = row.get(0)?;
            let examples: Vec<_> = cases
                .iter()
                .map(|case| {
                    json!({
                        "id": case["id"],
                        "scene": case["scene"],
                        "actual": case["actual"],
                        "expected": case["expected"],
                    })
                })
                .collect();
            return Ok(json!({
                "id": id,
                "userId": user,
                "roleId": role,
                "status": "pending",
                "summary": data["summary"],
                "settings": draft,
                "training": {
                    "deviceId": device,
                    "before": previous,
                    "after": data["prompt"],
                    "cases": examples,
                    "evaluation": data["evaluation"],
                },
            }));
        }
        Ok(Value::Null)
    }

    /// Return the most recent change the owner can still reverse, without copying source evidence.
    pub fn latest_applied_ghost(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let row: Option<(String,String)> = tx.query_row("SELECT id,metadata FROM loop_items WHERE name=?1 AND resource_type='ghost_evaluation'
            AND status='accepted' ORDER BY version DESC LIMIT 1", [owner_key(user,device,role)], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        let Some((id, raw)) = row else {
            return Ok(Value::Null);
        };
        let data: Value =
            serde_json::from_str(&raw).map_err(|_| invalid("Invalid Ghost revision"))?;
        let mut settings = read_personal(&tx, user, device)?;
        if !role_device_matches(&settings, role, device)
            || identity(&mut settings, role)?["prompt"] != data["prompt"]
        {
            return Ok(Value::Null);
        }
        Ok(
            json!({"id":id,"before":data["before"],"after":data["prompt"],"version":settings["version"]}),
        )
    }

    pub fn undo_trained_ghost(
        &self,
        user: i64,
        device: &str,
        id: &str,
        reviewed_version: i64,
    ) -> Result<Value, TaskRuntimeError> {
        self.apply_ghost_decision(user, device, id, true, Some(reviewed_version))
    }

    /// Lookup by owner and opaque proposal id before verifying the runtime's current route.
    pub fn ghost_decision_device(&self, user: i64, id: &str) -> Result<String, TaskRuntimeError> {
        Ok(self.connection()?.query_row(
            "SELECT device_id FROM loop_items WHERE id=?1 AND user_id=?2 AND resource_type='ghost_evaluation'",
            params![id, user], |row| row.get(0),
        )?)
    }

    pub(super) fn apply_ghost_decision(
        &self,
        user: i64,
        device: &str,
        id: &str,
        accept: bool,
        undo_version: Option<i64>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (raw, version, status): (String, i64, String) = tx.query_row(
            "SELECT metadata,version,status FROM loop_items
            WHERE id=?1 AND resource_type='ghost_evaluation' AND user_id=?2 AND device_id=?3",
            params![id, user, device],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let data: Value =
            serde_json::from_str(&raw).map_err(|_| invalid("Invalid Ghost decision"))?;
        let role = data["roleId"].as_str();
        let mut settings = read_personal(&tx, user, device)?;
        if !role_device_matches(&settings, role, device) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let mut retained = json!({"roleId":role});
        let new_status =
            if let Some(reviewed_version) = undo_version {
                let latest: Option<String> = tx.query_row(
                "SELECT id FROM loop_items WHERE name=?1 AND resource_type='ghost_evaluation'
                 AND status='accepted' ORDER BY version DESC LIMIT 1",
                [owner_key(user,device,role)], |row| row.get(0),
            ).optional()?;
                if latest.as_deref() != Some(id)
                    || settings["version"] != reviewed_version
                    || identity(&mut settings, role)?["prompt"] != data["prompt"]
                {
                    return Err(TaskRuntimeError::VersionConflict);
                }
                identity(&mut settings, role)?["prompt"] = data["before"].clone();
                "reverted"
            } else {
                if status != "pending" && (accept || status != "obsolete") {
                    return Err(TaskRuntimeError::VersionConflict);
                }
                if accept {
                    if settings["version"] != version
                        || !super::stand_in_proposals::manual_proposal_on(&tx, user, role)?
                            .is_null()
                        || visible_cases(&tx, user, device, role, &data["evidence"])?.is_none()
                    {
                        return Err(TaskRuntimeError::VersionConflict);
                    }
                    let profile = identity(&mut settings, role)?;
                    if profile["selfLearningEnabled"] != true {
                        return Err(invalid("Assistant learning is disabled"));
                    }
                    let prompt = &mut profile["prompt"];
                    retained["before"] = prompt.clone();
                    retained["prompt"] = data["prompt"].clone();
                    *prompt = data["prompt"].clone();
                    "accepted"
                } else {
                    "rejected"
                }
            };
        if accept {
            let profile_device = settings["executionDeviceId"]
                .as_str()
                .ok_or_else(|| invalid("Missing profile device"))?
                .to_owned();
            settings =
                self.save_personal_stand_in_on(&tx, user, &profile_device, settings, false, None)?;
        }
        tx.execute(
            "UPDATE loop_items SET status=?1,metadata=?2,updated_at=?3 WHERE id=?4",
            params![new_status, retained.to_string(), now(), id],
        )?;
        tx.commit()?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn training_fixture() -> (tempfile::TempDir, LocalTaskStore, Value, Value) {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] = json!({"enabled":true,"selfLearningEnabled":true,"prompt":"old","preferences":"private"});
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let mut evidence = Vec::new();
        for scene in ["first", "other"] {
            let memory = store.save_verified_training_memory(7,"mac",json!({
                "content":format!("Lesson for {scene}"), "scope":{"kind":"personal"},
                "evidence":{"taskId":scene,"messageId":scene,"trainingCase":{
                    "roleId":"@primary","group":scene,"scene":scene,"expected":"Ask first","kind":"demonstration"}}
            })).unwrap();
            evidence.push(json!({"id":memory["id"],"version":memory["version"]}));
        }
        (root, store, settings, json!(evidence))
    }

    fn draft(store: &LocalTaskStore, settings: &Value, evidence: &Value) -> bool {
        store.propose_trained_ghost(7,"mac",None,settings["version"].as_i64().unwrap(),"new","Learn from corrections",evidence,
            &json!([{"caseId":evidence[1]["id"],"baseline":"Infer","candidate":"Ask first","reason":"Uses the evidence"}])).unwrap()
    }

    #[test]
    fn role_route_can_apply_and_undo_ghost_without_rebinding_profile() {
        let (_root, store, mut settings, _) = training_fixture();
        settings["roles"] = json!([crate::task_runtime::personal_stand_in::empty_role(
            "default", "mac"
        )]);
        let role = &mut settings["roles"][0];
        role["enabled"] = json!(true);
        role["selfLearningEnabled"] = json!(true);
        role["executionDeviceId"] = json!("registered-route");
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let mut evidence = Vec::new();
        for scene in ["one", "two"] {
            let memory = json!({"scope":{"kind":"role","roleId":"default"},"content":scene,
                "evidence":{"taskId":scene,"messageId":scene,"trainingCase":{
                    "roleId":"default","kind":"demonstration","scene":scene,"group":scene,"expected":"ask"}}});
            assert!(store
                .save_verified_training_memory(7, "elsewhere", memory.clone())
                .is_err());
            let saved = store
                .save_verified_training_memory(7, "registered-route", memory)
                .unwrap();
            evidence.push(json!({"id":saved["id"],"version":saved["version"]}));
        }
        let evaluation = json!([{"caseId":evidence[1]["id"],"baseline":"Infer","candidate":"Ask","reason":"Clarifies"}]);
        let role = Some("default");
        store
            .propose_trained_ghost(
                7,
                "registered-route",
                role,
                settings["version"].as_i64().unwrap(),
                "ask",
                "clarify",
                &json!(evidence),
                &evaluation,
            )
            .unwrap();
        let ghost = store
            .stand_in_proposal_for_device(7, "registered-route", role)
            .unwrap();
        let id = ghost["id"].as_str().unwrap();
        assert!(store
            .resolve_stand_in_proposal(7, "elsewhere", id, true, None)
            .is_err());
        let applied = store
            .resolve_stand_in_proposal(7, "registered-route", id, true, None)
            .unwrap();
        assert_eq!(applied["executionDeviceId"], "mac");
        assert_eq!(applied["roles"][0]["prompt"], "ask");
        let revision = store
            .latest_applied_ghost(7, "registered-route", role)
            .unwrap();
        let undone = store
            .undo_trained_ghost(
                7,
                "registered-route",
                id,
                revision["version"].as_i64().unwrap(),
            )
            .unwrap();
        assert_eq!(undone["roles"][0]["prompt"], settings["roles"][0]["prompt"]);
        assert_eq!(undone["executionDeviceId"], "mac");
    }

    #[test]
    fn manual_draft_precedes_ghost_and_rejection_suppresses_repeated_evidence() {
        let (_root, store, settings, evidence) = training_fixture();
        assert!(draft(&store, &settings, &evidence));
        let ghost = store.stand_in_proposal_for_device(7, "mac", None).unwrap();
        let manual = store
            .propose_stand_in_settings(7, "mac", None, "Change settings", settings.clone())
            .unwrap();
        assert_eq!(
            store.stand_in_proposal_for_device(7, "mac", None).unwrap()["id"],
            manual["id"]
        );
        assert!(store
            .resolve_stand_in_proposal(7, "mac", ghost["id"].as_str().unwrap(), true, None)
            .is_err());
        store
            .resolve_stand_in_proposal(7, "mac", manual["id"].as_str().unwrap(), false, None)
            .unwrap();
        assert_eq!(
            store.stand_in_proposal_for_device(7, "mac", None).unwrap()["id"],
            ghost["id"]
        );
        store
            .resolve_stand_in_proposal(7, "mac", ghost["id"].as_str().unwrap(), false, None)
            .unwrap();
        assert!(!draft(
            &store,
            &settings,
            &json!([evidence[1], evidence[0]])
        ));
    }

    #[test]
    fn forgotten_example_invalidates_review_and_approval_without_changing_settings() {
        let (_root, store, settings, evidence) = training_fixture();
        assert!(draft(&store, &settings, &evidence));
        let ghost = store.stand_in_proposal_for_device(7, "mac", None).unwrap();
        store
            .delete_stand_in_memory(7, evidence[0]["id"].as_str().unwrap(), 1)
            .unwrap();
        assert!(store
            .stand_in_proposal_for_device(7, "mac", None)
            .unwrap()
            .is_null());
        assert!(store
            .resolve_stand_in_proposal(7, "mac", ghost["id"].as_str().unwrap(), true, None)
            .is_err());
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), settings);
    }

    #[test]
    fn undo_only_restores_the_accepted_prompt_and_rechecks_the_reviewed_version() {
        let (_root, store, settings, evidence) = training_fixture();
        assert!(draft(&store, &settings, &evidence));
        let ghost = store.stand_in_proposal_for_device(7, "mac", None).unwrap();
        let id = ghost["id"].as_str().unwrap();
        let mut changed = store
            .resolve_stand_in_proposal(
                7,
                "mac",
                id,
                true,
                Some(json!({"primary":{"preferences":"forged"}})),
            )
            .unwrap();
        assert_eq!(changed["primary"]["preferences"], "private");
        let revision = store.latest_applied_ghost(7, "mac", None).unwrap();
        changed["primary"]["selfLearningEnabled"] = json!(false);
        let changed = store.save_personal_stand_in(7, "mac", changed).unwrap();
        assert!(store
            .undo_trained_ghost(7, "mac", id, revision["version"].as_i64().unwrap())
            .is_err());
        let restored = store
            .undo_trained_ghost(7, "mac", id, changed["version"].as_i64().unwrap())
            .unwrap();
        assert_eq!(restored["primary"]["prompt"], "old");
        assert_eq!(restored["primary"]["selfLearningEnabled"], false);
        assert!(store
            .latest_applied_ghost(7, "mac", None)
            .unwrap()
            .is_null());
    }
}
