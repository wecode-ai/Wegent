//! Training and approval recheck the same evidence inside the current database snapshot.
use super::*;

pub(super) fn is_cloud_issue(source: &Value) -> bool {
    source["providerId"] == super::super::personal_stand_in::ISSUE_COMMENTS_PROVIDER
        && source["profile"] == "cloud"
}

/// Issue an idempotent case key only while the same learning role can still use this evidence.
pub(super) fn verified_memory_key(
    connection: &Connection,
    settings: &Value,
    user: i64,
    device: &str,
    input: &Value,
) -> Result<String, TaskRuntimeError> {
    let evidence = &input["evidence"];
    let case = &evidence["trainingCase"];
    if !settings["lifecycle"]["status"].is_null()
        || !stand_in_identities(settings).iter().any(|role| {
            role["executionDeviceId"] == device
                && role["enabled"] == true
                && role["selfLearningEnabled"] == true
                && if is_cloud_issue(&case["source"]) {
                    case_granted(role, input)
                } else {
                    case_visible(connection, role, input)
                }
        })
    {
        return Err(TaskRuntimeError::Invalid(
            "Training case scope is no longer available".into(),
        ));
    }
    Ok(training_memory_key(user, evidence))
}

fn training_memory_key(user: i64, evidence: &Value) -> String {
    let case = &evidence["trainingCase"];
    let source_record = json!([
        user,
        case["roleId"],
        evidence["taskId"],
        evidence["messageId"]
    ]);
    if case["kind"] == "observation" {
        let fingerprint = Sha256::digest(source_record.to_string());
        format!("stand-in-observation:{fingerprint:x}")
    } else {
        let fingerprint = Sha256::digest(
            json!([
                source_record,
                case["sceneMessageId"],
                case["actualMessageId"]
            ])
            .to_string(),
        );
        format!("stand-in-training-memory:{fingerprint:x}")
    }
}

pub(super) fn reserve_memory_slot(
    connection: &Connection,
    user: i64,
    case: Option<&Value>,
) -> Result<(), TaskRuntimeError> {
    const CAPACITY: i64 = 1000;
    let Some(case) = case else {
        let count: i64 = connection.query_row(
            "SELECT count(*) FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1
             AND json_type(metadata,'$.evidence.trainingCase') IS NOT 'object'",
            [user], |row| row.get(0))?;
        if count >= CAPACITY {
            return Err(TaskRuntimeError::Invalid(
                "Memory limit reached; remove unused memories first".into(),
            ));
        }
        return Ok(());
    };
    // Keep the most recently collected cases. Panel edits lose their case evidence and
    // become ordinary memories. Source observations rotate separately from Ghost evidence.
    let mut query = connection.prepare_cached(
        "SELECT id FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1
         AND json_type(metadata,'$.evidence.trainingCase')='object'
         AND (json_extract(metadata,'$.evidence.trainingCase.kind') IS 'observation')=?3
         ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?2")?;
    let oldest = query
        .query_map(
            params![user, CAPACITY - 1, case["kind"] == "observation"],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    for id in oldest {
        super::super::stand_in_ghost_proposals::forget_evidence(connection, user, &id)?;
        connection.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory'",
            [id],
        )?;
    }
    Ok(())
}

pub(super) fn recent_lesson(memory: &Value, at: i64) -> bool {
    let week = chrono::Duration::days(7).num_milliseconds();
    memory["evidence"]["observedAt"]
        .as_i64()
        .is_some_and(|time| time > at.saturating_sub(week) && time <= at)
}

pub(super) fn case_binding(row: &Value) -> &Value {
    row.get("trainingScope")
        .unwrap_or(&row["evidence"]["trainingCase"])
}

pub(in super::super) fn local_issue_visible(
    db: &Connection,
    role: &Value,
    source: &Value,
) -> Result<bool, TaskRuntimeError> {
    let tags = role["collaboration"]["tags"]
        .as_array()
        .map(|v| json!(v))
        .unwrap_or_else(|| json!([]));
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_items issue JOIN loop_items project ON project.id=issue.cloud_project_id
           WHERE issue.id=?1 AND issue.resource_type='task' AND issue.deleted_at IS NULL
             AND project.id=?2 AND project.resource_type='project' AND project.deleted_at IS NULL
             AND (json_array_length(?3)=0 OR EXISTS(
                 SELECT 1 FROM json_each(?3) wanted JOIN json_each(issue.metadata,'$.tags') tag ON wanted.value=tag.value)))",
        params![source["id"].as_str(),source["projectId"].as_str(),tags.to_string()], |row| row.get(0))?)
}

impl LocalTaskStore {
    /// Validate model input before the executor records a durable pending review write.
    pub fn training_memory_write_key(
        user: i64,
        content: &str,
        evidence: &Value,
    ) -> Result<String, TaskRuntimeError> {
        super::validate_memory_content(Some(content))?;
        super::validate_memory_evidence(Some(evidence))?;
        Ok(training_memory_key(user, evidence))
    }
    pub fn local_issue_review_visible(
        &self,
        role: &Value,
        source: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        local_issue_visible(&*self.connection()?, role, source)
    }
}

pub(super) fn case_visible(connection: &Connection, role: &Value, memory: &Value) -> bool {
    let source = &case_binding(memory)["source"];
    case_granted(role, memory)
        && (source["providerId"] != super::super::personal_stand_in::ISSUE_COMMENTS_PROVIDER
            || (source["profile"] == "local"
                && local_issue_visible(connection, role, source).unwrap_or(false)))
}

pub(super) fn case_granted(role: &Value, memory: &Value) -> bool {
    let case = case_binding(memory);
    if !case["roleId"].is_string() || case["roleId"] != role["id"] {
        return false;
    }
    let source = &case["source"];
    let scope = &memory["scope"];
    if source.is_object() {
        return super::super::personal_stand_in::training_memory_scope(source) == *scope
            && super::super::personal_stand_in::training_source_granted(role, source);
    }
    if role["id"] == "@primary" {
        scope == &json!({"kind":"personal"})
    } else {
        scope == &json!({"kind":"role","roleId":role["id"]})
    }
}

pub(in super::super) fn training_cases_on(
    connection: &Connection,
    user: i64,
    device: &str,
    role_id: &str,
    evidence: Option<&Value>,
) -> Result<Vec<Value>, TaskRuntimeError> {
    let settings = read_personal(connection, user, device)?;
    let role = stand_in_identities(&settings).into_iter().find(|role| {
        role["id"] == role_id
            && role["executionDeviceId"] == device
            && role["enabled"] == true
            && role["selfLearningEnabled"] == true
    });
    let Some(role) = role.filter(|_| settings["lifecycle"]["status"].is_null()) else {
        return Ok(Vec::new());
    };
    let sql = if evidence.is_some() {
        "SELECT metadata FROM loop_items WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?3)) AND resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.evidence.trainingCase.roleId')=?2 ORDER BY updated_at DESC,id"
    } else {
        "SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.evidence.trainingCase.roleId')=?2 ORDER BY updated_at DESC,id"
    };
    let mut query = connection.prepare_cached(sql)?;
    let mut rows = match evidence {
        Some(evidence) => query.query(params![user, role_id, evidence.to_string()])?,
        None => query.query(params![user, role_id])?,
    };
    let mut cases = Vec::new();
    while let Some(row) = rows.next()? {
        let memory: Value = serde_json::from_str(&row.get::<_, String>(0)?)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        let case = &memory["evidence"]["trainingCase"];
        if case["kind"] != "observation" && case_visible(connection, &role, &memory) {
            cases.push(json!({"id":memory["id"],"version":memory["version"],"lesson":memory["content"],
                "scope":memory["scope"],"group":case["group"],"scene":case["scene"],"expected":case["expected"],
                "kind":case["kind"],"actual":case["actual"],"expectedAuthor":case["expectedAuthor"]}));
        }
    }
    Ok(cases)
}

pub(super) fn management_rows(
    connection: &Connection,
    user: i64,
    device: &str,
    registered_device: Option<&str>,
    mut rows: Vec<Value>,
) -> Result<Vec<Value>, TaskRuntimeError> {
    if !rows.iter().any(|row| case_binding(row).is_object()) {
        return Ok(rows);
    }
    let settings = read_personal(connection, user, device)?;
    let roles: std::collections::HashMap<String, Value> = stand_in_identities(&settings)
        .into_iter()
        .filter(|role| {
            role["executionDeviceId"]
                .as_str()
                .is_some_and(|route| route == device || Some(route) == registered_device)
        })
        .filter_map(|role| Some((role["id"].as_str()?.to_owned(), role)))
        .collect();
    for row in &mut rows {
        let case = case_binding(row);
        if case.is_object()
            && !case["roleId"]
                .as_str()
                .and_then(|role| roles.get(role))
                .is_some_and(|role| case_visible(connection, role, row))
        {
            row["content"] = json!("");
            row["sourceTaskId"] = Value::Null;
            row["evidence"] = Value::Null;
            row["evidenceUnavailable"] = json!(true);
        }
        row.as_object_mut().unwrap().remove("trainingScope");
    }
    Ok(rows)
}

impl LocalTaskStore {
    /// Management keeps enough identity to forget a case even after access to its source ends.
    pub fn stand_in_management_memories(
        &self,
        user: i64,
        device: &str,
        registered_device: Option<&str>,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        management_rows(
            &transaction,
            user,
            device,
            registered_device,
            memory_rows_on(&transaction, user)?,
        )
    }

    pub fn stand_in_training_cases(
        &self,
        user: i64,
        device: &str,
        role_id: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        training_cases_on(&transaction, user, device, role_id, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_keys_allow_one_owner_response_to_verify_multiple_sent_answers() {
        let mut evidence = json!({"taskId":"source","messageId":"owner-response",
            "trainingCase":{"kind":"correction","roleId":"role","sceneMessageId":"request",
            "actualMessageId":"answer"}});
        let key = LocalTaskStore::training_memory_write_key(7, "Lesson", &evidence).unwrap();
        assert_eq!(training_memory_key(7, &evidence), key);
        evidence["trainingCase"]["actualMessageId"] = json!("other-answer");
        assert_ne!(training_memory_key(7, &evidence), key);
        assert!(
            LocalTaskStore::training_memory_write_key(7, &"x".repeat(4001), &evidence).is_err()
        );
        evidence["excerpt"] = json!("x".repeat(8001));
        assert!(LocalTaskStore::training_memory_write_key(7, "Lesson", &evidence).is_err());
    }

    #[test]
    fn case_rotation_preserves_ordinary_memories_and_retires_dependent_proposals() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("memory.sqlite")).unwrap();
        let mut config = store.personal_stand_in(7, "mac").unwrap();
        config["primary"] = json!({"enabled":true,"selfLearningEnabled":true,"prompt":"Assist the owner","preferences":""});
        store.save_personal_stand_in(7, "mac", config).unwrap();
        let case = |message: &str| {
            json!({"scope":{"kind":"personal"},"content":format!("Lesson {message}"),"sourceTaskId":"identity",
            "evidence":{"taskId":"identity","messageId":message,"observedAt":10,
            "trainingCase":{"roleId":"@primary","group":"one","kind":"correction","scene":"First question","expected":"Clarify the input"}}})
        };
        let mut edited = store
            .save_verified_training_memory(7, "mac", case("first"))
            .unwrap();
        edited["content"] = json!("Keep my edited memory");
        edited["restoreForgotten"] = json!(true);
        let edited = store.save_stand_in_memory(7, "mac", edited).unwrap();
        assert!(edited["evidence"].is_null());
        assert!(store
            .recall_stand_in_memory_rules(7, "mac", Some("other"), None)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .recall_stand_in_memory_rules(7, "mac", None, None)
                .unwrap()
                .len(),
            1
        );
        let db = store.connection().unwrap();
        db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
            INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
            SELECT 'case-'||x,'stand_in_memory',json_object('userId',7,'evidence',json_object('trainingCase',json_object())),printf('%04d',x),'0' FROM n;
            WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
            INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
            SELECT 'observation-'||x,'stand_in_memory',json_object('userId',7,'evidence',json_object('trainingCase',json_object('kind','observation'))),printf('%04d',x),'0' FROM n;
            WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<998)
            INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
            SELECT 'ordinary-'||x,'stand_in_memory',json_object('userId',7),'0','0' FROM n;
            INSERT INTO loop_items(id,resource_type,user_id,status,metadata,created_at,updated_at)
            VALUES('proposal','ghost_evaluation',7,'pending','{\"roleId\":\"@primary\",\"evidence\":[{\"id\":\"case-1\"}]}','0','0');").unwrap();
        reserve_memory_slot(&db, 7, Some(&json!({"kind":"observation"}))).unwrap();
        assert!(get_item_from(&db, "observation-1", "stand_in_memory")
            .unwrap()
            .is_none());
        assert!(get_item_from(&db, "case-1", "stand_in_memory")
            .unwrap()
            .is_some());
        drop(db);
        let ordinary = |content| json!({"scope":{"kind":"personal"},"content":content});
        store
            .save_stand_in_memory(7, "mac", ordinary("last ordinary slot"))
            .unwrap();
        assert!(store
            .save_stand_in_memory(7, "mac", ordinary("over ordinary limit"))
            .is_err());
        let newest = store
            .save_verified_training_memory(7, "mac", case("second"))
            .unwrap();
        let db = store.connection().unwrap();
        assert!(get_item_from(&db, "case-1", "stand_in_memory")
            .unwrap()
            .is_none());
        assert!(get_item_from(&db, "case-2", "stand_in_memory")
            .unwrap()
            .is_some());
        for row in [newest, edited] {
            assert!(
                get_item_from(&db, row["id"].as_str().unwrap(), "stand_in_memory")
                    .unwrap()
                    .is_some()
            );
        }
        let status: String = db
            .query_row(
                "SELECT status FROM loop_items WHERE id='proposal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "obsolete");
    }

    #[test]
    fn source_observations_keep_attribution_and_cannot_supply_ghost_evidence() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("memory.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] = json!({"enabled":true,"selfLearningEnabled":true,
            "prompt":"","preferences":"","connections":[{
            "providerId":"@wegent/dsh-connection-runtime/email","profile":"me","kind":"inbox",
            "id":"INBOX","name":"Inbox","policy":{"automatic":false,"askBeforeAct":true}
        }]});
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let source = &settings["primary"]["connections"][0];
        let scope = super::super::super::personal_stand_in::connection_memory_scope(source);
        let input = json!({"scope":scope, "content":"A sender reports an internal release.", "evidence":{
            "taskId":"training-source:inbox","messageId":"m1","observedAt":chrono::Utc::now().timestamp_millis(),
            "excerpt":"The release is internal.", "role":"source",
            "trainingCase":{"kind":"observation","roleId":"@primary","source":source}
        }});
        let saved = store
            .save_verified_training_memory(7, "mac", input.clone())
            .unwrap();
        assert!(store
            .stand_in_training_cases(7, "mac", "@primary")
            .unwrap()
            .is_empty());
        let recalled = store
            .recall_stand_in_memories(7, "mac", None, Some(&scope))
            .unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0]["content"], input["evidence"]["excerpt"]);
        assert_eq!(recalled[0]["attribution"], "source_record_excerpt");
        assert!(store
            .recall_stand_in_memories(7, "mac", Some("another-role"), Some(&scope))
            .unwrap()
            .is_empty());
        store
            .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
            .unwrap();
        assert!(matches!(
            store.save_verified_training_memory(7, "mac", input),
            Err(TaskRuntimeError::MemorySuppressed)
        ));
    }

    #[test]
    fn learned_cases_require_enabled_identity_current_source_and_live_evidence() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("memory.sqlite")).unwrap();
        let mut config = store.personal_stand_in(7, "mac").unwrap();
        let grant = json!({"providerId":"@wegent/dsh-connection-dingtalk/dingtalk","profile":"work","kind":"group","scope":"all","id":"*","name":"All groups","policy":{"automatic":false,"askBeforeAct":true}});
        config["roles"][0]["enabled"] = json!(true);
        config["roles"][0]["connections"] = json!([grant]);
        let mut config = store.save_personal_stand_in(7, "mac", config).unwrap();
        let role = config["roles"][0]["id"].as_str().unwrap().to_owned();
        let mut source = config["roles"][0]["connections"][0].clone();
        source["id"] = json!("one");
        let scope = super::super::super::personal_stand_in::connection_memory_scope(&source);
        let input = json!({"scope":scope,"content":"Ask about onset before diagnosing the slowdown.","sourceTaskId":"training-source:one",
            "evidence":{"taskId":"training-source:one","messageId":"m2","observedAt":chrono::Utc::now().timestamp_millis(),"excerpt":"When did it begin?",
            "trainingCase":{"roleId":role,"source":source,"group":"one","kind":"demonstration","scene":"It is slow.","expected":"When did it begin?"}}});
        assert!(store
            .save_verified_training_memory(7, "mac", input.clone())
            .is_err());
        config["roles"][0]["selfLearningEnabled"] = json!(true);
        let mut config = store.save_personal_stand_in(7, "mac", config).unwrap();
        assert!(store.save_stand_in_memory(7, "mac", input.clone()).is_err());
        let mut unbound = input.clone();
        unbound["evidence"]["trainingCase"]["source"]
            .as_object_mut()
            .unwrap()
            .remove("enabledAfter");
        assert!(store
            .save_verified_training_memory(7, "mac", unbound)
            .is_err());
        let row = store
            .save_verified_training_memory(7, "mac", input.clone())
            .unwrap();
        let feedback = row["evidence"]["observedAt"].as_i64().unwrap();
        assert!(recent_lesson(&row, feedback));
        assert!(!recent_lesson(
            &row,
            feedback + chrono::Duration::days(7).num_milliseconds()
        ));
        assert_eq!(
            store
                .stand_in_training_cases(7, "mac", &role)
                .unwrap()
                .len(),
            1
        );
        let recalled = store
            .recall_stand_in_memories(7, "mac", Some(&role), Some(&scope))
            .unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0]["content"], row["content"]);
        assert!(recalled[0].get("evidence").is_none());
        assert!(recalled[0].get("sourceTaskId").is_none());
        assert!(store
            .stand_in_training_cases(7, "mac", "@primary")
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .save_verified_training_memory(7, "mac", input.clone())
                .unwrap(),
            row
        );
        config["roles"][0]["connections"][0]["excludedResources"] =
            json!([{"id":"one","name":"One group"}]);
        let mut config = store.save_personal_stand_in(7, "mac", config).unwrap();
        assert!(store
            .stand_in_training_cases(7, "mac", &role)
            .unwrap()
            .is_empty());
        assert!(store
            .recall_stand_in_memories(7, "mac", Some(&role), Some(&scope))
            .unwrap()
            .is_empty());
        let redacted = store
            .stand_in_management_memories(7, "mac", None)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(redacted["id"], row["id"]);
        assert_eq!(redacted["content"], "");
        assert!(redacted["evidence"].is_null());
        config["roles"][0]["connections"][0]["excludedResources"] = json!([]);
        let mut config = store.save_personal_stand_in(7, "mac", config).unwrap();
        store
            .delete_stand_in_memory(7, row["id"].as_str().unwrap(), 1)
            .unwrap();
        assert!(store
            .stand_in_training_cases(7, "mac", &role)
            .unwrap()
            .is_empty());
        assert!(matches!(
            store.save_verified_training_memory(7, "mac", input),
            Err(TaskRuntimeError::MemorySuppressed)
        ));
        config["roles"][0]["connections"][0]["excludedResources"] =
            json!([{"id":"one","name":"One group"}]);
        store.save_personal_stand_in(7, "mac", config).unwrap();
        let rule = store
            .stand_in_memory_rule_records(7, "mac", None)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(rule["content"], "");
        assert_eq!(rule["evidenceUnavailable"], true);
        assert!(store
            .recall_stand_in_memory_rules(7, "mac", Some(&role), Some(&scope))
            .unwrap()
            .is_empty());
    }
}
