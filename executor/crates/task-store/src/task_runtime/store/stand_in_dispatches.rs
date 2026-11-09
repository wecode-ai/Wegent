//! Durable dispatch intents survive network failures and Executor restarts.
use super::*;
use sha2::{Digest, Sha256};

impl LocalTaskStore {
    pub fn queue_stand_in_dispatch(&self, intent: &Value) -> Result<String, TaskRuntimeError> {
        let id = format!(
            "stand-in-dispatch:{:x}",
            Sha256::digest(intent.to_string().as_bytes())
        );
        self.connection()?.execute(
            "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_dispatch',?2,?3,?3) ON CONFLICT(id) DO NOTHING",
            params![id, intent.to_string(), now()],
        )?;
        Ok(id)
    }

    pub fn pending_stand_in_dispatches(&self) -> Result<Vec<(String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_dispatch' ORDER BY created_at,id",
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

    pub fn complete_stand_in_dispatch(&self, id: &str) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_dispatch'",
            [id],
        )?;
        Ok(())
    }

    pub fn defer_stand_in_dispatch(&self, id: &str, code: &str) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.retryCount',COALESCE(json_extract(metadata,'$.retryCount'),0)+1,'$.lastAttemptAt',?2,'$.errorCode',?3) WHERE id=?1 AND resource_type='stand_in_dispatch'",
            params![id, Utc::now().timestamp(), code],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_cancels_only_the_owners_dispatch_intents() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let own = store.queue_stand_in_dispatch(&json!({"userId":7})).unwrap();
        let other = store.queue_stand_in_dispatch(&json!({"userId":8})).unwrap();
        store
            .transition_personal_stand_in(7, "mac", "stop")
            .unwrap();
        let pending = store.pending_stand_in_dispatches().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, other);
        assert_ne!(pending[0].0, own);
        store
            .transition_personal_stand_in(7, "mac", "stopped")
            .unwrap();
        store
            .transition_personal_stand_in(7, "mac", "start")
            .unwrap();
        assert_eq!(store.pending_stand_in_dispatches().unwrap().len(), 1);
    }
}
