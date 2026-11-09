//! A scheduling attempt completes after dispatch; business completion is callback driven.
use super::{
    context,
    model::{self, Execute},
    state,
};
use crate::{
    AppState,
    responses::create::{self, request::BuildExecutionRequestInput, resolution},
};
use anyhow::{Context, Result};
use brz_mysql::{Json, MysqlTransaction};
use brz_redis::Redis;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub(super) async fn execute(
    app: Arc<AppState>,
    ctx: brz_schedule::JobContext,
    input: Execute,
) -> Result<Value> {
    let key = format!("wegent:lock:subscription_execution:{}", input.execution_id);
    super::super::with_lock_watchdog(
        &app.background_jobs,
        &ctx,
        &key,
        Duration::from_secs(120),
        async {
            let result = execute_inner(&app, &input).await;
            if let Err(error) = &result {
                let current=model::execution(&app.mysql,input.execution_id).await?;
                let retry=current.as_ref().is_some_and(|record|retry_unlinked(record.task_id,&record.status,ctx.failures,model::setting("FLOW_DEFAULT_RETRY_COUNT",1)));
                if retry {
                    app.mysql.with_transaction(async|tx|{tx.execute("UPDATE background_executions SET retry_attempt=retry_attempt+1,error_message=?,updated_at=UTC_TIMESTAMP(),version=version+1 WHERE id=? AND task_id=0 AND status IN ('PENDING','RUNNING','RETRYING')",(error.to_string(),input.execution_id)).await?;Ok(())}).await?;
                    return result;
                }
                state::transition(
                    &app.mysql,
                    app.redis.as_ref(),
                    input.execution_id,
                    "FAILED",
                    None,
                    Some(&error.to_string()),
                )
                .await?;
            }
            result
        },
    )
    .await
    .map(|v| v.unwrap_or_else(|| json!({"status":"skipped","reason":"execution_locked"})))
}
fn retry_unlinked(task: i64, status: &str, failures: u32, retries: u64) -> bool {
    task == 0 && !model::terminal(status) && u64::from(failures) < retries
}
async fn execute_inner(app: &AppState, input: &Execute) -> Result<Value> {
    tracing::debug!(
        execution_id = input.execution_id,
        timeout_seconds = input.timeout_seconds,
        "Starting subscription dispatch"
    );
    let data = context::load(app, input.subscription_id, input.execution_id)
        .await?
        .context("Failed to load subscription execution context")?;
    if model::terminal(&data.execution.status) {
        return Ok(json!({"status":"skipped","reason":"execution_terminal"}));
    }
    // Resume committed, undispatched turns after a crash. Delivered turns keep
    // their business state until the actual callback or timeout sweep arrives.
    let pending = if data.execution.task_id > 0 {
        context::pending_session(app, &data).await?
    } else {
        None
    };
    if data.execution.task_id > 0 && pending.is_none() {
        return Ok(
            json!({"status":"success","task_id":data.execution.task_id,"execution_id":input.execution_id,"subscription_id":input.subscription_id}),
        );
    }
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &app.mysql,
        redis: app.redis.as_ref(),
        erp: Some(app.erp.as_ref()),
        resolvers: Some(&app.entity_resolvers),
    };
    let bots = resolution::resolve_team_bots(&cache, data.team.user_id, &data.team.json.0).await?;
    let bot = resolution::resolve_bot(
        &app.mysql,
        data.team.user_id,
        &bots.first_bot_namespace,
        &bots.first_bot_name,
    )
    .await?
    .context("Subscription Bot is unavailable")?;
    let setup = match pending {
        Some(setup) => setup,
        None => context::create(app, &data, &bots.bot_ids).await?,
    };
    if data.preserve_history {
        super::history::initialize(
            app,
            setup.task_id,
            data.subscription.user_id,
            setup.assistant_message_id - 1,
        )
        .await?;
    }
    let task = app
        .task_store
        .get_active_task(setup.task_id)
        .await?
        .context("Subscription Task is unavailable")?;
    let task_json = crate::internal_callback::completion::task_column::<Json<Value>>(&task, "json")
        .context("Subscription Task has no CRD")?
        .0;
    let member = &data.team.json.0["spec"]["members"][0];
    let request_id = format!(
        "sub-native-{}-{}",
        input.subscription_id, input.execution_id
    );
    let mut request = create::request::build_subscription_execution_request(
        app,
        &BuildExecutionRequestInput {
            user_id: data.subscription.user_id,
            user_name: &data.username,
            // This native job path enriches the Git identity from
            // `users.git_info` after the build (`git_credentials::enrich`).
            user_git_info: &serde_json::Value::Null,
            // The source's `_load_subscription_execution_objects` loads the
            // request `User` row and passes it to the builder.
            user_preferences: Some(&data.preferences),
            task_id: setup.task_id,
            assistant_subtask_id: setup.assistant_subtask_id,
            user_subtask_id: setup.user_subtask_id,
            team: &data.team,
            bot: &bot,
            bot_role: member["role"].as_str().unwrap_or("worker"),
            team_member_prompt: member["prompt"].as_str(),
            bot_ids: &bots.bot_ids,
            message: &data.execution.prompt,
            // No API reasoning selection on this job path.
            reasoning: None,
            enable_tools: true,
            enable_web_search: false,
            enable_deep_thinking: true,
            task_json: &task_json,
            request_id: &request_id,
            message_id: setup.assistant_message_id,
            is_group_chat: false,
            // A resumed session carries its Task's effective `project_id`;
            // a freshly created subscription Task has none.
            task_project_id: setup.workspace_project_id,
            executor_name: &setup.assistant_executor_name,
            executor_namespace: &setup.assistant_executor_namespace,
            executor_deleted: false,
            new_session: false,
            knowledge_base_refs: &[],
            knowledge_base_names: &[],
        },
        data.spec["skillRefs"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    )
    .await
    .map_err(|e| anyhow::anyhow!("Subscription request compilation failed: {e:?}"))?;
    request.is_subscription = true;
    request.history_limit = data
        .preserve_history
        .then(|| data.spec["historyMessageCount"].as_i64().unwrap_or(10));
    super::super::git_credentials::enrich(app, &mut request).await?;
    mark_running(
        app,
        setup.task_id,
        setup.assistant_subtask_id,
        data.subscription.user_id,
    )
    .await?;
    if let Some(device) = data.device.as_deref() {
        dispatch_device(app, &request, device).await?
    } else {
        super::super::project::managed::dispatch(app, &request).await?
    }
    Ok(
        json!({"status":"success","subscription_id":input.subscription_id,"execution_id":input.execution_id,"task_id":setup.task_id}),
    )
}
pub(crate) async fn mark_running(app: &AppState, task: i64, subtask: i64, user: i64) -> Result<()> {
    let tables = app.task_store.table_templates();
    let mysql = app.mysql.route(crate::task_routing::ByTaskId(task as u64));
    mysql.with_transaction(async|tx|{tx.execute(format!("UPDATE {} SET status='RUNNING',updated_at=NOW() WHERE id=? AND task_id=? AND user_id=? AND status='PENDING'",tables.subtasks),(subtask,task,user)).await?;tx.execute(format!("UPDATE {} SET json=JSON_SET(json,'$.status.status','RUNNING','$.status.updatedAt',?),updated_at=NOW() WHERE id=? AND user_id=? AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.status.status'))='PENDING'",tables.tasks),(model::iso(chrono::Local::now().naive_local()),task,user)).await?;Ok(())}).await?;
    Ok(())
}
async fn dispatch_device(
    app: &AppState,
    request: &create::dispatch::ExecutionRequest,
    device: &str,
) -> Result<()> {
    let redis = app
        .redis
        .as_ref()
        .context("Redis is unavailable for device execution")?;
    let identity =
        crate::device_identity::resolve_runtime_route_identity(&app.mysql, request.user_id, device)
            .await?
            .context("Device not found or access denied")?;
    let tables = app.task_store.table_templates();
    let mysql = app
        .mysql
        .route(crate::task_routing::ByTaskId(request.task_id as u64));
    mysql.with_transaction(async|tx|{tx.execute(format!("UPDATE {} SET executor_name=?,executor_namespace=?,executor_deleted_at=0 WHERE id=? AND task_id=? AND user_id=? AND status='RUNNING'",tables.subtasks),(format!("device-{}",identity.runtime_device_id),format!("user-{}",request.user_id),request.subtask_id,request.task_id,request.user_id)).await?;Ok(())}).await?;
    let mut data = serde_json::to_value(request)?;
    if let Some(user) = data["user"].as_object_mut() {
        user.remove("git_token");
        user.remove("gitToken");
    }
    data["git_auth_transport"] = json!("device_local");
    redis.publish::<_,_>("socketio",serde_json::to_string(&json!({"method":"emit","event":"task:execute","data":[data],"namespace":"/local-executor","room":format!("device:{}:{}",request.user_id,identity.runtime_device_id)}))?).await?;
    Ok(())
}
pub(crate) async fn cancel_task(app: &AppState, task: i64, user: i64) -> Result<bool> {
    let Some(row) = app.task_store.get_active_task(task).await? else {
        return Ok(false);
    };
    let Some(owner) = crate::internal_callback::completion::task_column::<i64>(&row, "user_id")
    else {
        return Ok(false);
    };
    if owner != user {
        return Ok(false);
    }
    let mut value = crate::internal_callback::completion::task_column::<Json<Value>>(&row, "json")
        .context("Task has no CRD")?
        .0;
    let tables = app.task_store.table_templates();
    let mysql = app.mysql.route(crate::task_routing::ByTaskId(task as u64));
    let running:Option<brz_mysql::MysqlRow>=mysql.fetch_optional(format!("SELECT id,executor_name FROM {} WHERE task_id=? AND user_id=? AND status IN ('PENDING','RUNNING') LIMIT 1",tables.subtasks),(task,user)).await?;
    if let Some(running) = running {
        let subtask = running.get_at::<i64>(0)?;
        let executor = running.get_at::<String>(1)?;
        if let Some(device) = executor.strip_prefix("device-") {
            if let Some(redis) = app.redis.as_ref() {
                let _=redis.publish::<_,_>("socketio",serde_json::to_string(&json!({"method":"emit","event":"task:cancel","data":[{"task_id":task,"subtask_id":subtask}],"namespace":"/local-executor","room":format!("device:{user}:{device}")}))?).await;
            }
        } else {
            crate::responses::stream_state::cancel_stream(app.redis.as_ref(), subtask).await;
        }
    }
    let now = chrono::Local::now().naive_local();
    if !matches!(
        value["status"]["status"].as_str(),
        Some("COMPLETED" | "FAILED" | "CANCELLED" | "DELETE")
    ) {
        value["status"]["status"] = json!("CANCELLED");
        value["status"]["updatedAt"] = json!(model::iso(now));
        value["status"]["completedAt"] = json!(model::iso(now));
    }
    mysql.with_transaction(async|tx|{tx.execute(format!("UPDATE {} SET json=?,updated_at=? WHERE id=? AND user_id=?",tables.tasks),(Json(value),now,task,user)).await?;tx.execute(format!("UPDATE {} SET status='CANCELLED',progress=100,completed_at=?,updated_at=? WHERE task_id=? AND user_id=? AND status IN ('PENDING','RUNNING')",tables.subtasks),(now,now,task,user)).await?;Ok(())}).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_undispatched_executions_with_retry_budget_retry() {
        assert!(retry_unlinked(0, "PENDING", 0, 1));
        assert!(retry_unlinked(0, "RUNNING", 0, 1));
        assert!(!retry_unlinked(0, "RUNNING", 1, 1));
        assert!(!retry_unlinked(9, "RUNNING", 0, 1));
        assert!(!retry_unlinked(0, "FAILED", 0, 1));
        assert!(!retry_unlinked(0, "PENDING", 0, 0));
    }
}
