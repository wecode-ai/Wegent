// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Persisted managed-Team dispatch, using the ordinary request compiler and
//! streaming persistence pipeline rather than a detached process-local queue.

use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    responses::create::{
        self,
        dispatch::ExecutionRequest,
        request::BuildExecutionRequestInput,
        resolution,
        routing::{self, CommunicationMode, RouteInputs},
    },
    state::AppState,
};

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Execute {
    pub task_id: i64,
    pub assistant_subtask_id: i64,
    pub user_subtask_id: i64,
    pub team_id: i64,
    pub user_id: i64,
    pub prompt: String,
    #[serde(default)]
    pub developer_instruction: String,
}

#[derive(FromMysqlRow)]
struct Task {
    user_id: i64,
    json: Json<Value>,
    project_id: Option<i64>,
}
#[derive(FromMysqlRow)]
struct Assistant {
    id: i64,
    task_id: i64,
    user_id: i64,
    role: String,
    status: String,
    message_id: i64,
    executor_name: String,
    executor_namespace: String,
}
#[derive(FromMysqlRow)]
struct User {
    user_name: String,
    preferences: String,
}

/// `_load_detached_execution_objects` reads the request `User` row before
/// dispatch and raises when it is absent. The row also supplies the
/// `preferences` document `_build_skill_data` reads.
async fn load_user<M: Mysql>(mysql: &M, user_id: i64) -> Result<User> {
    mysql
        .fetch_optional(
            "SELECT user_name,preferences FROM users WHERE id=?",
            (user_id,),
        )
        .await?
        .context("Managed project automation user is unavailable")
}

fn claim_allowed(task: &Task, assistant: &Assistant, input: &Execute) -> bool {
    let labels = &task.json.0["metadata"]["labels"];
    task.user_id == input.user_id
        && labels["source"] == "project_automation"
        && labels["projectAutomationSubtaskId"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            == Some(input.assistant_subtask_id)
        && !matches!(
            task.json.0["status"]["status"].as_str(),
            Some("COMPLETED" | "FAILED" | "CANCELLED" | "DELETE")
        )
        && assistant.id == input.assistant_subtask_id
        && assistant.task_id == input.task_id
        && assistant.user_id == input.user_id
        && assistant.role == "ASSISTANT"
        && assistant.status == "PENDING"
}

pub(crate) async fn execute(state: &AppState, input: Execute) -> Result<Value> {
    match execute_inner(state, &input).await {
        Ok(dispatched) => {
            Ok(json!({"status":if dispatched{"dispatched"}else{"skipped"},"task_id":input.task_id}))
        }
        Err(error) => {
            if let Some(redis) = state.redis.as_ref() {
                let ctx = crate::internal_callback::completion::Completion {
                    app: Some(state),
                    mysql: &state.mysql,
                    redis,
                    tables: crate::internal_callback::tables(state),
                    executor_manager: &state.executor_manager,
                };
                crate::internal_callback::completion::complete_terminal(
                    &ctx,
                    input.task_id,
                    input.assistant_subtask_id,
                    "FAILED",
                    None,
                    Some(&error.to_string()),
                    None,
                    None,
                    None,
                )
                .await;
                if let Err(project_error) = super::completion::complete(
                    &state.mysql,
                    redis,
                    state.task_store.table_templates(),
                    input.task_id,
                    input.user_id,
                    "FAILED",
                    Some(&error.to_string()),
                )
                .await
                {
                    tracing::error!(%project_error,"managed project failure projection failed");
                }
            }
            Err(error)
        }
    }
}

async fn execute_inner(state: &AppState, input: &Execute) -> Result<bool> {
    let tables = state.task_store.table_templates();
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(input.task_id as u64));
    let claimed=mysql.with_transaction(async |tx| {
        let task:Option<Task>=tx.fetch_optional(format!("SELECT user_id,json,project_id FROM {} WHERE id=? AND kind='Task' FOR UPDATE",tables.tasks),(input.task_id,)).await?;
        let assistant:Option<Assistant>=tx.fetch_optional(format!("SELECT id,task_id,user_id,role,status,message_id,executor_name,executor_namespace FROM {} WHERE id=? FOR UPDATE",tables.subtasks),(input.assistant_subtask_id,)).await?;
        let (Some(mut task),Some(assistant))=(task,assistant) else{return Ok(false)};
        if !claim_allowed(&task,&assistant,input) {return Ok(false)}
        let now=Utc::now().naive_utc();
        task.json.0["status"]["status"]=json!("RUNNING");task.json.0["status"]["updatedAt"]=json!(super::store::iso(now));
        tx.execute(format!("UPDATE {} SET status='RUNNING' WHERE id=? AND task_id=? AND user_id=? AND role='ASSISTANT' AND status='PENDING'",tables.subtasks),(input.assistant_subtask_id,input.task_id,input.user_id)).await?;
        tx.execute(format!("UPDATE {} SET json=?,updated_at=? WHERE id=?",tables.tasks),(task.json,now,input.task_id)).await?;
        Ok(true)
    }).await?;
    if !claimed {
        return Ok(false);
    }
    if let Some(redis) = state.redis.as_ref() {
        super::completion::started(&state.mysql, redis, tables, input.task_id, input.user_id)
            .await?;
    }
    let request = request_for_task(state, input).await?;
    // Cancellation can race expensive credential/skills/request preparation.
    let still_running:Option<Assistant>=mysql.fetch_optional(format!("SELECT id,task_id,user_id,role,status,message_id,executor_name,executor_namespace FROM {} WHERE id=? AND task_id=? AND user_id=? AND role='ASSISTANT' AND status='RUNNING'",tables.subtasks),(input.assistant_subtask_id,input.task_id,input.user_id)).await?;
    let task: Option<Task> = mysql
        .fetch_optional(
            format!(
                "SELECT user_id,json,project_id FROM {} WHERE id=? AND user_id=?",
                tables.tasks
            ),
            (input.task_id, input.user_id),
        )
        .await?;
    if still_running.is_none()
        || task
            .as_ref()
            .is_none_or(|task| task.json.0["status"]["status"] != "RUNNING")
    {
        return Ok(false);
    }
    dispatch(state, &request).await?;
    Ok(true)
}

pub(crate) async fn request_for_task(
    state: &AppState,
    input: &Execute,
) -> Result<ExecutionRequest> {
    let tables = state.task_store.table_templates();
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(input.task_id as u64));
    let task: Task = mysql
        .fetch_one(
            format!(
                "SELECT user_id,json,project_id FROM {} WHERE id=? AND user_id=? AND kind='Task'",
                tables.tasks
            ),
            (input.task_id, input.user_id),
        )
        .await?;
    let assistant:Assistant=mysql.fetch_one(format!("SELECT id,task_id,user_id,role,status,message_id,executor_name,executor_namespace FROM {} WHERE id=? AND task_id=? AND user_id=? AND role='ASSISTANT'",tables.subtasks),(input.assistant_subtask_id,input.task_id,input.user_id)).await?;
    let team = resolution::team_by_id(&state.mysql, input.team_id)
        .await?
        .context("Managed project automation Team is unavailable")?;
    let user = load_user(&state.mysql, input.user_id).await?;
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let bots = resolution::resolve_team_bots(&cache, team.user_id, &team.json.0).await?;
    let bot = resolution::resolve_bot(
        &state.mysql,
        team.user_id,
        &bots.first_bot_namespace,
        &bots.first_bot_name,
    )
    .await?
    .context("Managed project automation Bot is unavailable")?;
    if bots.bot_ids.is_empty() {
        bail!("No valid bots found in managed project automation Team")
    }
    let member = &team.json.0["spec"]["members"][0];
    let request_id = crate::task_creation::pending_task_name();
    let mut request = create::request::build_background_execution_request(
        state,
        &BuildExecutionRequestInput {
            user_id: input.user_id,
            user_name: &user.user_name,
            // This native job path enriches the Git identity from
            // `users.git_info` after the build (`git_credentials::enrich`).
            user_git_info: &serde_json::Value::Null,
            // The source passes `user=objects.user` after
            // `_load_detached_execution_objects` loads the request row.
            user_preferences: Some(&user.preferences),
            task_id: input.task_id,
            assistant_subtask_id: input.assistant_subtask_id,
            user_subtask_id: input.user_subtask_id,
            team: &team,
            bot: &bot,
            bot_role: member["role"].as_str().unwrap_or("worker"),
            team_member_prompt: member["prompt"].as_str(),
            bot_ids: &bots.bot_ids,
            message: &input.prompt,
            // No API reasoning selection on this job path.
            reasoning: None,
            enable_tools: true,
            enable_web_search: false,
            enable_deep_thinking: true,
            task_json: &task.json.0,
            request_id: &request_id,
            message_id: assistant.message_id,
            is_group_chat: false,
            task_project_id: task.project_id.unwrap_or(0),
            executor_name: &assistant.executor_name,
            executor_namespace: &assistant.executor_namespace,
            executor_deleted: false,
            new_session: false,
            knowledge_base_refs: &[],
            knowledge_base_names: &[],
        },
    )
    .await
    .map_err(|error| anyhow::anyhow!("managed project request preparation failed: {error:?}"))?;
    add_board_capabilities(&mut request);
    if !input.developer_instruction.trim().is_empty() {
        request.system_prompt = [
            request.system_prompt.trim(),
            input.developer_instruction.trim(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    }
    super::super::git_credentials::enrich(state, &mut request).await?;
    Ok(request)
}

fn add_board_capabilities(request: &mut ExecutionRequest) {
    const GUIDANCE: &str = "<wegent_board_runtime>\nThis execution is bound to a Wework board item. The injected\nwegent-wework-space MCP is the source of truth for the board. Call\nget_current_context before board operations; do not probe Backend routes,\nread authentication files, or guess project/item identifiers. Use the MCP\ntools to read, create, update, assign, comment, attach, and inspect deliveries.\n</wegent_board_runtime>";
    request.system_prompt = format!("{}\n\n{GUIDANCE}", request.system_prompt.trim_end());
    let base = std::env::var("WEGENT_BACKEND_PUBLIC_URL")
        .unwrap_or_else(|_| "http://localhost:8000".into());
    let server = json!({"name":"wegent-wework-space","type":"streamable-http","url":format!("{}/mcp/wework-space/sse",base.trim_end_matches('/')),"timeout":60,"auth":{"Authorization":format!("Bearer {}",request.auth_token)}});
    request
        .mcp_servers
        .retain(|value| value["name"] != "wegent-wework-space");
    request.mcp_servers.push(server.clone());
    if let Some(bot) = request.bot.as_array_mut().and_then(|bots| bots.first_mut()) {
        let mut servers = bot["mcp_servers"].as_array().cloned().unwrap_or_default();
        servers.retain(|value| value["name"] != "wegent-wework-space");
        let mut bot_server = server;
        let auth = bot_server.as_object_mut().unwrap().remove("auth").unwrap();
        bot_server["headers"] = auth;
        servers.push(bot_server);
        bot["mcp_servers"] = json!(servers);
    }
}

pub(crate) async fn dispatch(state: &AppState, request: &ExecutionRequest) -> Result<()> {
    let shell = routing::shell_type(request);
    let chat =
        std::env::var("CHAT_SHELL_URL").unwrap_or_else(|_| routing::DEFAULT_CHAT_SHELL_URL.into());
    let manager = std::env::var("EXECUTOR_MANAGER_URL")
        .unwrap_or_else(|_| create::executor_client::DEFAULT_EXECUTOR_MANAGER_URL.into());
    let target = routing::route(&RouteInputs {
        shell_type: &shell,
        chat_shell_url: &chat,
        executor_manager_url: &manager,
        device_id: None,
        model_is_video: request.model_config["modelType"] == "video",
        model_protocol: request.model_config["protocol"].as_str(),
    });
    match target.mode {
        CommunicationMode::Sse => {
            let consumer = create::sse_sync::ConsumerContext::from_app(state);
            create::sse_sync::collect(
                &consumer,
                target
                    .url
                    .as_deref()
                    .context("Chat Shell target is unavailable")?,
                request,
                &request.request_id,
                request.message_id,
            )
            .await
            .map_err(anyhow::Error::msg)?;
        }
        CommunicationMode::HttpCallback => {
            let http = brz_http::Client::builder()
                .read_timeout(std::time::Duration::from_secs(300))
                .build()?;
            let payload = create::dispatch::assemble(request, false, true);
            create::executor_client::ExecutorClient::new(http)
                .dispatch(
                    target
                        .url
                        .as_deref()
                        .context("Executor target is unavailable")?,
                    &payload,
                )
                .await?;
        }
        CommunicationMode::Polling => {
            crate::background_jobs::video::create::dispatch(state, request).await?
        }
        other => bail!("managed project execution cannot route {other:?}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_capabilities_replace_same_named_server_and_keep_scoped_authentication() {
        let mut request = ExecutionRequest {
            auth_token: "task-identity".into(),
            mcp_servers: vec![
                json!({"name":"wegent-wework-space","url":"old"}),
                json!({"name":"other"}),
            ],
            bot: json!([{"mcp_servers":[{"name":"wegent-wework-space","url":"old"}]}]),
            ..Default::default()
        };
        add_board_capabilities(&mut request);
        assert_eq!(request.mcp_servers.len(), 2);
        assert_eq!(
            request.mcp_servers[1]["auth"]["Authorization"],
            "Bearer task-identity"
        );
        assert_eq!(
            request.bot[0]["mcp_servers"][0]["headers"]["Authorization"],
            "Bearer task-identity"
        );
        assert!(request.system_prompt.contains("get_current_context"));
    }

    /// The managed-project builder resolves the same `User` row the source's
    /// `_load_detached_execution_objects` loads, including `preferences`:
    /// `_build_skill_data` reads `user.preferences`, so the request cannot
    /// pass a missing document while the Python path passes the stored one.
    #[tokio::test]
    async fn user_read_carries_the_preferences_document() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert!(load_user(&mysql, 42).await.is_err());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            "SELECT user_name,preferences FROM users WHERE id=?"
        );
        assert_eq!(queries[0].args, 1);
        assert_eq!(queries[0].first_integer, Some(42));
    }
}
