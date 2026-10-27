//! Observe persisted Runtime transitions independently of connected desktop windows.
use super::response::RuntimeTaskLink;
use crate::task_runtime::{
    stand_in_telemetry::origin_properties, LocalTaskStore, TaskRuntimeError,
};
use serde_json::Value;
use std::path::Path;

pub(super) fn observe(path: &Path, link: &RuntimeTaskLink) {
    let origin = &link.runtime_handle["origin"];
    if !matches!(
        origin["initiatedBy"].as_str(),
        Some("stand_in" | "stand_in_identity")
    ) {
        return;
    }
    let Some(user) = origin["userId"].as_i64() else {
        return;
    };
    let result = match (link.status.as_str(), link.turn_status.as_deref()) {
        ("cancelled", _) | (_, Some("interrupted")) => Some("cancelled"),
        ("failed", _) | (_, Some("failed")) => Some("failure"),
        ("done", _) | (_, Some("completed")) => Some("success"),
        _ => None,
    };
    let turn = link
        .runtime_handle
        .get("lastTurnId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let waiting = matches!(
        link.interaction_status.as_deref(),
        Some("waitingForUserInput" | "awaitingUserReply")
    );
    let outcome = LocalTaskStore::open(path).and_then(|store| {
        store.observe_stand_in_run(
            user,
            &link.local_task_id,
            turn,
            link.running,
            waiting,
            result,
            &origin_properties(origin),
        )
    });
    diagnose(outcome);
}

pub(crate) fn diagnose(result: Result<(), TaskRuntimeError>) {
    if result.is_err() {
        crate::logging::log_executor_event("stand-in telemetry persistence failed", &[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::store::RuntimeWorkStore;
    use serde_json::json;

    #[test]
    fn stand_in_telemetry_observes_real_store_updates_without_a_desktop_subscription() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let facts = LocalTaskStore::open(&path).unwrap();
        facts.configure_stand_in_telemetry(7, true, None).unwrap();
        let runtime = RuntimeWorkStore::new(root.path().join("runtime.json"));
        runtime.set_telemetry_path(path.clone());
        let mut task = RuntimeTaskLink::new_pending(
            "private-task".into(),
            "/private/workspace".into(),
            "private title".into(),
        );
        task.runtime_handle = json!({"origin":{"initiatedBy":"stand_in_identity","type":"stand_in_identity","userId":7},"lastTurnId":"turn-one"});
        task.running = true;
        runtime.upsert_task(task.clone());
        runtime.upsert_task(task);
        runtime.update_task("private-task", |task| {
            task.running = false;
            task.status = "done".into();
            task.turn_status = Some("completed".into());
        });
        let rows = facts.list_stand_in_telemetry(7).unwrap();
        assert_eq!(rows["items"].as_array().unwrap().len(), 2);
        assert_eq!(rows["items"][1]["name"], "stand_in_execution_completed");
        assert_eq!(rows["items"][1]["properties"]["source"], "conversation");
        assert!(!rows.to_string().contains("private"));
    }

    #[test]
    fn stand_in_telemetry_does_not_open_a_database_for_ordinary_tasks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("unused.sqlite");
        let runtime = RuntimeWorkStore::new(root.path().join("runtime.json"));
        runtime.set_telemetry_path(path.clone());
        runtime.upsert_task(RuntimeTaskLink::new_pending(
            "ordinary".into(),
            "".into(),
            "".into(),
        ));
        assert!(!path.exists());
    }
}
