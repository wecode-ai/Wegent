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

    pub fn assignment_receipts(
        &self,
        project: &str,
        issue: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let item = self.get_task(project, issue)?;
        let Some(history) = item.metadata["assignment_history"].as_array() else {
            return Ok(Vec::new());
        };
        let Some(entry) = history.last().filter(|entry| entry["to_type"] == "user") else {
            return Ok(Vec::new());
        };
        Ok(vec![json!({
            "id": format!("{issue}-{}", history.len()),
            "target_type": "human", "target_id": entry["to_id"],
            "target_name": entry["to_name"],
            "receipt_tracking": entry["receipt_tracking"] == true,
            "human_read_at": entry["human_read_at"],
            "stand_in_received_at": entry["stand_in_received_at"],
        })])
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
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut item = get_item_from(&transaction, issue, "task")?
            .filter(|item| item.cloud_project_id.as_deref() == Some(project))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let history = item.metadata["assignment_history"]
            .as_array_mut()
            .ok_or_else(|| TaskRuntimeError::Invalid("Assignment is unavailable".into()))?;
        if format!("{issue}-{}", history.len()) != assignment {
            return Err(TaskRuntimeError::Invalid(
                "Assignment is no longer active".into(),
            ));
        }
        let entry = history.last_mut().ok_or(TaskRuntimeError::TaskNotFound)?;
        if entry["to_type"] != "user" || entry["to_id"].as_str() != Some(&user.to_string()) {
            return Err(TaskRuntimeError::Invalid(
                "Only the recipient can acknowledge an assignment".into(),
            ));
        }
        let key = if stand_in {
            "stand_in_received_at"
        } else {
            "human_read_at"
        };
        if !entry[key].is_string() {
            entry[key] = json!(now());
            transaction.execute(
                "UPDATE loop_items SET metadata=?2 WHERE id=?1",
                params![issue, item.metadata.to_string()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
