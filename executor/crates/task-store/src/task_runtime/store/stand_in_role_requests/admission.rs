//! Serialize request admission, prerequisite binding and replay recognition.
use super::*;
use rusqlite::Transaction;

fn delegation_rows(
    tx: &Transaction<'_>,
    user: i64,
    root: &str,
) -> Result<HashMap<String, Value>, TaskRuntimeError> {
    let mut statement = tx.prepare(
        "SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_role_request'
         AND json_valid(metadata) AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.root')=?2",
    )?;
    let rows = statement.query_map(params![user, root], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|item| {
        let (id, raw) = item?;
        let row =
            serde_json::from_str(&raw).map_err(|e| TaskRuntimeError::Invalid(e.to_string()))?;
        Ok((id, row))
    })
    .collect()
}

fn check_cancellation(
    rows: &HashMap<String, Value>,
    id: &str,
    intent: &Value,
) -> Result<(), TaskRuntimeError> {
    let ancestors = intent["roleDelegation"]["ancestors"].as_array();
    for (branch, row) in rows {
        if row["cancelRequested"] != true || row["intent"]["sourceDevice"] != intent["sourceDevice"]
        {
            continue;
        }
        let same_group = row["intent"]["roleDelegation"]["ancestors"][0]
            == intent["roleDelegation"]["ancestors"][0];
        let ancestor =
            ancestors.is_some_and(|path| path.iter().any(|parent| parent == branch.as_str()));
        if branch == id || (same_group && (row["cancelGroup"] == true || ancestor)) {
            return Err(TaskRuntimeError::StandInRoleRequestCancelled);
        }
    }
    Ok(())
}

/// Each bound is the minimum prerequisite attempt for this turn. Until evidence
/// is captured, a newer attempt supersedes the earlier result, including on failure.
fn dependency_bounds(
    rows: &HashMap<String, Value>,
    id: &str,
    intent: &Value,
) -> Result<Value, TaskRuntimeError> {
    let mut bounds = json!({});
    let Some(dependencies) = intent.get("dependsOn") else {
        return Ok(bounds);
    };
    let invalid = || TaskRuntimeError::StandInRoleDependencyInvalid;
    let mut pending = Vec::new();
    for input in dependencies.as_array().ok_or_else(invalid)? {
        let dependency = input.as_str().ok_or_else(invalid)?;
        let row = rows.get(dependency).ok_or_else(invalid)?;
        let prior = &row["intent"];
        if !bounds[dependency].is_null()
            || prior["sourceDevice"] != intent["sourceDevice"]
            || !prior["roleDelegation"]["ancestors"]
                .as_array()
                .is_some_and(|ancestors| ancestors.contains(&intent["sourceTaskId"]))
        {
            return Err(invalid());
        }
        bounds[dependency] = json!(row["attempt"].as_u64().unwrap_or(0));
        pending.push(dependency);
    }
    // Only unresolved waits can block this turn. Captured evidence closes the
    // edge, allowing a completed reviewer to be a prerequisite for rework.
    let mut visited = HashSet::new();
    while let Some(node) = pending.pop() {
        if node == id {
            return Err(invalid());
        }
        if !visited.insert(node) {
            continue;
        }
        let row = rows.get(node).ok_or_else(invalid)?;
        if row["taskAddress"].is_null()
            && row["dependencyEvidence"].is_null()
            && row["terminalError"].is_null()
            && row["resultReceipt"].is_null()
            && row["cancelRequested"] != true
        {
            if let Some(edges) = row["intent"]["dependsOn"].as_array() {
                pending.extend(edges.iter().filter_map(Value::as_str));
            }
        }
    }
    Ok(bounds)
}

fn effective_intent(intent: &Value) -> Value {
    let mut effective = intent.clone();
    if let Some(object) = effective.as_object_mut() {
        object.remove("requestBrief");
    }
    effective
}

fn branch_root(intent: &Value) -> Result<&str, TaskRuntimeError> {
    intent["roleDelegation"]["root"]
        .as_str()
        .ok_or(TaskRuntimeError::VersionConflict)
}

fn replayed_followup(
    tx: &Transaction<'_>,
    rows: &HashMap<String, Value>,
    id: &str,
    user: i64,
    request_root: &str,
    intent: &Value,
) -> Result<bool, TaskRuntimeError> {
    let root = branch_root(intent)?;
    check_cancellation(rows, id, intent)?;
    let accepted = ledger::replayed(tx, rows, id, user, root, intent, true)?;
    if root != request_root {
        let current_rows = delegation_rows(tx, user, request_root)?;
        check_cancellation(&current_rows, id, intent)?;
        let recorded = ledger::replayed(tx, &current_rows, id, user, request_root, intent, true)?;
        if accepted && !recorded {
            ledger::bind_followup_to_request(tx, id, user, root, request_root, intent)?;
        } else if recorded && !accepted {
            return Err(TaskRuntimeError::VersionConflict);
        }
    }
    Ok(accepted)
}

impl LocalTaskStore {
    /// Avoid preparing a native turn for an already recorded request. Admission
    /// repeats the check inside its write transaction after any asynchronous work.
    pub fn replayed_stand_in_role_followup(
        &self,
        id: &str,
        user: i64,
        request_root: &str,
        intent: &Value,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let root = branch_root(intent)?;
        let behavior = if root != request_root {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        };
        let tx = connection.transaction_with_behavior(behavior)?;
        let mut rows = delegation_rows(&tx, user, root)?;
        if !replayed_followup(&tx, &rows, id, user, request_root, intent)? {
            return Ok(None);
        }
        let mut result = rows.remove(id).ok_or(TaskRuntimeError::TaskNotFound)?;
        result["alreadyAccepted"] = json!(true);
        tx.commit()?;
        Ok(Some(result))
    }

    pub fn reserve_stand_in_role_request(
        &self,
        id: &str,
        user: i64,
        root: &str,
        intent: &Value,
        limit: usize,
    ) -> Result<Value, TaskRuntimeError> {
        self.reserve_role_request(id, user, root, intent, limit, None)
    }

    /// A receiver may mirror only a generation verified by the source.
    pub fn reserve_verified_stand_in_role_request(
        &self,
        id: &str,
        user: i64,
        root: &str,
        intent: &Value,
        limit: usize,
        attempt: u64,
    ) -> Result<Value, TaskRuntimeError> {
        self.reserve_role_request(id, user, root, intent, limit, Some(attempt))
    }

    fn reserve_role_request(
        &self,
        id: &str,
        user: i64,
        root: &str,
        intent: &Value,
        limit: usize,
        replica_attempt: Option<u64>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows = delegation_rows(&tx, user, root)?;
        let effective = effective_intent(intent);
        if let (Some(saved), Some(attempt)) = (rows.get(id), replica_attempt) {
            let row =
                replica::verified_request(&tx, id, user, root, &effective, attempt, saved.clone())?;
            tx.commit()?;
            return Ok(row);
        }
        if replica_attempt.is_none() {
            let replay = ledger::replayed(&tx, &rows, id, user, root, intent, false)?;
            if let Some(saved) = rows.get(id) {
                if replay || (intent["requestId"].is_null() && saved["intent"] == effective) {
                    let mut result = saved.clone();
                    result["alreadyAccepted"] = json!(true);
                    return Ok(result);
                }
                return Err(TaskRuntimeError::VersionConflict);
            }
        }
        if rows.len() >= limit {
            return Err(TaskRuntimeError::StandInRoleRequestLimit);
        }
        check_cancellation(&rows, id, intent)?;
        let mut row = json!({"userId":user, "root":root,"intent":effective});
        if let Some(attempt) = replica_attempt {
            row["attempt"] = json!(attempt);
        } else if intent.get("dependsOn").is_some() {
            row["dependencyBounds"] = dependency_bounds(&rows, id, intent)?;
        }
        let inserted = tx.execute(
            "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at)
             VALUES (?1,'stand_in_role_request',?2,?3,?3) ON CONFLICT(id) DO NOTHING",
            params![id, row.to_string(), now()],
        )?;
        if inserted != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if replica_attempt.is_none() {
            ledger::record(&tx, id, &row, intent, false, false)?;
        }
        tx.commit()?;
        Ok(row)
    }

    pub fn retry_stand_in_role_request(
        &self,
        id: &str,
        user: i64,
        attempt: u64,
    ) -> Result<bool, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let root: Option<String> = tx
            .query_row(
                "SELECT json_extract(metadata,'$.root') FROM loop_items WHERE id=?1
             AND resource_type='stand_in_role_request' AND json_extract(metadata,'$.userId')=?2",
                params![id, user],
                |row| row.get(0),
            )
            .optional()?;
        let Some(root) = root else { return Ok(false) };
        let rows = delegation_rows(&tx, user, &root)?;
        let Some(row) = rows.get(id) else {
            return Ok(false);
        };
        if row["attempt"].as_u64().unwrap_or(0) != attempt || row["cancelRequested"] == true {
            return Ok(false);
        }
        check_cancellation(&rows, id, &row["intent"])?;
        // A dispatch can fail while still waiting for its prerequisites. A retry
        // must not restore an edge that would now deadlock with another turn.
        if row["dependencyEvidence"].is_null() {
            dependency_bounds(&rows, id, &row["intent"])?;
        }
        let changed = tx.execute(
            "UPDATE loop_items SET metadata=json_remove(json_set(metadata,'$.attempt',?3+1,'$.retrying',json('true')),
                   '$.resultStatus','$.resultReceipt','$.pendingResult','$.resolvedResult',
                   '$.lastError','$.retryAt','$.terminalError','$.taskAddress'),updated_at=?4
             WHERE id=?1 AND resource_type='stand_in_role_request'
               AND json_extract(metadata,'$.userId')=?2
               AND coalesce(json_extract(metadata,'$.attempt'),0)=?3
               AND coalesce(json_extract(metadata,'$.cancelRequested'),0)=0",
            params![id, user, attempt, now()],
        )?;
        tx.commit()?;
        Ok(changed == 1)
    }

    /// None means the caller observed no eligible completed execution. Historical
    /// requests still replay, but only a new, eligible generation can be admitted.
    pub fn continue_stand_in_role_request(
        &self,
        id: &str,
        user: i64,
        request_root: &str,
        intent: &Value,
        expected_attempt: Option<u64>,
    ) -> Result<(Value, bool), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let root = branch_root(intent)?;
        let rows = delegation_rows(&tx, user, root)?;
        let mut row = rows
            .get(id)
            .cloned()
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let saved = &row["intent"];
        if !intent["followupRequestId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
            || [
                "requestId",
                "roleId",
                "sourceDevice",
                "sourceTaskId",
                "sourceRoute",
                "backendUrl",
                "targetDevice",
                "roleDelegation",
            ]
            .iter()
            .any(|key| saved[*key] != intent[*key])
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if replayed_followup(&tx, &rows, id, user, request_root, intent)? {
            tx.commit()?;
            return Ok((row, true));
        }
        let attempt = row["attempt"].as_u64().unwrap_or(0);
        if !saved["sourceRoute"].is_null()
            && (row["resultStatus"] != "done" || !row["resultReceipt"].is_string())
        {
            return Err(TaskRuntimeError::StandInRoleTurnIncomplete);
        }
        if Some(attempt) != expected_attempt
            || !row["taskAddress"].is_object()
            || row["terminalError"].is_string()
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let bounds = dependency_bounds(&rows, id, intent)?;
        if saved["followupRequestId"].is_null() {
            ledger::record(&tx, id, &row, saved, false, true)?;
        }
        let next = attempt
            .checked_add(1)
            .ok_or(TaskRuntimeError::VersionConflict)?;
        row["attempt"] = json!(next);
        row["retrying"] = json!(false);
        let metadata = row.as_object_mut().unwrap();
        for key in [
            "resultStatus",
            "resultReceipt",
            "pendingResult",
            "resolvedResult",
            "lastError",
            "retryAt",
            "terminalError",
            "taskAddress",
            "dependencyStatus",
            "dependencyEvidence",
            "dependencyCheckAt",
            "dependencyBounds",
        ] {
            metadata.remove(key);
        }
        row["intent"]["message"] = intent["message"].clone();
        row["intent"]["followupRequestId"] = intent["followupRequestId"].clone();
        if intent.get("dependsOn").is_some() {
            row["dependencyBounds"] = bounds;
            row["intent"]["dependsOn"] = intent["dependsOn"].clone();
        } else {
            row["intent"].as_object_mut().unwrap().remove("dependsOn");
        }
        tx.execute(
            "UPDATE loop_items SET metadata=?2,updated_at=?3 WHERE id=?1",
            params![id, row.to_string(), now()],
        )?;
        ledger::record(&tx, id, &row, intent, true, false)?;
        if request_root != root {
            ledger::bind_followup_to_request(&tx, id, user, root, request_root, intent)?;
        }
        tx.commit()?;
        Ok((row, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(role: &str, request: &str) -> Value {
        json!({"requestId":request,"roleId":role,"sourceDevice":"mac","targetDevice":"mac",
            "sourceTaskId":"lead","title":role,"message":"original",
            "roleDelegation":{"ancestors":["lead"],"root":"root"}})
    }

    #[test]
    fn legacy_creation_and_followups_share_the_same_scoped_request_ids_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let original = intent("author", "first");
        // Persist exactly the record an older runtime would have produced.
        let row = json!({"userId":7,"root":"root","intent":original,
            "taskAddress":{"deviceId":"mac","taskId":"A"}});
        store
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
             VALUES ('A','stand_in_role_request',?1,?2,?2)",
                params![row.to_string(), now()],
            )
            .unwrap();
        let mut followup = original.clone();
        followup["followupRequestId"] = json!("rework");
        followup["requestBrief"] = json!("apply review");
        followup["message"] = json!("Team duty: design\n\napply review");
        let (accepted, replayed) = store
            .continue_stand_in_role_request("A", 7, "root", &followup, Some(0))
            .unwrap();
        assert!(!replayed);
        assert_eq!(accepted["attempt"], 1);
        assert_eq!(accepted["intent"]["requestId"], "first");
        assert_eq!(accepted["intent"]["message"], followup["message"]);
        assert!(accepted["taskAddress"].is_null());
        drop(store);

        let store = LocalTaskStore::open(path).unwrap();
        let mut newer_duty = followup.clone();
        newer_duty["message"] = json!("Team duty: testing\n\napply review");
        assert!(
            store
                .continue_stand_in_role_request("A", 7, "root", &newer_duty, None)
                .unwrap()
                .1
        );
        assert_eq!(
            store
                .reserve_stand_in_role_request("A", 7, "root", &original, 16)
                .unwrap()["alreadyAccepted"],
            true
        );
        let mut other = original.clone();
        other["title"] = json!("a different title");
        assert!(matches!(
            store.reserve_stand_in_role_request("A", 7, "root", &other, 16),
            Err(TaskRuntimeError::VersionConflict)
        ));
        other["requestId"] = json!("rework");
        assert!(matches!(
            store.reserve_stand_in_role_request("B", 7, "root", &other, 16),
            Err(TaskRuntimeError::VersionConflict)
        ));
        newer_duty["followupRequestId"] = json!("third");
        assert!(matches!(
            store.continue_stand_in_role_request("A", 7, "root", &newer_duty, Some(0)),
            Err(TaskRuntimeError::VersionConflict)
        ));
        assert_eq!(
            store.stand_in_role_request("A", 7).unwrap().unwrap()["attempt"],
            1
        );
    }

    #[test]
    fn cancelling_parent_rejects_followup_of_previously_settled_child() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(dir.path().join("tasks.sqlite")).unwrap();
        let parent = intent("manager", "manager");
        store
            .reserve_stand_in_role_request("parent", 7, "root", &parent, 16)
            .unwrap();
        let mut child = intent("writer", "draft");
        child["sourceTaskId"] = json!("parent");
        child["roleDelegation"]["ancestors"] = json!(["lead", "parent"]);
        child["targetDevice"] = json!("cloud");
        child["sourceRoute"] = json!("mac-route");
        store
            .reserve_stand_in_role_request("child", 7, "root", &child, 16)
            .unwrap();
        store
            .record_stand_in_role_task_address("child", 7, 0, "cloud")
            .unwrap();
        store
            .record_remote_stand_in_role_result("child", 7, 0, "done", Some("done"))
            .unwrap();
        assert_eq!(
            store
                .request_stand_in_role_cancellation(7, "mac", "lead", "root", Some("parent"))
                .unwrap(),
            ["parent"]
        );
        child["followupRequestId"] = json!("revise");
        assert!(matches!(
            store.continue_stand_in_role_request("child", 7, "root", &child, Some(0)),
            Err(TaskRuntimeError::StandInRoleRequestCancelled)
        ));
    }

    #[test]
    fn later_message_shares_receipts_and_honors_cancellation_in_both_groups() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(dir.path().join("tasks.sqlite")).unwrap();
        let mut author = intent("writer", "draft");
        store
            .reserve_stand_in_role_request("A", 7, "root", &author, 16)
            .unwrap();
        store
            .record_stand_in_role_task_address("A", 7, 0, "mac")
            .unwrap();
        let mut other = intent("writer", "independent");
        other["roleDelegation"]["root"] = json!("later");
        store
            .reserve_stand_in_role_request("B", 7, "later", &other, 16)
            .unwrap();

        // A create in the later message already owns this request ID.
        author["followupRequestId"] = json!("independent");
        assert!(matches!(
            store.continue_stand_in_role_request("A", 7, "later", &author, Some(0)),
            Err(TaskRuntimeError::VersionConflict)
        ));
        author["followupRequestId"] = json!("revise");
        let (row, replay) = store
            .continue_stand_in_role_request("A", 7, "later", &author, Some(0))
            .unwrap();
        assert!(!replay);
        assert_eq!(row["root"], "root");
        assert_eq!(row["attempt"], 1);

        // A matching replay from another message binds its ID there as well.
        for root in ["root", "later", "third"] {
            let replay = store
                .replayed_stand_in_role_followup("A", 7, root, &author)
                .unwrap()
                .unwrap();
            assert_eq!(replay["attempt"], 1);
            other["requestId"] = json!("revise");
            other["roleDelegation"]["root"] = json!(root);
            assert!(matches!(
                store.reserve_stand_in_role_request("C", 7, root, &other, 16),
                Err(TaskRuntimeError::VersionConflict)
            ));
        }

        store
            .record_stand_in_role_task_address("A", 7, 1, "mac")
            .unwrap();
        assert_eq!(
            store
                .request_stand_in_role_cancellation(7, "mac", "lead", "later", None)
                .unwrap(),
            ["B"]
        );
        author["followupRequestId"] = json!("new-turn");
        assert!(matches!(
            store.continue_stand_in_role_request("A", 7, "later", &author, Some(1)),
            Err(TaskRuntimeError::StandInRoleRequestCancelled)
        ));
        assert_eq!(
            store
                .request_stand_in_role_cancellation(7, "mac", "lead", "root", Some("A"))
                .unwrap(),
            ["A"]
        );
        assert!(matches!(
            store.continue_stand_in_role_request("A", 7, "third", &author, Some(1)),
            Err(TaskRuntimeError::StandInRoleRequestCancelled)
        ));
    }

    #[test]
    fn failed_dispatch_cannot_restore_an_unresolved_cycle_by_retrying() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(dir.path().join("tasks.sqlite")).unwrap();
        let mut author = intent("dev", "first");
        store
            .reserve_stand_in_role_request("A", 7, "root", &author, 16)
            .unwrap();
        store
            .record_stand_in_role_task_address("A", 7, 0, "mac")
            .unwrap();
        let mut review = intent("review", "second");
        review["dependsOn"] = json!(["A"]);
        store
            .reserve_stand_in_role_request("B", 7, "root", &review, 16)
            .unwrap();
        store
            .record_stand_in_role_route_failure("B", 7, 0, "role_unavailable", false)
            .unwrap();
        author["followupRequestId"] = json!("third");
        author["dependsOn"] = json!(["B"]);
        store
            .continue_stand_in_role_request("A", 7, "root", &author, Some(0))
            .unwrap();
        assert!(matches!(
            store.retry_stand_in_role_request("B", 7, 0),
            Err(TaskRuntimeError::StandInRoleDependencyInvalid)
        ));
        assert_eq!(
            store.stand_in_role_request("B", 7).unwrap().unwrap()["terminalError"],
            "role_unavailable"
        );
    }

    #[test]
    fn completed_dependencies_allow_rework_but_unresolved_cycles_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(dir.path().join("tasks.sqlite")).unwrap();
        let first = intent("dev", "r1");
        store
            .reserve_stand_in_role_request("A", 7, "root", &first, 16)
            .unwrap();
        let mut review = intent("review", "r2");
        review["dependsOn"] = json!(["A"]);
        let reviewer = store
            .reserve_stand_in_role_request("B", 7, "root", &review, 16)
            .unwrap();
        assert_eq!(reviewer["dependencyBounds"], json!({"A":0}));
        store
            .record_stand_in_role_task_address("A", 7, 0, "mac")
            .unwrap();
        let mut rework = first;
        rework["followupRequestId"] = json!("r3");
        rework["dependsOn"] = json!(["B"]);
        assert!(matches!(
            store.continue_stand_in_role_request("A", 7, "root", &rework, Some(0)),
            Err(TaskRuntimeError::StandInRoleDependencyInvalid)
        ));
        assert!(store
            .record_stand_in_role_dependency_state(
                "B",
                7,
                0,
                "ready",
                Some(&json!([{"taskId":"A"}]))
            )
            .unwrap());
        store
            .record_stand_in_role_task_address("B", 7, 0, "mac")
            .unwrap();
        let (resumed, _) = store
            .continue_stand_in_role_request("A", 7, "root", &rework, Some(0))
            .unwrap();
        assert_eq!(resumed["dependencyBounds"], json!({"B":0}));
        review["followupRequestId"] = json!("r4");
        assert!(matches!(
            store.continue_stand_in_role_request("B", 7, "root", &review, Some(0)),
            Err(TaskRuntimeError::StandInRoleDependencyInvalid)
        ));
        store
            .record_stand_in_role_dependency_state(
                "A",
                7,
                1,
                "ready",
                Some(&json!([{"taskId":"B"}])),
            )
            .unwrap();
        store
            .record_stand_in_role_task_address("A", 7, 1, "mac")
            .unwrap();
        let (second_review, _) = store
            .continue_stand_in_role_request("B", 7, "root", &review, Some(0))
            .unwrap();
        assert_eq!(second_review["dependencyBounds"], json!({"A":1}));
    }
}
