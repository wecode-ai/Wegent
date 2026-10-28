//! Resolve effective rental settings and reuse the ordinary Task creation path.
use super::model::{self, Execution, Subscription};
use crate::{
    AppState,
    responses::create::{resolution, session},
    task_creation::{TaskCrdInput, WorkspaceRepository},
};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde_json::{Value, json};

pub(super) struct ContextData {
    pub subscription: Subscription,
    pub execution: Execution,
    pub team: resolution::KindRow,
    pub spec: Value,
    pub username: String,
    /// The request user's `users.preferences` (`NOT NULL`). The source loads
    /// the whole `User` row and hands it to the request builder, so
    /// `_build_skill_data` always sees the stored document.
    pub preferences: String,
    pub workspace: Value,
    pub preserve_history: bool,
    pub bound_task: i64,
    pub device: Option<String>,
}
#[derive(FromMysqlRow)]
struct User {
    user_name: String,
    preferences: String,
}

/// `db.query(User).filter(User.id == user_id).first()` in
/// `_load_subscription_execution_objects`; the row carries both the display
/// name and the preferences document the request builder reads.
async fn load_user<M: Mysql>(mysql: &M, user_id: i64) -> Result<Option<User>> {
    Ok(mysql
        .fetch_optional(
            "SELECT user_name,preferences FROM users WHERE id=?",
            (user_id,),
        )
        .await?)
}
pub(super) async fn load(
    app: &AppState,
    subscription_id: i64,
    execution_id: i64,
) -> Result<Option<ContextData>> {
    let Some(subscription) = model::subscription(&app.mysql, subscription_id, true).await? else {
        return Ok(None);
    };
    let Some(execution) = model::execution(&app.mysql, execution_id).await? else {
        return Ok(None);
    };
    if execution.subscription_id != subscription_id || execution.user_id != subscription.user_id {
        bail!("Subscription execution identity does not match")
    }
    let mut spec = subscription.json.0["spec"].clone();
    let internal = &subscription.json.0["_internal"];
    let rental = internal["is_rental"] == true;
    let source = if rental {
        model::subscription(
            &app.mysql,
            internal["source_subscription_id"].as_i64().unwrap_or(0),
            true,
        )
        .await?
    } else {
        None
    };
    if rental
        && source
            .as_ref()
            .is_none_or(|s| s.json.0["spec"]["visibility"] != "market")
    {
        return Ok(None);
    }
    let effective = source.as_ref().unwrap_or(&subscription);
    if rental {
        let original = &effective.json.0["spec"];
        for key in [
            "teamRef",
            "promptTemplate",
            "workspaceRef",
            "retryCount",
            "timeoutSeconds",
        ] {
            spec[key] = original[key].clone()
        }
        if spec["modelRef"].is_null() {
            spec["modelRef"] = original["modelRef"].clone()
        }
        spec["preserveHistory"] = json!(false);
    }
    let Some(team) = resolution::team_by_id(
        &app.mysql,
        effective.json.0["_internal"]["team_id"]
            .as_i64()
            .unwrap_or(0),
    )
    .await?
    else {
        return Ok(None);
    };
    let Some(user) = load_user(&app.mysql, subscription.user_id).await? else {
        return Ok(None);
    };
    let workspace = if let Some(id) = effective.json.0["_internal"]["workspace_id"]
        .as_i64()
        .filter(|v| *v > 0)
    {
        let row = app
            .task_store
            .list_tasks_by_ids(&[id])
            .await?
            .into_iter()
            .find(|row| {
                crate::internal_callback::completion::task_column::<String>(row, "kind").as_deref()
                    == Some("Workspace")
                    && crate::internal_callback::completion::task_column::<i64>(row, "is_active")
                        == Some(1)
            });
        row.as_ref()
            .and_then(|row| {
                crate::internal_callback::completion::task_column::<Json<Value>>(row, "json")
            })
            .map(|v| v.0["spec"]["repository"].clone())
            .unwrap_or(json!({}))
    } else {
        json!({})
    };
    let device = if spec["executionTarget"]["type"]
        .as_str()
        .unwrap_or("managed")
        != "managed"
    {
        Some(
            spec["executionTarget"]["device_id"]
                .as_str()
                .filter(|v| !v.is_empty())
                .context("Subscription is missing execution target device_id")?
                .into(),
        )
    } else {
        None
    };
    let preserve_history = !rental && spec["preserveHistory"] == true;
    let bound_task = if preserve_history {
        internal["bound_task_id"].as_i64().unwrap_or(0)
    } else {
        0
    };
    Ok(Some(ContextData {
        subscription,
        execution,
        team,
        spec,
        username: user.user_name,
        preferences: user.preferences,
        workspace,
        preserve_history,
        bound_task,
        device,
    }))
}
pub(super) fn title(name: &str, prompt: &str) -> String {
    if prompt.is_empty() {
        return format!("[Subscription] {name}");
    }
    let prefix = prompt.chars().take(50).collect::<String>();
    format!(
        "[Subscription] {name}: {prefix}{}",
        if prompt.chars().count() > 50 {
            "..."
        } else {
            ""
        }
    )
}
pub(super) async fn create(
    app: &AppState,
    data: &ContextData,
    bots: &[i64],
) -> Result<session::ChatSessionSetup> {
    let mut previous = None;
    if data.preserve_history
        && data.bound_task > 0
        && let Some(task) = app.task_store.get_active_task(data.bound_task).await?
    {
        let owner = crate::internal_callback::completion::task_column::<i64>(&task, "user_id");
        let payload =
            crate::internal_callback::completion::task_column::<Json<Value>>(&task, "json")
                .map(|v| v.0)
                .unwrap_or(Value::Null);
        if owner == Some(data.subscription.user_id) {
            let running = matches!(
                payload["status"]["status"].as_str(),
                Some("RUNNING" | "PENDING")
            );
            if !running
                || super::execution::cancel_task(app, data.bound_task, data.subscription.user_id)
                    .await
                    .unwrap_or(false)
            {
                previous = Some(format!("resp_{}", data.bound_task));
            }
        }
    }
    let display = data.spec["displayName"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or(&data.subscription.name);
    let title = title(display, &data.execution.prompt);
    let now = model::iso(chrono::Local::now().naive_local());
    let ws = &data.workspace;
    // The follow-up Task lookup runs on this job's setup handle, matching the
    // source's `previous_response_id` resolution inside the session setup.
    let mut setup_sql: &brz_mysql::MysqlService = &app.mysql;
    let continuation = match previous.as_deref() {
        Some(previous) => crate::responses::create::continuation::resolve(
            app.task_store.as_ref(),
            &mut setup_sql,
            previous,
            data.subscription.user_id.try_into()?,
            &now,
        )
        .await
        .map_err(|e| anyhow::anyhow!("Subscription task creation failed: {e:?}"))?,
        None => None,
    };
    let input = session::SetupChatSessionInput {
        user_id: data.subscription.user_id,
        owner_user_id: data.subscription.user_id.try_into()?,
        continuation,
        team_id: data.team.id,
        bot_ids: bots,
        input_text: &data.execution.prompt,
        crd: TaskCrdInput {
            task_id: 0,
            team_name: &data.team.name,
            team_namespace: &data.team.namespace,
            team_user_id: data.team.user_id,
            message: &data.execution.prompt,
            title: Some(&title),
            task_type: data.device.as_ref().map(|_| "task"),
            source: "chat_shell",
            project_id: 0,
            api_key_name: None,
            model_id: data.spec["modelRef"]["name"].as_str(),
            force_override_bot_model: data.spec["forceOverrideBotModel"] == true,
            is_group_chat: false,
            is_api_call: false,
            auto_delete_executor: None,
            omit_mcp_binary_output: false,
            device_id: data.device.as_deref(),
            git_workspace: ws["gitUrl"].as_str().is_some_and(|v| !v.is_empty()),
            created_at: &now,
            updated_at: &now,
        },
        repository: WorkspaceRepository {
            git_url: ws["gitUrl"].as_str().unwrap_or(""),
            git_repo: ws["gitRepo"].as_str().unwrap_or(""),
            git_repo_id: ws["gitRepoId"].as_i64().unwrap_or(0),
            git_domain: ws["gitDomain"].as_str().unwrap_or(""),
            branch_name: ws["branchName"].as_str().unwrap_or(""),
        },
        client_origin: "frontend",
        project_id: 0,
        created_at: &now,
        updated_at: &now,
        completed_at: "1970-01-01 00:00:00",
    };
    let setup = session::setup_chat_session(app.task_store.as_ref(), &mut setup_sql, &input)
        .await
        .map_err(|e| anyhow::anyhow!("Subscription task creation failed: {e:?}"))?;
    let tables = app.task_store.table_templates();
    let mysql = app
        .mysql
        .route(crate::task_routing::ByTaskId(setup.task_id as u64));
    mysql.with_transaction(async|tx|{let task:Option<brz_mysql::MysqlRow>=tx.fetch_optional(format!("SELECT json FROM {} WHERE id=? AND user_id=? FOR UPDATE",tables.tasks),(setup.task_id,data.subscription.user_id)).await?;if let Some(task)=task{let mut value=task.get_at::<Json<Value>>(0)?.0;labels(&mut value,data.subscription.id,data.execution.id);tx.execute(format!("UPDATE {} SET json=?,is_active=2,updated_at=NOW() WHERE id=? AND user_id=?",tables.tasks),(Json(value),setup.task_id,data.subscription.user_id)).await?;}tx.execute("UPDATE background_executions SET task_id=?,status='RUNNING',started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND subscription_id=? AND status IN ('PENDING','RUNNING','RETRYING')",(setup.task_id,data.execution.id,data.subscription.id)).await?;Ok(())}).await?;
    if data.preserve_history && previous.is_none() {
        app.mysql.with_transaction(async|tx|{tx.execute("UPDATE kinds SET json=JSON_SET(json,'$._internal.bound_task_id',?),updated_at=UTC_TIMESTAMP() WHERE id=? AND kind='Subscription'",(setup.task_id,data.subscription.id)).await?;Ok(())}).await?;
    }
    link_contexts(app, data, &setup).await?;
    Ok(setup)
}

pub(super) async fn pending_session(
    app: &AppState,
    data: &ContextData,
) -> Result<Option<session::ChatSessionSetup>> {
    let tables = app.task_store.table_templates();
    let mysql = app
        .mysql
        .route(crate::task_routing::ByTaskId(data.execution.task_id as u64));
    let task: Option<brz_mysql::MysqlRow> = mysql.fetch_optional(format!("SELECT json FROM {} WHERE id=? AND user_id=? AND kind='Task' AND is_active IN (1,2)",tables.tasks),(data.execution.task_id,data.subscription.user_id)).await?;
    let Some(task) = task else { return Ok(None) };
    let task = task.get_at::<Json<Value>>(0)?.0;
    if task["metadata"]["labels"]["backgroundExecutionId"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        != Some(data.execution.id)
    {
        return Ok(None);
    }
    let assistant: Option<brz_mysql::MysqlRow> = mysql.fetch_optional(format!("SELECT id,message_id,parent_id,executor_name,executor_namespace,created_at FROM {} WHERE task_id=? AND user_id=? AND role='ASSISTANT' AND status='PENDING' ORDER BY message_id DESC LIMIT 1",tables.subtasks),(data.execution.task_id,data.subscription.user_id)).await?;
    let Some(assistant) = assistant else {
        return Ok(None);
    };
    let parent = assistant.get_at::<i64>(2)?;
    let user: Option<brz_mysql::MysqlRow> = mysql.fetch_optional(format!("SELECT id FROM {} WHERE task_id=? AND user_id=? AND role='USER' AND message_id=? LIMIT 1",tables.subtasks),(data.execution.task_id,data.subscription.user_id,parent)).await?;
    let Some(user) = user else { return Ok(None) };
    // The resumed execution reuses this Task row (`session.task` in the
    // source), so the builder gets the effective `project_id` through the same
    // carrier the responses path uses. The flow already selected the CRD, so
    // `_merge_project_workspace`'s label fallback is the applicable one here.
    let workspace_project_id = session::resumed_project_id(None, &task);
    Ok(Some(session::ChatSessionSetup {
        task_json: task,
        workspace_project_id,
        // The background subscription flow does not run the memory step; its
        // projection does not read the physical project column.
        raw_project_id: None,
        task_id: data.execution.task_id,
        workspace_id: 0,
        user_subtask_id: user.get_at(0)?,
        assistant_subtask_id: assistant.get_at(0)?,
        assistant_message_id: assistant.get_at(1)?,
        assistant_executor_name: assistant.get_at(3)?,
        assistant_executor_namespace: assistant.get_at(4)?,
        // The projection does not read `executor_deleted_at`; the follow-up
        // stage's assistant row is the one this request just selected.
        assistant_executor_deleted: false,
        assistant_created_at: assistant.get_at(5)?,
        existing_subtasks: Vec::new(),
    }))
}
pub(crate) fn labels(value: &mut Value, subscription: i64, execution: i64) {
    let labels = &mut value["metadata"]["labels"];
    labels["type"] = json!("subscription");
    labels["userInteracted"] = json!("false");
    labels["subscriptionId"] = json!(subscription.to_string());
    labels["executionId"] = json!(execution.to_string());
    labels["backgroundExecutionId"] = json!(execution.to_string());
    if value["spec"]["device_id"]
        .as_str()
        .is_some_and(|v| !v.is_empty())
    {
        value["metadata"]["labels"]["taskType"] = json!("task")
    }
}
async fn link_contexts(
    app: &AppState,
    data: &ContextData,
    setup: &session::ChatSessionSetup,
) -> Result<()> {
    if let Some(refs) = data.spec["knowledgeBaseRefs"].as_array() {
        for reference in refs {
            let rows:Vec<brz_mysql::MysqlRow>=app.mysql.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='KnowledgeBase' AND namespace=? AND is_active=1",(data.subscription.user_id,reference["namespace"].as_str().unwrap_or("default"))).await?;
            for row in rows {
                let value = row.get_at::<Json<Value>>(1)?.0;
                if value["spec"]["name"] != reference["name"] {
                    continue;
                }
                let id = row.get_at::<i64>(0)?;
                let name = reference["name"].as_str().unwrap_or("");
                app.mysql.with_transaction(async|tx|{tx.execute("INSERT INTO subtask_contexts (subtask_id,user_id,context_type,name,status,error_message,binary_data,image_base64,extracted_text,text_length,type_data,created_at,updated_at) VALUES (?,?,'knowledge_base',?,'ready','',X'','','',0,?,NOW(),NOW())",(setup.user_subtask_id,data.subscription.user_id,name,Json(json!({"knowledge_id":id,"name":name})))).await?;Ok(())}).await?;
                break;
            }
        }
    }
    if data.execution.inbox_message_id > 0 {
        let message: Option<brz_mysql::MysqlRow> = app
            .mysql
            .fetch_optional(
                "SELECT content_snapshot FROM queue_messages WHERE id=?",
                (data.execution.inbox_message_id,),
            )
            .await?;
        if let Some(message) = message {
            let snapshots = message.get_at::<Json<Value>>(0)?.0;
            for snapshot in snapshots.as_array().into_iter().flatten() {
                for id in snapshot["attachmentContextIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        v.as_i64()
                            .or_else(|| v.as_str().and_then(|v| v.parse().ok()))
                    })
                {
                    app.mysql.with_transaction(async|tx|{tx.execute("UPDATE subtask_contexts SET subtask_id=?,updated_at=NOW() WHERE id=? AND user_id=? AND context_type='attachment'",(setup.user_subtask_id,id,data.subscription.user_id)).await?;Ok(())}).await?;
                }
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_title_and_reused_labels_keep_existing_fields() {
        assert_eq!(title("日报", "你好"), "[Subscription] 日报: 你好");
        let mut value =
            json!({"metadata":{"labels":{"modelId":"model"}},"spec":{"device_id":"device"}});
        labels(&mut value, 7, 8);
        assert_eq!(value["metadata"]["labels"]["modelId"], "model");
        assert_eq!(value["metadata"]["labels"]["taskType"], "task");
        assert_eq!(value["metadata"]["labels"]["backgroundExecutionId"], "8");
    }

    /// The subscription builder must read the same `User` row the source
    /// loads, including `preferences`: `_build_skill_data`'s user-managed
    /// provider branch reads `user.preferences`, so the subscription request
    /// cannot pass an absent document while the Python path passes the stored
    /// one.
    #[tokio::test]
    async fn user_read_carries_the_preferences_document() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let user = load_user(&mysql, 42).await.expect("read");
        assert!(user.is_none());
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
