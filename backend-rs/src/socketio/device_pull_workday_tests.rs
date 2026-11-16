use super::*;
use serde_json::json;

fn execution() -> Execution {
    Execution {
        id: 1,
        loop_item_id: "issue".into(),
        cloud_project_id: "project".into(),
        executor_owner_user_id: 1,
        assigner_user_id: 1,
        agent_id: "agent".into(),
        team_id: 0,
        automation_run_id: "run".into(),
        execution_environment: "local".into(),
        execution_device_id: "device".into(),
        runtime_device_id: String::new(),
        runtime_task_id: String::new(),
        status: "queued".into(),
        approval_status: "approved".into(),
        execution_payload: json!({"schema_version":2,"origin_context":{},"runtime_selection":{}})
            .to_string(),
        error_message: String::new(),
        execution_note: String::new(),
        version: 1,
        start_requested_at: None,
        completed_at: None,
    }
}

fn at(value: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").unwrap()
}

#[test]
fn workday_claim_checks_persisted_occurrence_and_actual_china_date() {
    let execution = execution();
    let policy = json!({"workday_only":true});
    assert!(
        !permits(
            &execution,
            "queued",
            "scheduled",
            &policy,
            at("2026-09-30 17:00:00")
        )
        .unwrap()
    );
    assert!(
        permits(
            &execution,
            "queued",
            "scheduled",
            &policy,
            at("2026-10-09 17:00:00")
        )
        .unwrap()
    );
    for trigger in ["manual", "event"] {
        assert!(
            permits(
                &execution,
                "queued",
                trigger,
                &policy,
                at("2026-10-01 01:00:00")
            )
            .unwrap()
        );
    }
    assert!(
        permits(
            &execution,
            "queued",
            "scheduled",
            &json!({}),
            at("2026-10-01 01:00:00")
        )
        .unwrap()
    );
    assert!(
        permits(
            &execution,
            "queued",
            "scheduled",
            &policy,
            at("2100-01-01 01:00:00")
        )
        .is_err()
    );
}

#[test]
fn workday_claim_does_not_limit_live_runs_or_comment_and_group_continuations() {
    let mut execution = execution();
    let policy = json!({"workday_only":true});
    let holiday = at("2026-10-01 01:00:00");
    for status in ["running", "succeeded", "failed", "cancelled", "skipped"] {
        assert!(permits(&execution, status, "scheduled", &policy, holiday).unwrap());
    }
    execution.execution_payload =
        json!({"schema_version":2,"origin_context":{"comment_trigger_message_id":"comment"}})
            .to_string();
    assert!(permits(&execution, "queued", "scheduled", &policy, holiday).unwrap());
    execution.execution_payload=json!({"schema_version":2,"origin_context":{"dispatch_kind":"collaboration_group"},"runtime_selection":{"executor_kind":"project_robot"}}).to_string();
    assert!(permits(&execution, "queued", "scheduled", &policy, holiday).unwrap());
    execution.execution_payload=json!({"schema_version":2,"origin_context":{"dispatch_kind":"collaboration_group"},"runtime_selection":{"executor_kind":"collaboration_group_dispatch"}}).to_string();
    assert!(!permits(&execution, "queued", "scheduled", &policy, holiday).unwrap());
    execution.start_requested_at = Some(holiday);
    assert!(permits(&execution, "queued", "scheduled", &policy, holiday).unwrap());
}
