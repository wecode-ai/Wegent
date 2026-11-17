//! Preserve telemetry ordering without retaining the task-index mutex during SQLite writes.
use super::super::stand_in_telemetry::{observe, Observation};
use super::*;
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Telemetry {
    path: Mutex<Option<PathBuf>>,
    pending: Mutex<VecDeque<(PathBuf, Observation)>>,
    flush: Mutex<()>,
}

impl RuntimeWorkStore {
    pub fn set_telemetry_path(&self, path: PathBuf) {
        if let Ok(mut target) = self.telemetry.path.lock() {
            *target = Some(path);
        }
    }

    /// Enqueue while the index is locked, so concurrent transitions retain their order.
    pub(super) fn enqueue_stand_in(&self, observation: Option<Observation>) {
        let Some(observation) = observation else {
            return;
        };
        let path = self
            .telemetry
            .path
            .lock()
            .ok()
            .and_then(|path| path.clone());
        if let Some(path) = path {
            if let Ok(mut pending) = self.telemetry.pending.lock() {
                pending.push_back((path, observation));
            }
        }
    }

    /// One caller drains; other writers can publish their state without waiting for SQLite.
    pub(super) fn flush_stand_in(&self) {
        let Ok(flush) = self.telemetry.flush.try_lock() else {
            return;
        };
        loop {
            let Ok(mut pending) = self.telemetry.pending.lock() else {
                return;
            };
            let Some((path, observation)) = pending.pop_front() else {
                // Release ownership before allowing a new producer to enqueue its event.
                drop(flush);
                drop(pending);
                return;
            };
            drop(pending);
            observe(&path, observation);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::LocalTaskStore;

    #[test]
    fn deferred_telemetry_preserves_transition_order() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let facts = LocalTaskStore::open(&path).unwrap();
        facts.configure_stand_in_telemetry(7, true, None).unwrap();
        let store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        store.set_telemetry_path(path);
        let flush = store.telemetry.flush.lock().unwrap();
        let mut task = RuntimeTaskLink::new_pending("task".into(), "".into(), "".into());
        task.runtime_handle = serde_json::json!({"origin":{"initiatedBy":"stand_in_identity","userId":7},"lastTurnId":"turn"});
        task.running = true;
        store.upsert_task(task);
        store.update_task("task", |task| {
            task.running = false;
            task.status = "done".into();
        });
        assert_eq!(store.list_task_summaries(false)[0].status, "done");
        assert!(facts.list_stand_in_telemetry(7).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let started_at = chrono::Utc::now().timestamp_millis() - 10_000;
        {
            let mut pending = store.telemetry.pending.lock().unwrap();
            pending[0].1.occurred_at = started_at;
            pending[1].1.occurred_at = started_at + 4_000;
        }
        drop(flush);
        store.flush_stand_in();
        let events = facts.list_stand_in_telemetry(7).unwrap();
        assert_eq!(events["items"].as_array().unwrap().len(), 2);
        assert_eq!(events["items"][0]["name"], "stand_in_execution_started");
        assert_eq!(events["items"][1]["name"], "stand_in_execution_completed");
        assert_eq!(events["items"][0]["occurredAt"], started_at);
        assert_eq!(events["items"][1]["occurredAt"], started_at + 4_000);
        assert_eq!(events["items"][1]["properties"]["duration_ms"], 4_000);
    }
}
