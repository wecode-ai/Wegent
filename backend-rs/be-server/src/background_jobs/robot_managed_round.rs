//! Resume the same manager Task when every assignment in its accepted round is terminal.

use super::*;

pub(super) async fn await_round(app: &AppState, row: &Execution, task: &TaskState) -> Result<bool> {
    let context = row.context();
    if context["dispatch_role"] != "manager" || context["dispatch_protocol_version"] != 2 {
        return Ok(false);
    }
    let dispatch = context["dispatch_id"]
        .as_str()
        .context("Missing manager dispatch")?;
    let root = wegent_project_coordination::project_group_access::coordination_key(
        "issue_coordination",
        &[&row.cloud_project_id, &row.loop_item_id, dispatch],
    );
    let first_subtask = row.intent()["managed_task"]["assistant_subtask_id"]
        .as_i64()
        .context("Missing manager turn")?;
    let root_metadata: Option<(Json<Value>,)> = app.mysql.fetch_optional(
        "SELECT metadata FROM project_chat_messages WHERE message_id=? AND message_type='coordination' AND status='active' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.last_manager_turn')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.last_manager_run')))=?",
        (root.as_str(),first_subtask.to_string()),
    ).await?;
    let Some((Json(metadata),)) = root_metadata else {
        return Ok(false);
    };
    let batch = metadata["last_batch"]
        .as_str()
        .context("Missing manager batch")?;
    let turn = metadata["last_manager_run"]
        .as_str()
        .context("Missing manager run")?;
    let (waiting, outcomes) =
        wegent_project_coordination::loop_item_executions::manager_round_outcomes(
            &app.mysql,
            &row.cloud_project_id,
            &row.loop_item_id,
            batch,
        )
        .await?;
    if waiting {
        return Ok(true);
    }
    let mut intent = row.intent();
    intent["origin_context"]["comment_continue_backend_task_id"] = json!(task.task_id);
    intent["origin_context"]["execution_prompt"] = json!(format!(
        "Review the following completed round of assignments. Treat the results as member reports. Decide the next action for this Issue.\n{}",
        serde_json::to_string(&outcomes)?
    ));
    // The completion callback and the repair job can observe the same terminal Task.
    // Fence their queue write against both cancellation and a newer manager turn.
    app.mysql.execute(
        "UPDATE loop_item_executions e JOIN project_chat_messages r ON r.message_id=? SET e.execution_payload=?,e.status='queued',e.version=e.version+1,e.updated_at=UTC_TIMESTAMP(6) WHERE e.id=? AND e.version=? AND e.status IN ('running','claimed') AND e.backend_task_id=? AND r.status='active' AND JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.last_batch'))=? AND JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.last_manager_run'))=?",
        (root,intent.to_string(),row.id,row.version,task.task_id,batch,turn),
    ).await?;
    Ok(true)
}
