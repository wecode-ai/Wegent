//! Source-level consolidation checkpoints never advance on reads or failed runs.
use super::*;

const RESOURCE: &str = "stand_in_memory_progress";

fn key(user: i64, source: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "memory-progress:{:x}",
        Sha256::digest(json!([user, source]).to_string())
    )
}

fn read(connection: &Connection, user: i64, source: &str) -> Result<Value, TaskRuntimeError> {
    Ok(get_item_from(connection, &key(user, source), RESOURCE)?
        .map(|row| row.metadata)
        .unwrap_or_else(|| json!({"userId":user,"source":source,"version":0,"completedThrough":0})))
}

fn write(
    connection: &Connection,
    user: i64,
    source: &str,
    value: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
        params![key(user, source), RESOURCE, value.to_string(), now()])?;
    Ok(())
}

fn start_run(state: &mut Value, run: &str) {
    if state["runId"] != run {
        state["runId"] = json!(run);
        state["readStarted"] = json!(false);
        state["pendingWrites"] = json!([]);
    }
}

impl LocalTaskStore {
    pub fn memory_review_progress(
        &self,
        user: i64,
        source: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        read(&connection, user, source)
    }

    pub fn record_memory_review_page(
        &self,
        user: i64,
        source: &str,
        run: &str,
        through: i64,
        version: i64,
        pending: Value,
    ) -> Result<Value, TaskRuntimeError> {
        if run.is_empty()
            || source.is_empty()
            || through <= 0
            || !pending.as_array().is_some_and(|rows| rows.len() <= 100)
            || pending.to_string().len() > 1_000_000
        {
            return Err(TaskRuntimeError::Invalid(
                "Invalid memory review checkpoint".into(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read(&connection, user, source)?;
        if state["version"] != version || through < state["completedThrough"].as_i64().unwrap_or(0)
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        start_run(&mut state, run);
        state["reviewThrough"] = json!(through);
        state["pending"] = pending;
        state["readStarted"] = json!(true);
        state["version"] = json!(version + 1);
        write(&connection, user, source, &state)?;
        connection.commit()?;
        Ok(state)
    }

    pub fn record_memory_review_write(
        &self,
        user: i64,
        source: &str,
        run: &str,
        write_id: &str,
        pending: bool,
    ) -> Result<(), TaskRuntimeError> {
        if source.is_empty() || run.is_empty() || write_id.is_empty() || write_id.len() > 128 {
            return Err(TaskRuntimeError::Invalid(
                "Invalid memory write checkpoint".into(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read(&connection, user, source)?;
        if state["runId"] != run {
            if !pending {
                return Err(TaskRuntimeError::VersionConflict);
            }
        }
        start_run(&mut state, run);
        let mut writes = state["pendingWrites"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        writes.retain(|id| id != write_id);
        if pending {
            if writes.len() >= 1000 {
                return Err(TaskRuntimeError::Invalid(
                    "Too many pending memory writes".into(),
                ));
            }
            writes.push(json!(write_id));
        }
        state["pendingWrites"] = json!(writes);
        state["version"] = json!(state["version"].as_i64().unwrap_or(0) + 1);
        write(&connection, user, source, &state)?;
        connection.commit()?;
        Ok(())
    }

    pub fn complete_memory_review_source(
        &self,
        user: i64,
        source: &str,
        run: &str,
        version: i64,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read(&connection, user, source)?;
        if state["version"] != version
            || state["runId"] != run
            || state["readStarted"] != true
            || !state["pending"].as_array().is_some_and(Vec::is_empty)
            || state["pendingWrites"]
                .as_array()
                .is_some_and(|writes| !writes.is_empty())
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        state["completedThrough"] = state["reviewThrough"].clone();
        state["readStarted"] = json!(false);
        state["version"] = json!(version + 1);
        write(&connection, user, source, &state)?;
        connection.commit()?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_progress_retains_pending_writes_across_restart_and_read_pages() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        store
            .record_memory_review_page(7, "chat", "run", 100, 0, json!([]))
            .unwrap();
        store
            .record_memory_review_write(7, "chat", "run", "fact", true)
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        assert_eq!(state["pendingWrites"], json!(["fact"]));
        let state = store
            .record_memory_review_page(
                7,
                "chat",
                "run",
                100,
                state["version"].as_i64().unwrap(),
                json!([]),
            )
            .unwrap();
        assert!(store
            .complete_memory_review_source(7, "chat", "run", state["version"].as_i64().unwrap())
            .is_err());
        store
            .record_memory_review_write(7, "chat", "run", "fact", false)
            .unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        let completed = store
            .complete_memory_review_source(7, "chat", "run", state["version"].as_i64().unwrap())
            .unwrap();
        assert_eq!(completed["completedThrough"], 100);
        store
            .record_memory_review_write(7, "chat", "next", "fact", true)
            .unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        assert_eq!(state["readStarted"], false);
        assert_eq!(state["completedThrough"], 100);
        assert!(store
            .record_memory_review_write(7, "chat", "run", "fact", false)
            .is_err());
    }

    #[test]
    fn memory_progress_requires_all_pages_and_survives_failure_and_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        assert!(store
            .complete_memory_review_source(7, "chat", "run", 0)
            .is_err());
        store
            .record_memory_review_page(7, "chat", "run", 100, 0, json!([{"beforeCursor":"older"}]))
            .unwrap();
        assert!(store
            .complete_memory_review_source(7, "chat", "run", 1)
            .is_err());
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        assert_eq!(state["completedThrough"], 0);
        assert_eq!(state["pending"][0]["beforeCursor"], "older");
        assert_eq!(
            store.memory_review_progress(8, "chat").unwrap()["version"],
            0
        );
        assert!(store
            .record_memory_review_page(7, "chat", "retry", 200, 0, json!([]))
            .is_err());
        store
            .record_memory_review_page(7, "chat", "retry", 200, 1, json!([]))
            .unwrap();
        assert!(store
            .complete_memory_review_source(7, "chat", "run", 2)
            .is_err());
        let completed = store
            .complete_memory_review_source(7, "chat", "retry", 2)
            .unwrap();
        assert_eq!(completed["completedThrough"], 200);
        assert!(store
            .record_memory_review_page(7, "chat", "old", 100, 3, json!([]))
            .is_err());
        assert!(store
            .complete_memory_review_source(7, "chat", "retry", 3)
            .is_err());
    }
}
