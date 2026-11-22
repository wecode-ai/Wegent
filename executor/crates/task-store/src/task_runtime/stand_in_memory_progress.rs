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

pub(super) fn read(
    connection: &Connection,
    user: i64,
    source: &str,
) -> Result<Value, TaskRuntimeError> {
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

fn finish_coverage(state: &mut Value) {
    let Some(since) = state["reviewCoverageSince"].as_i64() else {
        return;
    };
    let Some(through) = state["reviewThrough"].as_i64() else {
        return;
    };
    if state["coverageIntervals"].is_null() {
        state["coverageIntervals"] = json!([]);
    }
    let Some(intervals) = state["coverageIntervals"].as_array_mut() else {
        return;
    };
    if let Some(last) = intervals
        .last_mut()
        .filter(|range| range[1].as_i64() == Some(since))
    {
        last[1] = json!(through);
    } else {
        intervals.push(json!([since, through]));
    }
}

impl LocalTaskStore {
    pub fn observed_training_issues(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let db = self.connection()?;
        let mut query = db.prepare_cached(
            "SELECT DISTINCT roles.value,json_extract(metadata,'$.projectId'),
                    json_extract(metadata,'$.projectStore'),json_extract(metadata,'$.issueId')
             FROM loop_items,json_each(metadata,'$.roleIds') roles
             WHERE resource_type='stand_in_event' AND json_extract(metadata,'$.userId')=?1
               AND json_extract(metadata,'$.kind')='assignment'
               AND json_extract(metadata,'$.projectStore') IN ('local','cloud')",
        )?;
        let rows = query.query_map([user], |row| {
            Ok(json!({
                "role":row.get::<_,Option<String>>(0)?, "project":row.get::<_,Option<String>>(1)?,
                "store":row.get::<_,Option<String>>(2)?, "issue":row.get::<_,Option<String>>(3)?
            }))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    /// The source generation is part of the review cursor and its observation intervals.
    pub fn training_source_id(role: &str, source: &Value) -> String {
        use super::personal_stand_in::{connection_memory_scope, source_collection_namespace};
        let mut key = json!([
            role,
            connection_memory_scope(source),
            source["transport"],
            source_collection_namespace(source),
            source["enabledAfter"]
        ]);
        if source["providerId"] == super::personal_stand_in::ISSUE_COMMENTS_PROVIDER {
            key.as_array_mut()
                .unwrap()
                .push(source["projectId"].clone());
        }
        // Collected events never share watermarks or coverage with native history.
        if source["collectedObservations"] == true {
            key.as_array_mut()
                .unwrap()
                .push(json!("collectedObservations"));
        }
        format!("training-source:{}", Self::coordination_event_version(&key))
    }

    pub fn memory_review_progress(
        &self,
        user: i64,
        source: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        read(&connection, user, source)
    }

    // The checkpoint and its evidence boundary must be committed in the same transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn record_memory_review_page(
        &self,
        user: i64,
        source: &str,
        run: &str,
        through: i64,
        version: i64,
        pending: Value,
        coverage_since: Option<i64>,
    ) -> Result<Value, TaskRuntimeError> {
        if run.is_empty()
            || source.is_empty()
            || coverage_since.is_some_and(|since| since < 0 || since >= through)
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
        let first_page = state["runId"] != run || state["readStarted"] != true;
        // Once any page has a gap, the whole attempted interval remains unverified.
        if first_page {
            state["reviewCoverageSince"] = json!(coverage_since);
        } else if state["reviewCoverageSince"].as_i64() != coverage_since {
            state["reviewCoverageSince"] = Value::Null;
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
        if state["runId"] != run && !pending {
            return Err(TaskRuntimeError::VersionConflict);
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
        rework_review_complete: bool,
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
        if rework_review_complete {
            finish_coverage(&mut state);
        }
        state.as_object_mut().unwrap().remove("reviewCoverageSince");
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
    fn rework_intervals_require_all_pages_and_committed_semantic_review() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let checkpoint = |run, through, pending, since| {
            let version = store.memory_review_progress(7, "chat").unwrap()["version"]
                .as_i64()
                .unwrap();
            store
                .record_memory_review_page(7, "chat", run, through, version, pending, since)
                .unwrap();
        };
        let complete = |run, reviewed| {
            let version = store.memory_review_progress(7, "chat").unwrap()["version"]
                .as_i64()
                .unwrap();
            store
                .complete_memory_review_source(7, "chat", run, version, reviewed)
                .unwrap()["coverageIntervals"]
                .clone()
        };
        checkpoint("one", 20, json!([]), Some(10));
        assert_eq!(complete("one", true), json!([[10, 20]]));
        checkpoint("two", 30, json!([]), Some(20));
        assert_eq!(complete("two", true), json!([[10, 30]]));
        checkpoint("partial", 40, json!(["cursor"]), None);
        checkpoint("partial", 40, json!([]), Some(30));
        assert_eq!(complete("partial", true), json!([[10, 30]]));
        checkpoint("unclear", 50, json!([]), Some(40));
        assert_eq!(complete("unclear", false), json!([[10, 30]]));
        checkpoint("incomplete", 60, json!(["cursor"]), Some(50));
        assert_eq!(
            store.memory_review_progress(7, "chat").unwrap()["coverageIntervals"],
            json!([[10, 30]])
        );
        checkpoint("retry", 70, json!([]), Some(50));
        assert_eq!(complete("retry", true), json!([[10, 30], [50, 70]]));
    }

    #[test]
    fn memory_progress_retains_pending_writes_across_restart_and_read_pages() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        store
            .record_memory_review_page(7, "chat", "run", 100, 0, json!([]), None)
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
                None,
            )
            .unwrap();
        assert!(store
            .complete_memory_review_source(
                7,
                "chat",
                "run",
                state["version"].as_i64().unwrap(),
                false
            )
            .is_err());
        store
            .record_memory_review_write(7, "chat", "run", "fact", false)
            .unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        let completed = store
            .complete_memory_review_source(
                7,
                "chat",
                "run",
                state["version"].as_i64().unwrap(),
                false,
            )
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
            .complete_memory_review_source(7, "chat", "run", 0, false)
            .is_err());
        store
            .record_memory_review_page(
                7,
                "chat",
                "run",
                100,
                0,
                json!([{"beforeCursor":"older"}]),
                None,
            )
            .unwrap();
        assert!(store
            .complete_memory_review_source(7, "chat", "run", 1, false)
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
            .record_memory_review_page(7, "chat", "retry", 200, 0, json!([]), None)
            .is_err());
        store
            .record_memory_review_page(7, "chat", "retry", 200, 1, json!([]), None)
            .unwrap();
        assert!(store
            .complete_memory_review_source(7, "chat", "run", 2, false)
            .is_err());
        let completed = store
            .complete_memory_review_source(7, "chat", "retry", 2, false)
            .unwrap();
        assert_eq!(completed["completedThrough"], 200);
        assert!(store
            .record_memory_review_page(7, "chat", "old", 100, 3, json!([]), None)
            .is_err());
        assert!(store
            .complete_memory_review_source(7, "chat", "retry", 3, false)
            .is_err());
    }
}
