//! Advance an executing device's replica only after the dispatcher verified the turn.
use super::*;
use rusqlite::Transaction;

pub(super) fn verified_request(
    transaction: &Transaction<'_>,
    id: &str,
    user: i64,
    root: &str,
    intent: &Value,
    attempt: u64,
    saved: Value,
) -> Result<Value, TaskRuntimeError> {
    let previous = saved["attempt"].as_u64().unwrap_or(0);
    if saved["userId"] != user || saved["root"] != root || attempt < previous {
        return Err(TaskRuntimeError::VersionConflict);
    }
    if attempt == previous {
        return if saved["intent"] == *intent {
            Ok(saved)
        } else {
            Err(TaskRuntimeError::VersionConflict)
        };
    }
    if saved["cancelRequested"] == true {
        return Err(TaskRuntimeError::StandInRoleRequestCancelled);
    }
    if !same_branch(&saved["intent"], intent) {
        return Err(TaskRuntimeError::VersionConflict);
    }
    // Addresses, errors, staged results and cancellation acknowledgements describe
    // the old attempt. Only the verified branch identity carries across attempts.
    let metadata = json!({"userId":user,"root":root,"intent":intent,"attempt":attempt});
    transaction.execute(
        "UPDATE loop_items SET metadata=?2,updated_at=?3
         WHERE id=?1 AND resource_type='stand_in_role_request'",
        params![id, metadata.to_string(), now()],
    )?;
    Ok(metadata)
}

fn same_branch(previous: &Value, next: &Value) -> bool {
    // All fields except the new brief and dependencies are immutable, including
    // future identity or routing fields.
    let (Some(previous), Some(next)) = (previous.as_object(), next.as_object()) else {
        return false;
    };
    let mutable = |key: &str| matches!(key, "message" | "dependsOn" | "followupRequestId");
    previous
        .iter()
        .all(|(key, value)| mutable(key) || next.get(key) == Some(value))
        && next
            .keys()
            .all(|key| mutable(key) || previous.contains_key(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_replica_rejects_reordered_turns_and_late_side_effects() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let first = json!({"sourceDevice":"desktop","targetDevice":"cloud","roleId":"writer",
            "sourceTaskId":"parent","title":"Original","requestId":"initial","message":"draft"});
        let mut next = first.clone();
        next["message"] = json!("revise");
        next["followupRequestId"] = json!("second");
        let reserve = |intent: &Value, attempt| {
            store.reserve_verified_stand_in_role_request("task", 7, "root", intent, 16, attempt)
        };
        reserve(&first, 0).unwrap();
        store
            .record_stand_in_role_task_address("task", 7, 0, "cloud")
            .unwrap();
        let outcome = json!({"status":"done","resultId":"old"});
        assert!(store
            .stage_remote_stand_in_role_result("task", 7, 0, &outcome)
            .unwrap());
        let second = reserve(&next, 1).unwrap();
        assert!(second["taskAddress"].is_null() && second["pendingResult"].is_null());
        assert_eq!(second["attempt"], 1);
        assert_eq!(reserve(&next, 1).unwrap(), second);
        let mut changed = next.clone();
        changed["targetDevice"] = json!("other");
        for (intent, attempt) in [(&changed, 2), (&first, 0), (&first, 1)] {
            assert!(matches!(
                reserve(intent, attempt),
                Err(TaskRuntimeError::VersionConflict)
            ));
        }
        assert!(!store
            .stage_remote_stand_in_role_result("task", 7, 0, &outcome)
            .unwrap());
        store
            .record_remote_stand_in_role_result("task", 7, 0, "done", Some("old"))
            .unwrap();
        store
            .record_stand_in_role_route_failure("task", 7, 0, "stale_error", false)
            .unwrap();
        assert!(!store
            .record_stand_in_role_dependency_state("task", 7, 0, "ready", Some(&json!([])))
            .unwrap());
        assert!(store
            .record_stand_in_role_task_address("task", 7, 0, "cloud")
            .is_err());
        assert!(store
            .mark_inbound_stand_in_role_cancellation("task", 7, 0)
            .is_err());
        assert_eq!(
            store.stand_in_role_request("task", 7).unwrap(),
            Some(second)
        );
    }
}
