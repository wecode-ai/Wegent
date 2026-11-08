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
        state["attachments"] = json!({});
    }
}

impl LocalTaskStore {
    /// Host-created interpretation only; current source access is checked by the reader.
    pub fn cache_memory_image_observation(
        &self,
        user: i64,
        source: &str,
        run: &str,
        version: i64,
        original_hash: &str,
        content: &str,
    ) -> Result<(), TaskRuntimeError> {
        if source.is_empty() || run.is_empty() || original_hash.len() != 64
            || !original_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || content.trim().is_empty() || content.len() > 8192
        {
            return Err(TaskRuntimeError::Invalid("Invalid image observation cache".into()));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read(&connection, user, source)?;
        if state["version"] != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let previous = &state["imageObservation"];
        if previous["originalContentHash"] == original_hash && previous["content"] != content {
            return Err(TaskRuntimeError::VersionConflict);
        }
        state["imageObservation"] = json!({"originalContentHash":original_hash,
            "content":content,"originRun":run});
        state["version"] = json!(version + 1);
        write(&connection, user, source, &state)?;
        connection.commit()?;
        Ok(())
    }

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

    pub fn record_memory_attachment_read(
        &self,
        user: i64,
        source: &str,
        run: &str,
        attachment: &str,
        chunk: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let hash = chunk["contentHash"]
            .as_str()
            .filter(|hash| hash.len() == 64)
            .ok_or_else(|| TaskRuntimeError::Invalid("Invalid attachment hash".into()))?;
        let offset = chunk["offset"]
            .as_u64()
            .ok_or(TaskRuntimeError::VersionConflict)?;
        let total = chunk["totalContentBytes"]
            .as_u64()
            .ok_or(TaskRuntimeError::VersionConflict)?;
        let end = offset
            .checked_add(
                chunk["content"]
                    .as_str()
                    .ok_or(TaskRuntimeError::VersionConflict)?
                    .len() as u64,
            )
            .filter(|end| *end <= total)
            .ok_or(TaskRuntimeError::VersionConflict)?;
        if source.is_empty() || run.is_empty() || attachment.is_empty() || attachment.len() > 128 {
            return Err(TaskRuntimeError::Invalid(
                "Invalid attachment checkpoint".into(),
            ));
        }
        let observation = chunk.get("imageObservation");
        if let Some(observation) = observation {
            if chunk["evidenceKind"] != "image_observation"
                || !observation.as_str().is_some_and(|text| !text.is_empty() && text.len() <= 8192)
                || observation.as_str().map(str::len) != Some(total as usize)
                || observation.as_str().and_then(|text| text.get(offset as usize..end as usize))
                    != chunk["content"].as_str()
            {
                return Err(TaskRuntimeError::Invalid("Invalid image observation".into()));
            }
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read(&connection, user, source)?;
        start_run(&mut state, run);
        if !state["attachments"].is_object() {
            state["attachments"] = json!({});
        }
        let previous = &state["attachments"][attachment];
        let same = previous["contentHash"] == hash && previous["totalContentBytes"] == total;
        if same && previous["imageObservation"].is_string()
            && observation != previous.get("imageObservation") {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let through = if same {
            previous["readThrough"].as_u64().unwrap_or(0)
        } else {
            0
        };
        if offset > through || (!same && offset != 0) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if previous.is_null() && state["attachments"].as_object().unwrap().len() >= 1000 {
            return Err(TaskRuntimeError::Invalid(
                "Too many attachment checkpoints".into(),
            ));
        }
        state["attachments"][attachment] =
            json!({"contentHash":hash,"totalContentBytes":total,"readThrough":through.max(end)});
        if let Some(observation) = observation {
            state["attachments"][attachment]["imageObservation"] = observation.clone();
        }
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

    pub fn complete_memory_evidence(
        &self,
        user: i64,
        source: &str,
        run: &str,
        hash: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = read(&connection, user, source)?;
        let evidence = &state["attachments"]["evidence"];
        if hash.len() != 64
            || state["runId"] != run
            || evidence["contentHash"] != hash
            || !evidence["totalContentBytes"].is_u64()
            || evidence["readThrough"] != evidence["totalContentBytes"]
            || state["pendingWrites"]
                .as_array()
                .is_some_and(|writes| !writes.is_empty())
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        state["completedContentHash"] = json!(hash);
        state["version"] = json!(state["version"].as_i64().unwrap_or(0) + 1);
        write(&connection, user, source, &state)?;
        connection.commit()?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_project_image_cache_is_source_scoped_persistent_and_revision_checked() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let hash = "a".repeat(64);
        store.cache_memory_image_observation(7, "project:file", "run", 0, &hash, "fact").unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let state = store.memory_review_progress(7, "project:file").unwrap();
        assert_eq!(state["imageObservation"]["content"], "fact");
        assert_eq!(state["imageObservation"]["originalContentHash"], hash);
        for (user, source) in [(8, "project:file"), (7, "other:file")] {
            assert!(store.memory_review_progress(user, source).unwrap()["imageObservation"].is_null());
        }
        assert!(store.cache_memory_image_observation(7, "project:file", "next", 0, &hash, "fact").is_err());
        assert!(store.cache_memory_image_observation(7, "project:file", "next", 1, &hash, "changed interpretation").is_err());
        assert!(store.cache_memory_image_observation(7, "project:file", "next", 1, &hash, &"x".repeat(8193)).is_err());
        let chunk = json!({"contentHash":"b".repeat(64),"offset":0,"totalContentBytes":4,"content":"fact"});
        store.record_memory_attachment_read(7, "project:file", "next", "evidence", &chunk).unwrap();
        let state = store.memory_review_progress(7, "project:file").unwrap();
        assert_eq!(state["runId"], "next");
        assert_eq!(state["imageObservation"]["content"], "fact");
        store.cache_memory_image_observation(7, "project:file", "next", 2, &"c".repeat(64), "new bytes").unwrap();
        assert_eq!(store.memory_review_progress(7, "project:file").unwrap()["imageObservation"]["content"], "new bytes");
    }

    #[test]
    fn memory_image_observation_is_run_bound_and_survives_restart_without_source_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let mut chunk = json!({"contentHash":"a".repeat(64),"offset":0,
            "totalContentBytes":4,"content":"fact","evidenceKind":"image_observation",
            "imageObservation":"fact"});
        store.record_memory_attachment_read(7,"chat","run","image",&chunk).unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let state = store.memory_review_progress(7,"chat").unwrap();
        assert_eq!(state["attachments"]["image"]["imageObservation"],"fact");
        assert!(!state.to_string().contains("dataUrl"));
        assert!(store.memory_review_progress(8,"chat").unwrap()["attachments"].is_null());
        chunk["imageObservation"] = json!("fake");
        assert!(store.record_memory_attachment_read(7,"chat","run","image",&chunk).is_err());
        chunk["content"] = json!("fake");
        assert!(store.record_memory_attachment_read(7,"chat","run","image",&chunk).is_err());
        chunk["contentHash"] = json!("b".repeat(64));
        store.record_memory_attachment_read(7,"chat","next","image",&chunk).unwrap();
        let state = store.memory_review_progress(7,"chat").unwrap();
        assert_eq!(state["runId"],"next");
        assert_eq!(state["attachments"]["image"]["imageObservation"],"fake");
        chunk["imageObservation"] = json!("x".repeat(8193));
        assert!(store.record_memory_attachment_read(7,"chat","next","image",&chunk).is_err());
    }

    #[test]
    fn memory_evidence_completion_requires_full_reads_and_settled_writes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let hash = "a".repeat(64);
        let page = |offset| json!({"contentHash":hash,"offset":offset,"content":"abcd","totalContentBytes":8});
        assert!(store
            .complete_memory_evidence(7, "project:one", "run", &hash)
            .is_err());
        store
            .record_memory_attachment_read(7, "project:one", "run", "evidence", &page(0))
            .unwrap();
        assert!(store
            .complete_memory_evidence(7, "project:one", "run", &hash)
            .is_err());
        store
            .record_memory_attachment_read(7, "project:one", "run", "evidence", &page(4))
            .unwrap();
        store
            .record_memory_review_write(7, "project:one", "run", "fact", true)
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        assert!(store
            .complete_memory_evidence(7, "project:one", "run", &hash)
            .is_err());
        store
            .record_memory_review_write(7, "project:one", "run", "fact", false)
            .unwrap();
        assert!(store
            .complete_memory_evidence(7, "project:one", "other-run", &hash)
            .is_err());
        assert!(store
            .complete_memory_evidence(8, "project:one", "run", &hash)
            .is_err());
        assert!(store
            .complete_memory_evidence(7, "project:other", "run", &hash)
            .is_err());
        assert!(store
            .complete_memory_evidence(7, "project:one", "run", &"b".repeat(64))
            .is_err());
        let done = store
            .complete_memory_evidence(7, "project:one", "run", &hash)
            .unwrap();
        assert_eq!(done["completedContentHash"], hash);
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        assert_eq!(
            store.memory_review_progress(7, "project:one").unwrap()["completedContentHash"],
            hash
        );
        store
            .record_memory_attachment_read(7, "project:one", "next", "evidence", &page(0))
            .unwrap();
        assert!(store
            .complete_memory_evidence(7, "project:one", "next", &hash)
            .is_err());
    }

    #[test]
    fn memory_attachment_progress_rejects_gaps_and_preserves_contiguous_reads_after_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let chunk = |offset, hash: &str| json!({"offset":offset,"contentHash":hash.repeat(64),"totalContentBytes":8,"content":"abcd"});
        assert!(store
            .record_memory_attachment_read(7, "chat", "run", "file", &chunk(4, "a"))
            .is_err());
        store
            .record_memory_attachment_read(7, "chat", "run", "file", &chunk(0, "a"))
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        assert_eq!(state["attachments"]["file"]["readThrough"], 4);
        assert_eq!(state["completedThrough"], 0);
        assert!(store
            .record_memory_attachment_read(7, "chat", "run", "file", &chunk(4, "b"))
            .is_err());
        store
            .record_memory_attachment_read(7, "chat", "run", "file", &chunk(4, "a"))
            .unwrap();
        store
            .record_memory_attachment_read(7, "chat", "run", "file", &chunk(0, "a"))
            .unwrap();
        assert_eq!(
            store.memory_review_progress(7, "chat").unwrap()["attachments"]["file"]["readThrough"],
            8
        );
        assert!(store
            .record_memory_attachment_read(7, "chat", "next", "file", &chunk(4, "a"))
            .is_err());
        store
            .record_memory_attachment_read(7, "chat", "next", "file", &chunk(0, "b"))
            .unwrap();
        let state = store.memory_review_progress(7, "chat").unwrap();
        assert_eq!(state["attachments"]["file"]["readThrough"], 4);
        assert_eq!(state["readStarted"], false);
        assert!(store.memory_review_progress(8, "chat").unwrap()["attachments"].is_null());
    }

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
