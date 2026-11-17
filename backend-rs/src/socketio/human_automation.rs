//! Automation projections consume the recipient-owned execution, never transport success.

use brz_mysql::{Json, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

/// A server-created snapshot remains authoritative after its feature flag is disabled.
pub(crate) fn context(value: &Value) -> Option<&Value> {
    let context = value
        .get("human_automation")
        .filter(|value| value.is_object())?;
    let run = context["automation_run_id"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    let human = context["human_assignment_id"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    context["assignment_id"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    let key = format!("{run}:{human}");
    if context["idempotency_key"].as_str() != Some(key.as_str())
        || !context["required_deliverables"].is_array()
        || context["non_workflow"].as_bool() != Some(context["workflow_stage_id"].is_null())
        || !(context["workflow_stage_id"].is_null()
            || context["workflow_stage_id"]
                .as_str()
                .is_some_and(|stage| !stage.is_empty()))
    {
        return None;
    }
    Some(context)
}

pub(crate) fn stage_matches(step: Option<&str>, dispatch: &Value) -> bool {
    let step = step.filter(|step| !step.is_empty());
    match context(dispatch) {
        Some(context) => context["workflow_stage_id"].as_str() == step,
        None => {
            !dispatch
                .get("human_automation")
                .is_some_and(Value::is_object)
                && step.is_none()
        }
    }
}

pub(crate) fn identity_matches(left: &Value, right: &Value) -> bool {
    match (context(left), context(right)) {
        (None, None) => {
            left.get("human_automation").is_none() && right.get("human_automation").is_none()
        }
        (Some(left), Some(right)) => [
            "automation_run_id",
            "human_assignment_id",
            "assignment_id",
            "idempotency_key",
            "workflow_stage_id",
            "required_deliverables",
            "non_workflow",
        ]
        .iter()
        .all(|key| left[*key] == right[*key]),
        _ => false,
    }
}

pub(crate) fn receipt(
    status: &str,
    observed: &str,
    execution: i64,
    device: &str,
    task: &str,
) -> Value {
    let (state, reason) = match status {
        "completed" => ("blocked", "required_delivery_pending"),
        "failed" => ("failed", "runtime_failed"),
        "cancelled" => ("cancelled", "runtime_cancelled"),
        "cancel_requested" => ("waiting", "cancel_requested"),
        "claimed" => ("queued", "awaiting_runtime"),
        "running" if observed == "waiting_user" => ("waiting_user", "waiting_user"),
        "running" => ("running", ""),
        _ => ("waiting_device", "waiting_device"),
    };
    json!({"state":state,"reason_code":reason,"runtime_state":status,
        "execution_id":execution.to_string(),"runtime_task_id":task,
        "runtime_device_id":device,"endpoint_ref":format!("wework-local:{device}:@primary")})
}

/// The guarded write shares the execution transaction and cannot complete the run.
pub(crate) async fn project_on(
    tx: &mut impl MysqlTransaction,
    origin: &Value,
    run_id: &str,
    project_id: &str,
    issue_id: &str,
    receipt: &Value,
) -> MysqlResult<()> {
    let Some(context) = context(origin).filter(|context| context["automation_run_id"] == run_id)
    else {
        return Ok(());
    };
    let state = receipt["state"].as_str().unwrap_or("blocked");
    if !matches!(
        state,
        "queued"
            | "waiting_device"
            | "running"
            | "waiting_user"
            | "waiting"
            | "blocked"
            | "failed"
            | "cancelled"
    ) {
        return Ok(());
    }
    let terminal = matches!(state, "failed" | "cancelled");
    tx.execute(
        "UPDATE loop_items SET status=?,metadata=JSON_SET(metadata,'$.human_automation', \
         JSON_MERGE_PATCH(JSON_EXTRACT(metadata,'$.human_automation'),CAST(? AS JSON))), \
         completed_at=CASE WHEN ? THEN UTC_TIMESTAMP(6) ELSE '1970-01-01 00:00:00' END, \
         version=version+1,updated_at=UTC_TIMESTAMP(6) \
         WHERE id=? AND cloud_project_id=? AND task_id=? AND resource_type='automation_run' \
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.human_automation.idempotency_key'))=? \
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.human_automation.assignment_id'))=? \
         AND status NOT IN ('succeeded','failed','cancelled','skipped') \
         AND (status<>? OR NOT JSON_CONTAINS(JSON_EXTRACT(metadata,'$.human_automation'),CAST(? AS JSON)))",
        (state, Json(receipt.clone()), terminal, run_id, project_id, issue_id,
            context["idempotency_key"].as_str().unwrap_or_default(),
            context["assignment_id"].as_str().unwrap_or_default(), state, Json(receipt.clone())),
    ).await?;
    tx.execute(
        "UPDATE project_chat_messages activity JOIN loop_items run \
         ON activity.message_id=JSON_UNQUOTE(JSON_EXTRACT(run.metadata,'$.activity_message_id')) \
         SET activity.status=?,activity.metadata=JSON_SET(COALESCE(activity.metadata,JSON_OBJECT()), \
         '$.run_status',?,'$.human_automation',JSON_REMOVE(JSON_EXTRACT(run.metadata,'$.human_automation'), \
         '$.endpoint_ref','$.runtime_device_id','$.runtime_task_id')), \
         activity.updated_at=UTC_TIMESTAMP(6) \
         WHERE run.id=? AND run.resource_type='automation_run' AND run.cloud_project_id=? \
         AND run.task_id=? AND run.status=? AND activity.project_id=? AND activity.task_id=? \
         AND JSON_UNQUOTE(JSON_EXTRACT(run.metadata,'$.human_automation.idempotency_key'))=? \
         AND (activity.status<>? OR NOT(JSON_UNQUOTE(JSON_EXTRACT(activity.metadata,'$.run_status'))<=>?) \
         OR NOT JSON_CONTAINS(COALESCE(JSON_EXTRACT(activity.metadata,'$.human_automation'),JSON_OBJECT()), \
         JSON_REMOVE(JSON_EXTRACT(run.metadata,'$.human_automation'), \
         '$.endpoint_ref','$.runtime_device_id','$.runtime_task_id')))",
        (state, state, run_id, project_id, issue_id, state, project_id, issue_id,
            context["idempotency_key"].as_str().unwrap_or_default(), state, state),
    ).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({"human_automation":{"automation_run_id":"run","human_assignment_id":"human",
            "assignment_id":"assignment","idempotency_key":"run:human","workflow_stage_id":"ux_spec",
            "non_workflow":false,"required_deliverables":[{"id":"ux_spec_file","value_type":"file"}]}})
    }

    #[test]
    fn stage_admission_requires_a_consistent_server_snapshot() {
        let snapshot = snapshot();
        assert!(stage_matches(Some("ux_spec"), &snapshot));
        assert!(!stage_matches(Some("implementation"), &snapshot));
        assert!(!stage_matches(None, &snapshot));
        assert!(!stage_matches(Some("ux_spec"), &json!({})));
        assert!(stage_matches(None, &json!({})));
        for (key, value) in [
            ("idempotency_key", json!("another-run:human")),
            ("non_workflow", json!(true)),
            ("assignment_id", Value::Null),
        ] {
            let mut invalid = snapshot.clone();
            invalid["human_automation"][key] = value;
            assert!(context(&invalid).is_none());
        }
    }

    #[test]
    fn identities_freeze_requirements_and_preserve_explicit_non_workflow() {
        let first = snapshot();
        assert!(identity_matches(&first, &first));
        let mut changed = first.clone();
        changed["human_automation"]["required_deliverables"] = json!([]);
        assert!(!identity_matches(&first, &changed));
        assert!(!identity_matches(&first, &json!({})));
        changed["human_automation"]["workflow_stage_id"] = Value::Null;
        changed["human_automation"]["non_workflow"] = json!(true);
        assert!(context(&changed).is_some());
        assert!(stage_matches(None, &changed));
    }

    #[test]
    fn runtime_completion_never_claims_deliverable_completion() {
        assert_eq!(
            receipt("claimed", "", 1, "device", "task")["state"],
            "queued"
        );
        assert_eq!(
            receipt("running", "", 1, "device", "task")["state"],
            "running"
        );
        assert_eq!(
            receipt("running", "waiting_user", 1, "device", "task")["state"],
            "waiting_user"
        );
        let complete = receipt("completed", "succeeded", 1, "device", "task");
        assert_eq!(complete["state"], "blocked");
        assert_eq!(complete["reason_code"], "required_delivery_pending");
        assert_eq!(complete["runtime_state"], "completed");
        let cancelling = receipt("cancel_requested", "running", 1, "device", "task");
        assert_eq!(cancelling["state"], "waiting");
        assert_eq!(cancelling["reason_code"], "cancel_requested");
        assert_eq!(
            receipt("failed", "failed", 1, "device", "task")["state"],
            "failed"
        );
        assert_eq!(
            receipt("cancelled", "cancelled", 1, "device", "task")["state"],
            "cancelled"
        );
    }
}
