//! Issue identity survives thread deletion; consumed wakeups must survive it too.
use super::*;

pub(super) fn snapshot_deleted_issue_wakeups(index: &mut RuntimeWorkIndex, task_id: &str) {
    let Some(task) = index.tasks.get(task_id) else {
        return;
    };
    let origin = &task.runtime_handle["origin"];
    if origin["type"] != "issue_dispatch" || origin["initiatedBy"] != "stand_in" {
        return;
    }
    let wakes: Vec<String> = task.runtime_handle["standInIssueWakeups"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&origin["humanAssignmentId"]))
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    // Unknown legacy grants cannot prove which event is safe to replay.
    if wakes.is_empty() {
        return;
    }
    let accepted = index
        .deleted_issue_wakeups
        .entry(task_id.into())
        .or_default();
    for wake in wakes {
        if !accepted.contains(&wake) {
            accepted.push(wake);
        }
    }
}

impl RuntimeWorkStore {
    pub(in crate::runtime_work) fn issue_conversation(&self, identity: &str) -> Option<String> {
        self.refresh_index_from_disk_if_changed();
        self.index
            .lock()
            .ok()?
            .issue_conversations
            .get(identity)
            .cloned()
    }

    /// Return None when an old deletion has no recoverable wakeup history.
    pub(in crate::runtime_work) fn deleted_issue_wakeup(
        &self,
        task: &str,
        wake: &str,
    ) -> Option<bool> {
        self.refresh_index_from_disk_if_changed();
        self.index
            .lock()
            .ok()?
            .deleted_issue_wakeups
            .get(task)
            .map(|accepted| accepted.iter().any(|id| id == wake))
    }

    pub(in crate::runtime_work) fn bind_issue_conversation(
        &self,
        identity: &str,
        task: &str,
    ) -> io::Result<()> {
        if let Some(existing) = self.issue_conversation(identity) {
            return if existing == task {
                Ok(())
            } else {
                Err(io::Error::other("Issue conversation is already bound"))
            };
        }
        self.change_issue_index(|index| {
            if let Some(existing) = index.issue_conversations.get(identity) {
                return if existing == task {
                    Ok(false)
                } else {
                    Err(io::Error::other("Issue conversation is already bound"))
                };
            }
            index
                .issue_conversations
                .insert(identity.into(), task.into());
            Ok(true)
        })
    }

    /// Clear only the task tombstone after cleanup, never the deleted thread or consumed wakes.
    pub(in crate::runtime_work) fn reopen_deleted_issue_conversation(
        &self,
        task: &str,
    ) -> io::Result<()> {
        self.change_issue_index(|index| {
            if index.tasks.contains_key(task) {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "Issue conversation cleanup is still running",
                ));
            }
            if !index.deleted_issue_wakeups.contains_key(task) {
                return Err(io::Error::other(
                    "Deleted Issue wakeup history is unavailable",
                ));
            }
            Ok(index.deleted_archived_task_ids.remove(task).is_some())
        })
    }

    pub(super) fn change_issue_index(
        &self,
        change: impl FnOnce(&mut RuntimeWorkIndex) -> io::Result<bool>,
    ) -> io::Result<()> {
        self.refresh_index_from_disk_if_changed();
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| io::Error::other("Runtime index lock is poisoned"))?;
        let mut current = self
            .index
            .lock()
            .map_err(|_| io::Error::other("Runtime index lock is poisoned"))?;
        let mut next = current.clone();
        if !change(&mut next)? {
            return Ok(());
        }
        let payload = serialize_index(&next)?;
        atomic_write_file(&self.index_path, &payload)?;
        *current = next;
        drop(current);
        *self
            .last_written_payload
            .lock()
            .map_err(|_| io::Error::other("Runtime payload lock is poisoned"))? = Some(payload);
        self.update_index_signature();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_issue_wakeups_outlive_task_tombstone_retention() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.json");
        let store = RuntimeWorkStore::new(path.clone());
        store.upsert_task(RuntimeTaskLink {
            local_task_id: "issue".into(),
            runtime_handle: serde_json::json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","humanAssignmentId":"accepted"}}),
            ..RuntimeTaskLink::default()
        });
        store
            .mark_deleted_archived_task_ids(["issue".into()])
            .unwrap();
        store.delete_task("issue");
        let mut persisted: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        persisted["deleted_archived_task_ids"]["issue"] =
            Value::from(current_time_ms() - DELETED_ARCHIVED_TASK_ID_TTL_MS - 1);
        fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();
        let reopened = RuntimeWorkStore::new(path);
        assert!(!reopened.is_deleted_archived_task_id("issue"));
        assert_eq!(
            reopened.deleted_issue_wakeup("issue", "accepted"),
            Some(true)
        );
        assert_eq!(reopened.deleted_issue_wakeup("issue", "new"), Some(false));
    }
}
