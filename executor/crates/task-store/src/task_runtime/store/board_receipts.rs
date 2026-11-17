//! Receipts share the mutation transaction and the existing unified node store.

use super::*;
use serde::{de::DeserializeOwned, Serialize};

#[derive(Clone, Debug)]
pub struct BoardWriteReceipt {
    pub id: String,
    pub owner: String,
    pub payload: String,
}

impl BoardWriteReceipt {
    pub(super) fn replay<T: DeserializeOwned>(
        &self,
        connection: &Connection,
    ) -> Result<Option<T>, TaskRuntimeError> {
        let Some(value) = read(connection, &self.id, &self.owner)? else {
            return Ok(None);
        };
        if value["payload"] != self.payload {
            return Err(TaskRuntimeError::Invalid("idempotency_conflict".into()));
        }
        serde_json::from_value(value["result"].clone())
            .map(Some)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    }

    pub(super) fn record<T: Serialize>(
        &self,
        connection: &Connection,
        value: &T,
    ) -> Result<(), TaskRuntimeError> {
        save(
            connection,
            &self.id,
            &self.owner,
            &json!({"payload":self.payload,"result":value}),
        )
    }
}

fn read(connection: &Connection, id: &str, owner: &str) -> Result<Option<Value>, TaskRuntimeError> {
    prune(connection, owner)?;
    let value = connection.query_row(
        "SELECT metadata FROM loop_items WHERE id=?1 AND resource_type='node' AND kind='board_operation' AND name=?2",
        params![id, owner], |row| row.get::<_,String>(0),
    ).optional()?;
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .transpose()
}

fn prune(connection: &Connection, owner: &str) -> Result<(), TaskRuntimeError> {
    let mut statement = connection.prepare("SELECT id,metadata FROM loop_items WHERE resource_type='node' AND kind='board_operation' AND name=?1 AND json_extract(metadata,'$.expires_at') < ?2 AND json_extract(metadata,'$.state') != 'expired'")?;
    let rows = statement
        .query_map(params![owner, chrono::Local::now().timestamp()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, value) in rows {
        let value: Value = serde_json::from_str(&value)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        save(
            connection,
            &id,
            owner,
            &json!({"payload":value["payload"],"expires_at":value["expires_at"],"state":"expired"}),
        )?;
    }
    connection.execute("DELETE FROM loop_items WHERE resource_type='node' AND kind='board_operation' AND name=?1 AND json_type(metadata,'$.expires_at') IS NULL AND julianday(created_at) < julianday('now','-30 days')", [owner])?;
    Ok(())
}

fn save(
    connection: &Connection,
    id: &str,
    owner: &str,
    value: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute(
        "INSERT INTO loop_items (id,resource_type,kind,name,metadata,created_at,updated_at)
         VALUES (?1,'node','board_operation',?2,?3,?4,?4)
         ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at
         WHERE loop_items.resource_type='node' AND loop_items.kind='board_operation' AND loop_items.name=excluded.name",
        params![id,owner,value.to_string(),now()],
    )?;
    Ok(())
}

impl LocalTaskStore {
    pub fn board_operation(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        read(&*self.connection()?, id, owner)
    }

    pub fn save_board_operation(
        &self,
        id: &str,
        owner: &str,
        value: &Value,
    ) -> Result<(), TaskRuntimeError> {
        save(&*self.connection()?, id, owner, value)
    }

    pub fn claim_board_operation(
        &self,
        id: &str,
        owner: &str,
        value: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        let connection = self.connection()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO loop_items (id,resource_type,kind,name,metadata,created_at,updated_at)
             VALUES (?1,'node','board_operation',?2,?3,?4,?4)",
            params![id,owner,value.to_string(),now()],
        )?;
        Ok(inserted == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_failure_rolls_back_the_domain_write_and_sequence() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Atomic board".into(),
                project_key: Some("ATOMIC".into()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let receipt = BoardWriteReceipt {
            id: "receipt".into(),
            owner: "owner".into(),
            payload: "payload".into(),
        };
        store.connection().unwrap().execute_batch("CREATE TRIGGER reject_test_receipt BEFORE INSERT ON loop_items WHEN NEW.kind='board_operation' BEGIN SELECT RAISE(ABORT,'Injected receipt failure'); END;").unwrap();
        let input =
            || serde_json::from_value::<TaskCreate>(json!({"title":"Atomic issue"})).unwrap();
        assert!(store
            .create_task_with_receipt(&project.id, input(), None, None, Some(&receipt))
            .is_err());
        assert!(store.list_tasks(&project.id).unwrap().is_empty());
        assert!(store.board_operation("receipt", "owner").unwrap().is_none());
        store
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_test_receipt")
            .unwrap();
        let created = store
            .create_task_with_receipt(&project.id, input(), None, None, Some(&receipt))
            .unwrap();
        assert_eq!(created.sequence_number, Some(1));
        let replayed = store
            .create_task_with_receipt(&project.id, input(), None, None, Some(&receipt))
            .unwrap();
        assert_eq!(created.id, replayed.id);
        assert_eq!(store.list_tasks(&project.id).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::*;

    #[test]
    fn expired_roots_keep_the_fingerprint_without_request_or_results() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        store.save_board_operation("root","owner",&json!({"state":"completed","payload":"fingerprint","expires_at":1,"request":{"body":"private"},"results":[{"secret":"private"}]})).unwrap();
        let value = store.board_operation("root", "owner").unwrap().unwrap();
        assert_eq!(
            value,
            json!({"state":"expired","payload":"fingerprint","expires_at":1})
        );
        assert!(!store
            .claim_board_operation("root", "owner", &json!({}))
            .unwrap());
    }
}
