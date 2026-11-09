//! Generation reverse links are committed before any upstream can call back.
use super::Wiki;
use crate::{
    AppState,
    responses::create::{self, request::BuildExecutionRequestInput, resolution, session},
    task_creation::{TaskCrdInput, WorkspaceRepository},
};
use anyhow::{Context, Result};
use brz_mysql::{Json, MysqlTransaction};
use serde_json::Value;
#[allow(clippy::too_many_arguments)]
pub(super) async fn create(
    app: &AppState,
    wiki: &Wiki,
    runner: i64,
    username: &str,
    preferences: &str,
    team: &resolution::KindRow,
    generation: i64,
    execution: i64,
    prompt: &str,
) -> Result<i64> {
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &app.mysql,
        redis: app.redis.as_ref(),
        erp: Some(app.erp.as_ref()),
        resolvers: Some(&app.entity_resolvers),
    };
    let bots = resolution::resolve_team_bots(&cache, team.user_id, &team.json.0).await?;
    let bot = resolution::resolve_bot(
        &app.mysql,
        team.user_id,
        &bots.first_bot_namespace,
        &bots.first_bot_name,
    )
    .await?
    .context("Code Wiki Bot is unavailable")?;
    let now = super::super::model::iso(chrono::Local::now().naive_local());
    let source = &wiki.json.0["spec"]["source"];
    let title = format!(
        "Code wiki: {}",
        source["projectName"].as_str().unwrap_or("")
    );
    let model = &wiki.json.0["spec"]["executionModelRef"];
    let model_name = model["name"].as_str().filter(|s| !s.is_empty());
    let mut setup_sql: &brz_mysql::MysqlService = &app.mysql;
    let setup = session::setup_chat_session(
        app.task_store.as_ref(),
        &mut setup_sql,
        &session::SetupChatSessionInput {
            user_id: runner,
            owner_user_id: runner.try_into()?,
            continuation: None,
            team_id: team.id,
            bot_ids: &bots.bot_ids,
            input_text: prompt,
            crd: TaskCrdInput {
                task_id: 0,
                team_name: &team.name,
                team_namespace: &team.namespace,
                team_user_id: team.user_id,
                message: prompt,
                title: Some(&title),
                task_type: Some("code"),
                source: "code_wiki",
                project_id: 0,
                api_key_name: None,
                model_id: model_name,
                force_override_bot_model: model_name.is_some(),
                is_group_chat: false,
                is_api_call: false,
                auto_delete_executor: Some("false"),
                omit_mcp_binary_output: false,
                device_id: None,
                git_workspace: true,
                created_at: &now,
                updated_at: &now,
            },
            repository: WorkspaceRepository {
                git_url: source["sourceUrl"].as_str().unwrap_or(""),
                git_repo: source["projectName"].as_str().unwrap_or(""),
                git_domain: source["sourceDomain"].as_str().unwrap_or(""),
                ..Default::default()
            },
            client_origin: "frontend",
            project_id: 0,
            created_at: &now,
            updated_at: &now,
            completed_at: "1970-01-01 00:00:00",
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("Could not start the wiki task: {e:?}"))?;
    let tables = app.task_store.table_templates();
    let mysql = app
        .mysql
        .route(crate::task_routing::ByTaskId(setup.task_id as u64));
    mysql.with_transaction(async|tx|{let namespace=if wiki.json.0["spec"]["showGenerationTask"]==true{"default"}else{"system"};tx.execute(format!("UPDATE {} SET namespace=?,json=JSON_SET(json,'$.metadata.namespace',?,'$.metadata.labels.forceOverrideBotModelType',?,'$.metadata.labels.backgroundExecutionId',?),updated_at=NOW() WHERE id=? AND user_id=?",tables.tasks),(namespace,namespace,model["type"].as_str(),execution.to_string(),setup.task_id,runner)).await?;tx.execute("UPDATE wiki_generations SET task_id=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND user_id=? AND status='RUNNING' AND task_id=0",(setup.task_id,generation,runner)).await?;Ok(())}).await?;
    let task = app
        .task_store
        .get_active_task(setup.task_id)
        .await?
        .context("Code Wiki Task is unavailable")?;
    let value = crate::internal_callback::completion::task_column::<Json<Value>>(&task, "json")
        .context("Code Wiki Task has no CRD")?
        .0;
    let member = &team.json.0["spec"]["members"][0];
    let request_id = format!("code-wiki-native-{generation}");
    let mut request = create::request::build_background_execution_request(
        app,
        &BuildExecutionRequestInput {
            user_id: runner,
            user_name: username,
            // This native job path enriches the Git identity from
            // `users.git_info` after the build (`git_credentials::enrich`).
            user_git_info: &serde_json::Value::Null,
            // `knowledge/code_wiki/runner.py` builds with `user=task_user`
            // after its dispatch path loads the `User` row.
            user_preferences: Some(preferences),
            task_id: setup.task_id,
            assistant_subtask_id: setup.assistant_subtask_id,
            user_subtask_id: setup.user_subtask_id,
            team,
            bot: &bot,
            bot_role: member["role"].as_str().unwrap_or("worker"),
            team_member_prompt: member["prompt"].as_str(),
            bot_ids: &bots.bot_ids,
            message: prompt,
            // No API reasoning selection on this job path.
            reasoning: None,
            enable_tools: true,
            enable_web_search: false,
            enable_deep_thinking: true,
            task_json: &value,
            request_id: &request_id,
            message_id: setup.assistant_message_id,
            is_group_chat: false,
            task_project_id: 0,
            executor_name: &setup.assistant_executor_name,
            executor_namespace: &setup.assistant_executor_namespace,
            executor_deleted: false,
            new_session: false,
            knowledge_base_refs: &[],
            knowledge_base_names: &[],
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("Code Wiki request compilation failed: {e:?}"))?;
    super::super::super::git_credentials::enrich(app, &mut request).await?;
    super::super::execution::mark_running(app, setup.task_id, setup.assistant_subtask_id, runner)
        .await?;
    if let Err(error) = super::super::super::project::managed::dispatch(app, &request).await {
        if let Some(redis) = app.redis.as_ref() {
            let ctx = crate::internal_callback::completion::Completion {
                app: Some(app),
                mysql: &app.mysql,
                redis,
                tables: crate::internal_callback::tables(app),
                executor_manager: &app.executor_manager,
            };
            crate::internal_callback::completion::complete_terminal(
                &ctx,
                setup.task_id,
                setup.assistant_subtask_id,
                "FAILED",
                None,
                Some(&error.to_string()),
                None,
                None,
                None,
            )
            .await;
        }
        return Err(error);
    }
    Ok(setup.task_id)
}
