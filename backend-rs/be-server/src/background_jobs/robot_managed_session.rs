//! Atomically bind one ordinary managed conversation to its queued execution.
use super::*;

fn dependency(error: impl std::fmt::Debug) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: format!("Managed Task preparation failed: {error:?}"),
    }
}

pub(super) async fn create(app: &AppState, expected: &Execution) -> Result<()> {
    let team = resolution::team_by_id(&app.mysql, expected.team_id)
        .await?
        .context("Managed Team unavailable")?;
    let context = expected.context();
    let now = store::iso(chrono::Utc::now().naive_utc());
    let previous = context["comment_continue_backend_task_id"]
        .as_i64()
        .map(|id| format!("resp_{id}"));
    let mut sql = &app.mysql;
    let continuation = if let Some(previous) = previous.as_deref() {
        crate::responses::create::continuation::resolve(
            app.task_store.as_ref(),
            &mut sql,
            previous,
            expected.executor_owner_user_id.try_into()?,
            &now,
        )
        .await
        .map_err(|error| anyhow::anyhow!("Managed continuation failed: {error:?}"))?
    } else {
        None
    };
    if let Some(previous) = &continuation
        && !source_labels_match(expected, &previous.task_json)
    {
        bail!("Managed source binding changed");
    }
    let resolvers = app.entity_resolvers.for_execution();
    let directory = app.entity_resolvers.execution_directory(app.erp.as_ref());
    let cache = crate::task_skills::kinds::KindCacheStore::new(
        &app.mysql,
        app.redis.as_ref(),
        directory,
        &resolvers,
    );
    let turn_team = resolution::turn_team(
        &team.json.0,
        continuation
            .as_ref()
            .and_then(|previous| previous.task_json["spec"]["currentStage"].as_u64())
            .unwrap_or(0) as usize,
    )
    .context("Managed Team first stage unavailable")?;
    let bots = resolution::resolve_team_bots(&cache, team.user_id, turn_team.as_ref()).await?;
    if bots.bot_ids.is_empty() {
        bail!("Managed Team has no active Bots");
    }
    let bot = resolution::resolve_bot(
        &app.mysql,
        team.user_id,
        &bots.first_bot_namespace,
        &bots.first_bot_name,
    )
    .await?
    .context("Managed Bot unavailable")?;
    let reference = &bot.json.0["spec"]["shellRef"];
    let shell = crate::responses::create::shell::resolve_shell(
        &app.mysql,
        &resolvers,
        app.redis.as_ref(),
        team.user_id,
        reference["name"].as_str().unwrap_or_default(),
        reference["namespace"].as_str().unwrap_or("default"),
    )
    .await?
    .context("Managed Shell unavailable")?;
    let chat = shell.json.0["spec"]["shellType"] == "Chat";
    let instruction = if context["comment_trigger_message_id"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
    {
        context["comment_prompt"].as_str().unwrap_or_default()
    } else {
        context["execution_prompt"].as_str().unwrap_or_default()
    };
    let prompt = profile::user_input(
        &expected.cloud_project_id,
        &expected.loop_item_id,
        expected.id,
        instruction,
        "",
    );
    let effects = app.mysql.with_transaction(async |tx| {
        let Some(issue) = store::locked(tx,"task",&expected.loop_item_id).await? else { return Ok(projection::Effects::default()) };
        let row: Option<Execution> = tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=? AND status='queued' FOR UPDATE"),(expected.id,)).await?;
        let Some(row) = row.filter(|row|row.version==expected.version && !row.assignment_pending()) else { return Ok(projection::Effects::default()) };
        if !authority::authorized_on(app,&mut &mut *tx,&row,Some(&issue)).await.map_err(dependency)? { return Ok(projection::Effects::default()); }
        let occupied: Option<(i64,)> = tx.fetch_optional("SELECT id FROM loop_item_executions WHERE execution_scope=(SELECT execution_scope FROM loop_item_executions WHERE id=?) AND id<>? AND status IN ('claimed','running','cancel_requested') LIMIT 1 FOR UPDATE",(row.id,row.id)).await?;
        if occupied.is_some() { return Ok(projection::Effects::default()); }
        let selection = row.selection();
        let input = session::SetupChatSessionInput {
            user_id:row.executor_owner_user_id, owner_user_id:row.executor_owner_user_id.try_into().map_err(dependency)?, continuation,
            pipeline: team.json.0["spec"]["collaborationModel"] == "pipeline",
            history_window:None,team_id:team.id,bot_ids:&bots.bot_ids,create_assistant:true,
            model_override_type:selection["model_type"].as_str(),model_options:selection["model_options"].as_object().map(|_| &selection["model_options"]),
            input_text:&prompt,user_result:None,additional_skills:&[],
            crd:TaskCrdInput {
                task_id:0,team_name:&team.name,team_namespace:&team.namespace,team_user_id:team.user_id,message:&prompt,title:Some(&issue.title),
                task_type:Some("chat"),source:"project_automation",project_id:0,api_key_name:None,model_id:selection["model"].as_str().filter(|model|!model.is_empty()),
                force_override_bot_model:selection["model"].as_str().is_some_and(|model|!model.is_empty()),is_group_chat:false,is_api_call:false,auto_delete_executor:Some("true"),omit_mcp_binary_output:false,device_id:None,knowledge_base_refs:&[],git_workspace:false,created_at:&now,updated_at:&now,
            },
            repository:WorkspaceRepository {git_url:"",git_repo:"",git_repo_id:0,git_domain:"",branch_name:""},client_origin:"frontend",project_id:0,created_at:&now,updated_at:&now,completed_at:"1970-01-01 00:00:00",
        };
        let setup = session::setup_chat_session(app.task_store.as_ref(),tx,&input).await.map_err(dependency)?;
        let execute = managed::Execute {task_id:setup.task_id,assistant_subtask_id:setup.assistant_subtask_id,user_subtask_id:setup.user_subtask_id,team_id:row.team_id,user_id:row.executor_owner_user_id,prompt,developer_instruction:context["system_prompt"].as_str().unwrap_or_default().to_owned()};
        let mut intent = row.intent();
        intent["managed_task"] = serde_json::to_value(execute).map_err(dependency)?;
        persist(app,tx,&row,&issue,&setup,chat,intent).await
    }).await?;
    projection::publish(app, effects).await
}

async fn persist(
    app: &AppState,
    tx: &mut impl MysqlTransaction,
    row: &Execution,
    issue: &store::Node,
    setup: &session::ChatSessionSetup,
    chat: bool,
    intent: Value,
) -> brz_mysql::MysqlResult<projection::Effects> {
    let mut document = setup.task_json.clone();
    let labels = &mut document["metadata"]["labels"];
    labels["source"] = json!("project_automation");
    labels["projectRobotExecutionId"] = json!(row.id.to_string());
    labels["projectAutomationSubtaskId"] = json!(setup.assistant_subtask_id.to_string());
    let context = row.context();
    labels["projectGroupExecution"] =
        json!(wegent_project_coordination::project_execution::is_group_execution(&context));
    if context["dispatch_role"] == "member" {
        labels["dispatchRole"] = json!("executor");
    }
    if context["dispatch_role"] == "manager" {
        labels["projectAutomationManagerSubtaskId"] = json!(setup.assistant_subtask_id.to_string());
    }
    labels["projectAutomationTeamId"] = json!(row.team_id.to_string());
    labels["weworkSpaceProjectId"] = json!(row.cloud_project_id);
    labels["weworkSpaceTaskId"] = json!(row.loop_item_id);
    if chat {
        labels["managedTransport"] = json!("chat_shell");
    } else if let Some(labels) = labels.as_object_mut() {
        labels.remove("managedTransport");
    }
    tx.execute(
        format!(
            "UPDATE {} SET json=? WHERE id=? AND user_id=?",
            app.task_store.table_templates().tasks
        ),
        (Json(document), setup.task_id, row.executor_owner_user_id),
    )
    .await?;
    tx.execute("UPDATE loop_item_executions SET status='claimed',backend_task_id=?,runtime_task_id=?,execution_payload=?,claimed_at=UTC_TIMESTAMP(6),version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(setup.task_id,setup.task_id.to_string(),intent.to_string(),row.id)).await?;
    let existing: Option<(String,)> = tx.fetch_optional("SELECT id FROM loop_items WHERE resource_type='execution' AND loop_item_id=? AND backend_task_id=? AND task_user_id=? AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) LIMIT 1",(issue.id.as_str(),setup.task_id,row.executor_owner_user_id)).await?;
    if existing.is_none() {
        store::insert(tx,"execution",json!({"cloud_project_id":row.cloud_project_id,"loop_item_id":issue.id,"task_user_id":row.executor_owner_user_id,"backend_task_id":setup.task_id,"task_id":setup.task_id.to_string(),"task_title":issue.title,"linked_by_user_id":row.assigner_user_id,"linked_at":chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string()})).await?;
    }
    let mut effects = projection::Effects::default();
    {
        let mut message = projection::ensure_managed_activity(tx, row).await?;
        message.runtime_device_id.clear();
        message.runtime_task_id = setup.task_id.to_string();
        message.metadata.0["execution_id"] = json!(row.id);
        if let Some(role) = context["dispatch_role"].as_str() {
            message.metadata.0["dispatch_role"] = json!(role);
        }
        message.metadata.0["backend_task_id"] = json!(setup.task_id);
        let origin = crate::config::env_or_dotenv("FRONTEND_URL")
            .unwrap_or_else(|| "http://localhost:3000".into());
        message.metadata.0["execution_url"] = json!(format!(
            "{}/chat?taskId={}",
            origin.trim_end_matches('/'),
            setup.task_id
        ));
        projection::save_message(tx, &message).await?;
        tx.execute(
            "UPDATE project_chat_messages SET runtime_device_id='',runtime_task_id=? WHERE id=?",
            (message.runtime_task_id.as_str(), message.id),
        )
        .await?;
        effects.messages.push(message);
    }
    Ok(effects)
}
