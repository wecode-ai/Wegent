//! Local assignment receipts use the same history ordinal as stand-in task identity.
use super::*;
use sha2::{Digest, Sha256};

impl LocalTaskStore {
    pub fn queue_assignment_receipt(&self, receipt: &Value) -> Result<(), TaskRuntimeError> {
        let identity = json!([
            receipt["backendUrl"],
            receipt["userId"],
            receipt["issueId"],
            receipt["assignmentId"],
            receipt["taskId"]
        ]);
        let id = format!(
            "assignment-receipt:{:x}",
            Sha256::digest(identity.to_string().as_bytes())
        );
        self.connection()?.execute(
            "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'assignment_receipt',?2,?3,?3) ON CONFLICT(id) DO NOTHING",
            params![id, receipt.to_string(), now()],
        )?;
        Ok(())
    }

    pub fn pending_assignment_receipts(&self) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,metadata FROM loop_items WHERE resource_type='assignment_receipt'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (id, raw) = row?;
            Ok((
                id,
                serde_json::from_str(&raw)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?,
            ))
        })
        .collect()
    }

    pub fn complete_assignment_receipt(&self, id: &str) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='assignment_receipt'",
            [id],
        )?;
        Ok(())
    }

    pub fn defer_assignment_receipt(
        &self,
        id: &str,
        attempts: u32,
        retry_at: &str,
    ) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.retryCount',?2,'$.nextAttemptAt',?3) WHERE id=?1 AND resource_type='assignment_receipt'",
            params![id,attempts,retry_at],
        )?;
        Ok(())
    }

    pub fn expire_assignment_receipts(&self, before: &str) -> Result<usize, TaskRuntimeError> {
        Ok(self.connection()?.execute(
            "DELETE FROM loop_items WHERE resource_type='assignment_receipt' AND created_at < ?1",
            [before],
        )?)
    }

    pub fn assignment_receipts(
        &self,
        project: &str,
        issue: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        require_receipt_issue(&connection, project, issue)?;
        initialize_receipt(&mut connection, project, issue)?;
        Ok(read_receipt(&connection, project, issue)?
            .into_iter()
            .filter(|row| row["id"].is_string())
            .collect())
    }

    pub fn acknowledge_assignment(
        &self,
        project: &str,
        issue: &str,
        assignment: &str,
        user: i64,
        stand_in: bool,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        require_receipt_issue(&connection, project, issue)?;
        initialize_receipt(&mut connection, project, issue)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            read_receipt(&transaction, project, issue)?.ok_or(TaskRuntimeError::TaskNotFound)?;
        if current["id"].as_str() != Some(assignment) {
            return Err(TaskRuntimeError::Invalid(
                "Assignment is no longer active".into(),
            ));
        }
        if current["target_id"].as_str() != Some(&user.to_string()) {
            return Err(TaskRuntimeError::Invalid(
                "Only the recipient can acknowledge an assignment".into(),
            ));
        }
        let field = if stand_in {
            "$.stand_in_received_at"
        } else {
            "$.human_read_at"
        };
        transaction.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,?2,?3) WHERE id=?1 AND resource_type='issue_receipt' AND json_type(metadata,?2) IS NOT 'text'",
            params![receipt_id(issue),field,now()],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn receipt_id(issue: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("issue-receipt:{issue}").as_bytes())
    )
}

fn require_receipt_issue(
    connection: &Connection,
    project: &str,
    issue: &str,
) -> Result<(), TaskRuntimeError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_items WHERE id=?1 AND cloud_project_id=?2 AND resource_type='task' AND deleted_at IS NULL)",
        params![issue,project], |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(TaskRuntimeError::TaskNotFound)
    }
}

fn read_receipt(
    connection: &Connection,
    project: &str,
    issue: &str,
) -> Result<Option<Value>, TaskRuntimeError> {
    let raw: Option<String> = connection.query_row(
        "SELECT metadata FROM loop_items WHERE id=?1 AND cloud_project_id=?2 AND resource_type='issue_receipt'",
        params![receipt_id(issue),project], |row| row.get(0),
    ).optional()?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    })
    .transpose()
}

fn initialize_receipt(
    connection: &mut Connection,
    project: &str,
    issue: &str,
) -> Result<(), TaskRuntimeError> {
    if read_receipt(connection, project, issue)?.is_some() {
        return Ok(());
    }
    // Only legacy Issues need a one-time projection from their existing history.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if read_receipt(&transaction, project, issue)?.is_none() {
        let item =
            get_item_from(&transaction, issue, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        sync_assignment_receipt(&transaction, project, issue, &item.metadata)?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn sync_assignment_receipt(
    connection: &Connection,
    project: &str,
    issue: &str,
    metadata: &Value,
) -> Result<(), TaskRuntimeError> {
    let history = metadata["assignment_history"].as_array();
    let row = history.and_then(|rows| rows.last().filter(|entry| entry["to_type"]=="user").map(|entry| json!({
        "id":format!("{issue}-{}",rows.len()), "target_type":"human", "target_id":entry["to_id"], "target_name":entry["to_name"],
        "receipt_tracking":entry["receipt_tracking"]==true,"human_read_at":entry["human_read_at"],"stand_in_received_at":entry["stand_in_received_at"],
    }))).unwrap_or_else(|| json!({}));
    connection.execute(
        "INSERT INTO loop_items(id,resource_type,cloud_project_id,parent_id,metadata,created_at,updated_at)
         VALUES (?1,'issue_receipt',?2,?3,?4,?5,?5)
         ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata
         WHERE json_extract(loop_items.metadata,'$.id') IS NOT json_extract(excluded.metadata,'$.id')",
        params![receipt_id(issue),project,issue,row.to_string(),now()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_receipts_initialize_once_and_survive_unrelated_issue_updates() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = store
            .create_project(
                serde_json::from_value(json!({"name":"Legacy","project_key":"LEG"})).unwrap(),
            )
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Legacy receipt","assignee_user_id":7}))
                    .unwrap(),
            )
            .unwrap();
        {
            let connection = store.connection().unwrap();
            connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.assignment_history[0].human_read_at','2026-10-27T00:00:00Z') WHERE id=?1", [&issue.id]).unwrap();
            connection
                .execute(
                    "DELETE FROM loop_items WHERE id=?1",
                    [receipt_id(&issue.id)],
                )
                .unwrap();
        }
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let initial = store.assignment_receipts(&project.id, &issue.id).unwrap();
        assert_eq!(initial[0]["human_read_at"], "2026-10-27T00:00:00Z");
        let assignment = initial[0]["id"].as_str().unwrap();
        store
            .acknowledge_assignment(&project.id, &issue.id, assignment, 7, true)
            .unwrap();
        let both = store.assignment_receipts(&project.id, &issue.id).unwrap();
        store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(json!({"version":issue.version,"title":"Updated"})).unwrap(),
            )
            .unwrap();
        assert_eq!(
            both,
            store.assignment_receipts(&project.id, &issue.id).unwrap()
        );
        drop(store);
        assert_eq!(
            both,
            LocalTaskStore::open(path)
                .unwrap()
                .assignment_receipts(&project.id, &issue.id)
                .unwrap()
        );
    }

    #[test]
    fn receipt_requests_do_not_decode_issue_metadata_and_use_primary_keys() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(
                serde_json::from_value(json!({"name":"Indexed","project_key":"IDX"})).unwrap(),
            )
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Large history","assignee_user_id":7}))
                    .unwrap(),
            )
            .unwrap();
        let assignment = store.assignment_receipts(&project.id, &issue.id).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let connection = store.connection().unwrap();
        // An unreadable history proves that receipt access never deserializes the Issue.
        connection
            .execute(
                "UPDATE loop_items SET metadata='unreadable-history' WHERE id=?1",
                [&issue.id],
            )
            .unwrap();
        let plan: String = connection
            .query_row(
                "EXPLAIN QUERY PLAN SELECT metadata FROM loop_items WHERE id=?1",
                [receipt_id(&issue.id)],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("SEARCH") && plan.contains("INDEX"), "{plan}");
        drop(connection);
        store
            .acknowledge_assignment(&project.id, &issue.id, &assignment, 7, false)
            .unwrap();
        store
            .acknowledge_assignment(&project.id, &issue.id, &assignment, 7, true)
            .unwrap();
        let row = store.assignment_receipts(&project.id, &issue.id).unwrap();
        assert!(row[0]["human_read_at"].is_string());
        assert!(row[0]["stand_in_received_at"].is_string());
    }

    #[test]
    fn assignment_receipts_are_independent_durable_and_reset_on_reassignment() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = store
            .create_project(
                serde_json::from_value::<ProjectCreate>(
                    json!({"name":"Receipts","project_key":"READ"}),
                )
                .unwrap(),
            )
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value::<TaskCreate>(
                    json!({"title":"Read me","assignee_user_id":7}),
                )
                .unwrap(),
            )
            .unwrap();
        let initial = store.assignment_receipts(&project.id, &issue.id).unwrap();
        let assignment = initial[0]["id"].as_str().unwrap();
        assert!(initial[0]["human_read_at"].is_null());
        assert!(initial[0]["stand_in_received_at"].is_null());
        assert!(store
            .acknowledge_assignment(&project.id, &issue.id, assignment, 8, false)
            .is_err());
        assert!(store
            .acknowledge_assignment("other", &issue.id, assignment, 7, false)
            .is_err());
        store
            .acknowledge_assignment(&project.id, &issue.id, assignment, 7, true)
            .unwrap();
        let received = store.assignment_receipts(&project.id, &issue.id).unwrap();
        assert!(received[0]["human_read_at"].is_null());
        assert!(received[0]["stand_in_received_at"].is_string());
        store
            .acknowledge_assignment(&project.id, &issue.id, assignment, 7, false)
            .unwrap();
        let both = store.assignment_receipts(&project.id, &issue.id).unwrap();
        store
            .acknowledge_assignment(&project.id, &issue.id, assignment, 7, false)
            .unwrap();
        assert_eq!(
            both,
            store.assignment_receipts(&project.id, &issue.id).unwrap()
        );
        assert_eq!(
            store.get_task(&project.id, &issue.id).unwrap().version,
            issue.version
        );
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        assert_eq!(
            both,
            store.assignment_receipts(&project.id, &issue.id).unwrap()
        );
        let changed = store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value::<TaskUpdate>(
                    json!({"version":issue.version,"assignee_user_id":8}),
                )
                .unwrap(),
            )
            .unwrap();
        let reassigned = store.assignment_receipts(&project.id, &issue.id).unwrap();
        assert_ne!(reassigned[0]["id"], assignment);
        assert!(reassigned[0]["human_read_at"].is_null());
        assert!(reassigned[0]["stand_in_received_at"].is_null());
        assert!(store
            .acknowledge_assignment(&project.id, &issue.id, assignment, 7, true)
            .is_err());
        store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value::<TaskUpdate>(
                    json!({"version":changed.version,"assignee_user_id":null}),
                )
                .unwrap(),
            )
            .unwrap();
        assert!(store
            .assignment_receipts(&project.id, &issue.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn assignment_receipt_outbox_survives_restart_and_deduplicates() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let receipt = json!({"assignmentId":"one","taskId":"task","userId":7});
        store.queue_assignment_receipt(&receipt).unwrap();
        store.queue_assignment_receipt(&receipt).unwrap();
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        let pending = store.pending_assignment_receipts().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, receipt);
        store.complete_assignment_receipt(&pending[0].0).unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
    }
}
