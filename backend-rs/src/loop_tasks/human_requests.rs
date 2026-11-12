//! Durable Issue questions. Read state, execution progress and handoffs are independent.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use brz_redis::Redis;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    assignments::{internal, require_cloud_project_role, require_issue_read_for_user},
    auth::FlexibleUser,
};
use crate::{background_jobs::project::notifications, http_compat::FastApiError, state::AppState};

#[cfg(test)]
#[path = "human_requests_mysql_tests.rs"]
mod mysql_tests;

#[path = "human_request_source.rs"]
mod source_authority;
use source_authority::{RuntimeEvidence, owned_devices as owned_source_devices, require_runtime};

#[derive(FromMysqlRow)]
struct Issue {
    id: String,
    cloud_project_id: String,
    title: Option<String>,
    status: Option<String>,
    assignee_user_id: Option<i64>,
    created_by_user_id: Option<i64>,
    metadata: Option<Json<Value>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    runtime_device_id: String,
    runtime_task_id: String,
    item_id: String,
    question: String,
    #[serde(default)]
    questions: Vec<Value>,
    #[serde(default)]
    blocks_progress: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    version: i64,
    recipient_user_id: Option<i32>,
    #[serde(default)]
    cancel: bool,
    blocks_progress: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReporterOperation {
    SetBlocking,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlockingUpdate {
    #[serde(rename = "operation")]
    _operation: ReporterOperation,
    version: i64,
    blocks_progress: bool,
    runtime_device_id: String,
    runtime_task_id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum HumanRequestUpdate {
    Blocking(BlockingUpdate),
    Assignment(Assignment),
}

fn error(code: StatusCode, message: &str) -> FastApiError {
    FastApiError::detail(code, message)
}

fn request_id(device: &str, task: &str, item: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{device}\0{task}\0{item}")))
}

fn reported_request_id(source_device: &str, payload: &Question) -> String {
    request_id(source_device, &payload.runtime_task_id, &payload.item_id)
}

fn pending(request: &Value) -> bool {
    matches!(request["status"].as_str(), Some("pending" | "answering"))
}

fn requests(issue: &Issue) -> Vec<Value> {
    issue
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.0["human_requests"].as_array())
        .cloned()
        .unwrap_or_default()
}

fn cloud_assignee_user_id(issue: &Issue) -> Option<i64> {
    // Cloud SQL uses zero for an absent person; local user zero is unrelated.
    issue.assignee_user_id.filter(|id| *id > 0)
}

fn responsible_user_id(issue: &Issue) -> Option<i64> {
    let human_leader = issue.metadata.as_ref().and_then(|metadata| {
        let leader = metadata.0.pointer("/collaboration_group/leader")?;
        (leader["kind"] == "human")
            .then_some(leader["id"].as_str()?.parse::<i64>().ok()?)
            .filter(|id| *id > 0)
    });
    cloud_assignee_user_id(issue)
        .or(human_leader)
        .or(issue.created_by_user_id.filter(|id| *id > 0))
}

fn owns_report(
    request: &Value,
    user: i32,
    payload: &BlockingUpdate,
    owned_devices: &[String],
) -> bool {
    request["reported_by_user_id"].as_i64() == Some(i64::from(user))
        && request["runtime_task_id"].as_str() == Some(payload.runtime_task_id.as_str())
        && request["runtime_device_id"]
            .as_str()
            .is_some_and(|device| owned_devices.iter().any(|owned| owned == device))
}

fn update_blocking(
    request: &mut Value,
    user: i32,
    payload: &BlockingUpdate,
    owned_devices: &[String],
    at: &str,
) -> bool {
    let Some(next_version) = payload.version.checked_add(1) else {
        return false;
    };
    if request["status"] != "pending"
        || request["version"].as_i64() != Some(payload.version)
        || !owns_report(request, user, payload, owned_devices)
    {
        return false;
    }
    request["blocks_progress"] = json!(payload.blocks_progress);
    request["version"] = json!(next_version);
    request["updated_at"] = json!(at);
    let mut events = request["events"].as_array().cloned().unwrap_or_default();
    events.push(json!({
        "type":"blocking_changed", "at":at, "user_id":user,
        "blocks_progress":payload.blocks_progress,
    }));
    request["events"] = json!(events);
    true
}

async fn set_blocking(
    state: &AppState,
    issue: &Issue,
    request_id: &str,
    user: i32,
    payload: BlockingUpdate,
) -> Result<Value, FastApiError> {
    if [&payload.runtime_device_id, &payload.runtime_task_id]
        .iter()
        .any(|id| id.is_empty() || id.len() > 255)
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid source identity",
        ));
    }
    let owned_devices =
        owned_source_devices(&state.mysql, i64::from(user), &payload.runtime_device_id).await?;
    let all = requests(issue);
    let request = all
        .iter()
        .find(|request| request["id"] == request_id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Question not found"))?;
    if !owns_report(request, user, &payload, &owned_devices) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only the owning question source can change blocking",
        ));
    }
    let execution_id = require_runtime(
        &state.mysql,
        i64::from(user),
        RuntimeEvidence {
            execution_id: request["source_execution_id"].as_i64(),
            project_id: &issue.cloud_project_id,
            issue_id: &issue.id,
            device_id: request["runtime_device_id"].as_str().unwrap_or_default(),
            task_id: &payload.runtime_task_id,
        },
        &owned_devices,
    )
    .await?;
    let saved = state.mysql.with_transaction(async |tx| {
        let locked: Issue = tx.fetch_one("SELECT id,cloud_project_id,title,status,assignee_user_id,created_by_user_id,metadata FROM loop_items WHERE id=? FOR UPDATE",(issue.id.as_str(),)).await?;
        if matches!(locked.status.as_deref(),Some("completed" | "cancelled" | "archived")) {
            return Ok(None);
        }
        let mut all = requests(&locked);
        let Some(request) = all.iter_mut().find(|request| request["id"] == request_id) else {
            return Ok(None);
        };
        if request["source_execution_id"].as_i64() != Some(execution_id) {
            return Ok(None);
        }
        if !update_blocking(request,user,&payload,&owned_devices,&chrono::Utc::now().to_rfc3339()) {
            return Ok(None);
        }
        let saved = request.clone();
        save_requests(tx,&issue.id,&all).await?;
        Ok(Some(saved))
    }).await.map_err(internal)?;
    let saved = saved.ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Question changed; refresh before updating blocking",
        )
    })?;
    publish_changed(state, issue, user).await;
    Ok(saved)
}

fn may_assign(issue: &Issue, request: &Value, user: i32, role: &str) -> bool {
    if !super::loop_repository::has_permission(role, "Developer") {
        return false;
    }
    let leader = issue
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.0.pointer("/collaboration_group/leader"));
    let leads = leader.is_some_and(|leader| {
        leader["kind"] == "human" && leader["id"].as_str() == Some(user.to_string().as_str())
    });
    let assignee = cloud_assignee_user_id(issue);
    assignee == Some(i64::from(user))
        || leads
        || (assignee.is_none()
            && leader.is_none_or(|leader| leader["kind"] != "human")
            && request["responsible_user_id"].as_i64() == Some(i64::from(user)))
        || super::loop_repository::has_permission(role, "Maintainer")
}

fn capabilities(issue: &Issue, mut request: Value, user: i32, role: &str) -> Value {
    request["can_assign"] = json!(may_assign(issue, &request, user, role));
    request["can_reply"] = json!(
        request["status"] == "pending"
            && request["recipient_user_id"].as_i64() == Some(i64::from(user))
            && super::loop_repository::has_permission(role, "Developer")
    );
    request
}

async fn save_requests(
    tx: &mut impl MysqlTransaction,
    issue: &str,
    requests: &[Value],
) -> brz_mysql::MysqlResult<()> {
    tx.execute(
        "UPDATE loop_items SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.human_requests',CAST(? AS JSON)),version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=?",
        (Json(json!(requests)),issue),
    ).await?;
    tx.execute(
        "DELETE FROM loop_items WHERE parent_id=? AND resource_type='human_request_index'",
        (issue,),
    )
    .await?;
    let required = crate::loop_node_storage::required_columns(tx).await?;
    let insert = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "parent_id",
            "assignee_user_id",
            "name",
            "description",
            "version",
            "sort_order",
            "project_space",
            "assignee_agent_id",
            "next_item_number",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "'human_request_index'",
            "?",
            "?",
            "?",
            "''",
            "1",
            "0",
            "'default'",
            "''",
            "1",
            "UTC_TIMESTAMP()",
            "UTC_TIMESTAMP()",
        ],
        &required,
    );
    for request in requests.iter().filter(|request| pending(request)) {
        let recipient = request["recipient_user_id"]
            .as_i64()
            .or_else(|| request["responsible_user_id"].as_i64());
        if let Some((recipient, id)) = recipient.zip(request["id"].as_str()) {
            tx.execute(
                &insert,
                (
                    super::assignment_index::index_id("human-request", id),
                    issue,
                    recipient,
                    id,
                ),
            )
            .await?;
        }
    }
    Ok(())
}

async fn publish_changed(state: &AppState, issue: &Issue, actor: i32) {
    let result: Result<(),FastApiError> = async {
        let Some(redis) = state.redis.as_ref() else { return Ok(()); };
        let access = require_cloud_project_role(state,&issue.cloud_project_id,actor).await?;
        let members = crate::board_snapshot::members::list_project_members(&state.mysql,&access.project,issue.cloud_project_id.parse().map_err(|_| error(StatusCode::NOT_FOUND,"Project not found"))?,access.workspace_id,actor).await.map_err(internal)?;
        #[derive(FromMysqlRow)] struct Revision { version:i64 }
        let revision: Revision = state.mysql.fetch_one("SELECT version FROM loop_items WHERE id=?",(issue.id.as_str(),)).await.map_err(internal)?;
        let payload = json!({"projectId":issue.cloud_project_id,"itemId":issue.id,"version":revision.version,"reason":"human_input"});
        for member in members {
            let room = format!("wework-runtime:user:{}", member.user_id);
            crate::socketio::runtime::deliver_local_emit(
                "/wework-runtime", "wework:loop_item:changed", &room, None, &payload,
            ).await;
            let message = crate::socketio_emit::emit_message("wework:loop_item:changed",&serde_json::to_string(&json!([payload])).expect("JSON value"),"/wework-runtime",&room);
            redis.publish(crate::socketio_emit::SOCKETIO_CHANNEL,message).await.map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE,"Issue invalidation delivery failed"))?;
        }
        Ok(())
    }.await;
    if let Err(failure) = result {
        tracing::warn!(
            issue_id = issue.id,
            ?failure,
            "Issue handoff invalidation failed after commit"
        );
    }
}

async fn read_issue(state: &AppState, item: &str, user: i32) -> Result<Issue, FastApiError> {
    require_issue_read_for_user(state, item, user).await?;
    state.mysql.fetch_optional(
        "SELECT id,cloud_project_id,title,status,assignee_user_id,created_by_user_id,metadata FROM loop_items WHERE id=? AND resource_type='task' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",
        (item,),
    ).await.map_err(internal)?.ok_or_else(|| error(StatusCode::NOT_FOUND, "Issue not found"))
}

fn require_participation(issue: &Issue, role: &str) -> Result<(), FastApiError> {
    if !super::loop_repository::has_permission(role, "Developer") {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Issue participation requires Developer access",
        ));
    }
    if matches!(
        issue.status.as_deref(),
        Some("completed" | "cancelled" | "archived")
    ) {
        return Err(error(StatusCode::CONFLICT, "Issue has ended"));
    }
    Ok(())
}

async fn require_write(state: &AppState, issue: &Issue, user: i32) -> Result<(), FastApiError> {
    let access = require_cloud_project_role(state, &issue.cloud_project_id, user).await?;
    require_participation(issue, &access.role)
}

#[brz_http_server::get("/api/v1/loop-items/:item_id/human-requests")]
async fn list(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let issue = read_issue(state, item_id, user.id).await?;
    let access = require_cloud_project_role(state, &issue.cloud_project_id, user.id).await?;
    Ok(
        json!({"items": requests(&issue).into_iter().map(|request| capabilities(&issue,request,user.id,&access.role)).collect::<Vec<_>>()}),
    )
}

#[brz_http_server::get("/api/v1/wework-human-requests")]
async fn inbox(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let issues: Vec<Issue> = state.mysql.fetch_all(
        "SELECT DISTINCT issue.id,issue.cloud_project_id,issue.title,issue.status,issue.assignee_user_id,issue.created_by_user_id,issue.metadata,issue.updated_at FROM loop_items target JOIN loop_items issue ON issue.id=target.parent_id WHERE target.resource_type='human_request_index' AND target.assignee_user_id=? AND issue.resource_type='task' AND (issue.deleted_at IS NULL OR issue.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) ORDER BY issue.updated_at DESC",
        (user.id,),
    ).await.map_err(internal)?;
    let mut items = Vec::new();
    for issue in issues {
        if matches!(
            issue.status.as_deref(),
            Some("completed" | "cancelled" | "archived")
        ) {
            continue;
        }
        if let Err(failure) = require_issue_read_for_user(state, &issue.id, user.id).await {
            // Permission revocation removes the question from this user's inbox.
            if matches!(
                failure.status(),
                StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
            ) {
                continue;
            }
            return Err(failure);
        }
        let access = require_cloud_project_role(state, &issue.cloud_project_id, user.id).await?;
        items.extend(
            requests(&issue)
                .into_iter()
                .filter(|request| {
                    pending(request)
                        && (request["recipient_user_id"].as_i64() == Some(i64::from(user.id))
                            || (request["recipient_user_id"].is_null()
                                && request["responsible_user_id"].as_i64()
                                    == Some(i64::from(user.id))))
                })
                .map(|request| capabilities(&issue, request, user.id, &access.role)),
        );
    }
    Ok(json!({"items":items}))
}

/// Runtime owners report native question identities; they cannot settle answers.
#[brz_http_server::post("/api/v1/loop-items/:item_id/human-requests")]
async fn report(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
    payload: Question,
) -> Result<Value, FastApiError> {
    let issue = read_issue(state, item_id, user.id).await?;
    require_write(state, &issue, user.id).await?;
    if payload.question.trim().is_empty()
        || payload.question.len() > 20_000
        || serde_json::to_vec(&payload.questions).map_or(true, |value| value.len() > 40_000)
        || [
            &payload.runtime_device_id,
            &payload.runtime_task_id,
            &payload.item_id,
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 255)
    {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid question identity or content",
        ));
    }
    let identities =
        owned_source_devices(&state.mysql, i64::from(user.id), &payload.runtime_device_id).await?;
    #[derive(FromMysqlRow)]
    struct Source {
        message_id: String,
        thread_root_message_id: String,
        runtime_device_id: String,
        metadata: Option<Json<Value>>,
    }
    let sources: Vec<Source> = state.mysql.fetch_all(
        "SELECT message_id,thread_root_message_id,runtime_device_id,metadata FROM project_chat_messages WHERE project_id=? AND task_id=? AND runtime_task_id=? AND sender_type='agent' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) ORDER BY id DESC",
        (issue.cloud_project_id.as_str(), item_id, payload.runtime_task_id.as_str()),
    ).await.map_err(internal)?;
    let source = sources
        .iter()
        .find(|source| identities.contains(&source.runtime_device_id))
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "Question has no owning Issue execution",
            )
        })?;
    let source_execution_id = require_runtime(
        &state.mysql,
        i64::from(user.id),
        RuntimeEvidence {
            execution_id: source
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.0["execution_id"].as_i64()),
            project_id: &issue.cloud_project_id,
            issue_id: &issue.id,
            device_id: &source.runtime_device_id,
            task_id: &payload.runtime_task_id,
        },
        &identities,
    )
    .await?;
    let root = if source.thread_root_message_id.is_empty() {
        &source.message_id
    } else {
        &source.thread_root_message_id
    };
    let id = reported_request_id(&source.runtime_device_id, &payload);
    let now = chrono::Utc::now().to_rfc3339();
    let responsible = responsible_user_id(&issue).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Assign a responsible person before requesting input",
        )
    })?;
    #[derive(FromMysqlRow)]
    struct UserName {
        user_name: String,
    }
    let responsible_user: Option<UserName> = state
        .mysql
        .fetch_optional("SELECT user_name FROM users WHERE id=?", (responsible,))
        .await
        .map_err(internal)?;
    let notify_responsible = match i32::try_from(responsible) {
        Ok(recipient) => match require_issue_read_for_user(state, item_id, recipient).await {
            Ok(()) => true,
            Err(failure)
                if matches!(
                    failure.status(),
                    StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
                ) =>
            {
                false
            }
            Err(failure) => return Err(failure),
        },
        Err(_) => false,
    };
    let request = json!({
        "id":id, "project_id":issue.cloud_project_id, "issue_id":item_id,
        "issue_title":issue.title, "root_comment_id":root, "source_message_id":source.message_id,
        "runtime_device_id":source.runtime_device_id, "runtime_task_id":payload.runtime_task_id,
        "source_execution_id":source_execution_id,
        "item_id":payload.item_id, "question":payload.question, "questions":payload.questions,
        "recipient_user_id":null, "recipient_name":null, "responsible_user_id":responsible,
        "responsible_user_name":responsible_user.map(|user| user.user_name),
        "blocks_progress":payload.blocks_progress, "status":"pending", "version":1,
        "created_at":now, "updated_at":now, "waiting_since":now, "reported_by_user_id":user.id,
        "events":[{"type":"requested","at":now,"user_id":user.id,"to_user_id":responsible}]
    });
    let (saved,notification) = state.mysql.with_transaction(async |tx| {
        let locked: Issue = tx.fetch_one("SELECT id,cloud_project_id,title,status,assignee_user_id,created_by_user_id,metadata FROM loop_items WHERE id=? FOR UPDATE",(item_id,)).await?;
        if matches!(locked.status.as_deref(),Some("completed" | "cancelled" | "archived")) { return Ok((None,None)); }
        let mut all = requests(&locked);
        if let Some(existing) = all.iter().find(|existing| existing["id"] == request["id"]) { return Ok((Some(existing.clone()),None)); }
        all.push(request.clone());
        save_requests(tx,item_id,&all).await?;
        let notification = if notify_responsible {
            Some(notifications::create_on(tx,state,responsible,i64::from(user.id),"mention","Issue 等待分派人工处理",payload.question.as_str(),json!({"projectId":issue.cloud_project_id,"itemId":item_id,"itemTitle":issue.title,"commentId":root,"humanRequestId":id,"action":"human_input_assignment"})).await?)
        } else { None };
        Ok((Some(request.clone()),notification))
    }).await.map_err(internal)?;
    if let Some(notification) = notification {
        notifications::deliver(state, notification).await;
    }
    publish_changed(state, &issue, user.id).await;
    saved.ok_or_else(|| error(StatusCode::CONFLICT, "Issue has ended"))
}

#[brz_http_server::put("/api/v1/loop-items/:item_id/human-requests/:request_id")]
async fn assign(
    #[inject(state)] state: &AppState,
    item_id: &str,
    request_id: &str,
    #[auth] user: FlexibleUser,
    payload: HumanRequestUpdate,
) -> Result<Value, FastApiError> {
    let issue = read_issue(state, item_id, user.id).await?;
    require_write(state, &issue, user.id).await?;
    let payload = match payload {
        HumanRequestUpdate::Blocking(payload) => {
            return set_blocking(state, &issue, request_id, user.id, payload).await;
        }
        HumanRequestUpdate::Assignment(payload) => payload,
    };
    let all = requests(&issue);
    let request = all
        .iter()
        .find(|request| request["id"] == request_id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Question not found"))?;
    let access = require_cloud_project_role(state, &issue.cloud_project_id, user.id).await?;
    if !may_assign(&issue, request, user.id, &access.role) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Only the responsible participant can assign this question",
        ));
    }
    let recipient = match payload.recipient_user_id {
        Some(recipient) => {
            let target = read_issue(state, item_id, recipient)
                .await
                .map_err(recipient_access_error)?;
            require_write(state, &target, recipient)
                .await
                .map_err(recipient_access_error)?;
            #[derive(FromMysqlRow)]
            struct User {
                user_name: String,
            }
            let row: Option<User> = state
                .mysql
                .fetch_optional(
                    "SELECT user_name FROM users WHERE id=? AND is_active=true",
                    (recipient,),
                )
                .await
                .map_err(internal)?;
            Some((
                recipient,
                row.ok_or_else(|| {
                    error(StatusCode::UNPROCESSABLE_ENTITY, "Recipient is unavailable")
                })?
                .user_name,
            ))
        }
        None if payload.cancel => None,
        None => {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Assign a specific person",
            ));
        }
    };
    let (saved, notification) = state.mysql.with_transaction(async |tx| {
        let locked: Issue = tx.fetch_one("SELECT id,cloud_project_id,title,status,assignee_user_id,created_by_user_id,metadata FROM loop_items WHERE id=? FOR UPDATE",(item_id,)).await?;
        if matches!(locked.status.as_deref(),Some("completed" | "cancelled" | "archived")) { return Ok((None,None)); }
        let mut all = requests(&locked);
        let Some(request) = all.iter_mut().find(|request| request["id"] == request_id) else { return Ok((None,None)); };
        if !may_assign(&locked,request,user.id,&access.role) { return Ok((None,None)); }
        if request["version"].as_i64() != Some(payload.version) || request["status"] != "pending" { return Ok((None,None)); }
        let previous = request["recipient_user_id"].as_i64().or_else(|| request["responsible_user_id"].as_i64());
        let next = recipient.as_ref().map(|(id,_)| i64::from(*id)).or_else(|| request["responsible_user_id"].as_i64());
        let at = chrono::Utc::now().to_rfc3339();
        if previous != next { request["waiting_since"] = json!(at); }
        let mut events = request["events"].as_array().cloned().unwrap_or_default();
        events.push(json!({"type":if payload.cancel { "cancelled" } else { "assigned" },"at":at,"user_id":user.id,"from_user_id":previous,"to_user_id":next}));
        request["events"] = json!(events);
        request["recipient_user_id"] = json!(recipient.as_ref().map(|(id,_)| *id));
        request["recipient_name"] = json!(recipient.as_ref().map(|(_,name)| name));
        if let Some(blocks) = payload.blocks_progress { request["blocks_progress"] = json!(blocks); }
        request["status"] = json!(if payload.cancel { "cancelled" } else { "pending" });
        request["version"] = json!(payload.version+1);
        request["updated_at"] = json!(at);
        let saved = request.clone();
        save_requests(tx,item_id,&all).await?;
        // Transfer acknowledges the obsolete recipient's notification, not the question.
        if let Some(previous) = previous {
            acknowledge_previous_recipient(tx, previous, request_id).await?;
        }
        let notification = if let Some((recipient,_)) = recipient.as_ref().filter(|_| !payload.cancel) {
            Some(notifications::create_on(tx,state,i64::from(*recipient),i64::from(user.id),"mention","Issue 等你处理",saved["question"].as_str().unwrap_or_default(),json!({"projectId":issue.cloud_project_id,"itemId":item_id,"itemTitle":issue.title,"commentId":saved["root_comment_id"],"humanRequestId":request_id,"action":"human_input"})).await?)
        } else { None };
        Ok((Some(saved),notification))
    }).await.map_err(internal)?;
    let saved = saved.ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Question changed; refresh before assigning",
        )
    })?;
    if let Some(notification) = notification {
        notifications::deliver(state, notification).await;
    }
    publish_changed(state, &issue, user.id).await;
    Ok(saved)
}

async fn acknowledge_previous_recipient(
    tx: &mut impl MysqlTransaction,
    previous: i64,
    request_id: &str,
) -> brz_mysql::MysqlResult<()> {
    tx.execute("UPDATE wework_notifications SET is_read=true,read_status_changed_at=UTC_TIMESTAMP() WHERE user_id=? AND is_read=false AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.humanRequestId'))=?",(previous,request_id)).await?;
    Ok(())
}

fn recipient_access_error(failure: FastApiError) -> FastApiError {
    if matches!(
        failure.status(),
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
    ) {
        error(StatusCode::UNPROCESSABLE_ENTITY, "Recipient is unavailable")
    } else {
        failure
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recipient_access_errors_preserve_infrastructure_failures() {
        for status in [StatusCode::FORBIDDEN, StatusCode::NOT_FOUND] {
            assert_eq!(
                recipient_access_error(error(status, "denied")).status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        for status in [
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert_eq!(
                recipient_access_error(error(status, "database unavailable")).status(),
                status
            );
        }
    }
    fn blocking_payload() -> BlockingUpdate {
        serde_json::from_value(json!({
            "operation":"set_blocking", "version":3, "blocks_progress":true,
            "runtime_device_id":"device", "runtime_task_id":"task",
        }))
        .unwrap()
    }

    fn reported_question() -> Value {
        json!({
            "id":"question", "status":"pending", "version":3,
            "reported_by_user_id":9, "runtime_device_id":"device", "runtime_task_id":"task",
            "blocks_progress":false, "recipient_user_id":7, "recipient_name":"Recipient",
            "responsible_user_id":8, "root_comment_id":"original-comment",
            "waiting_since":"2026-11-01T00:00:00Z", "updated_at":"2026-11-01T00:00:00Z",
            "events":[{"type":"requested","user_id":9}],
        })
    }

    #[test]
    fn source_can_change_only_blocking_without_assignment_authority() {
        let mut request = reported_question();
        let before = request.clone();
        let payload = blocking_payload();
        let mut issue = Issue {
            id: "issue".into(),
            cloud_project_id: "project".into(),
            title: None,
            status: Some("in_progress".into()),
            assignee_user_id: Some(7),
            created_by_user_id: Some(8),
            metadata: None,
        };
        assert!(!may_assign(&issue, &request, 9, "Developer"));
        assert!(require_participation(&issue, "Developer").is_ok());
        assert_eq!(
            require_participation(&issue, "Reporter")
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
        issue.status = Some("completed".into());
        assert_eq!(
            require_participation(&issue, "Developer")
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        assert!(update_blocking(
            &mut request,
            9,
            &payload,
            &["device".into()],
            "now"
        ));
        assert_eq!(request["blocks_progress"], true);
        assert_eq!(request["version"], 4);
        assert_eq!(request["updated_at"], "now");
        assert_eq!(
            request["events"][1],
            json!({
                "type":"blocking_changed", "at":"now", "user_id":9, "blocks_progress":true,
            })
        );
        for key in ["blocks_progress", "version", "updated_at", "events"] {
            request.as_object_mut().unwrap().remove(key);
        }
        let mut unchanged = before;
        for key in ["blocks_progress", "version", "updated_at", "events"] {
            unchanged.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(request, unchanged);
    }

    #[test]
    fn blocking_rejects_non_source_stale_version_and_non_pending_status_without_mutation() {
        let payload = blocking_payload();
        for user in [7, 8, 10] {
            let mut request = reported_question();
            let before = request.clone();
            assert!(!update_blocking(
                &mut request,
                user,
                &payload,
                &["device".into()],
                "now"
            ));
            assert_eq!(request, before);
        }
        for (key, value) in [
            ("runtime_task_id", json!("another-task")),
            ("runtime_device_id", json!("another-device")),
            ("reported_by_user_id", Value::Null),
            ("version", json!(2)),
            ("status", json!("answering")),
            ("status", json!("resolved")),
            ("status", json!("cancelled")),
        ] {
            let mut request = reported_question();
            request[key] = value;
            let before = request.clone();
            assert!(!update_blocking(
                &mut request,
                9,
                &payload,
                &["device".into()],
                "now"
            ));
            assert_eq!(request, before);
        }
        let mut request = reported_question();
        let before = request.clone();
        assert!(!update_blocking(&mut request, 9, &payload, &[], "now"));
        assert_eq!(request, before);
    }

    #[test]
    fn blocking_and_assignment_payloads_cannot_be_mixed() {
        let valid = json!({
            "operation":"set_blocking", "version":3, "blocks_progress":true,
            "runtime_device_id":"device", "runtime_task_id":"task",
        });
        assert!(matches!(
            serde_json::from_value::<HumanRequestUpdate>(valid.clone()).unwrap(),
            HumanRequestUpdate::Blocking(_)
        ));
        for (key, value) in [
            ("recipient_user_id", json!(7)),
            ("recipient_user_id", Value::Null),
            ("cancel", json!(false)),
            ("operation", json!("assign")),
            ("blocks_progress", json!("true")),
        ] {
            let mut mixed = valid.clone();
            mixed[key] = value;
            assert!(serde_json::from_value::<HumanRequestUpdate>(mixed).is_err());
        }
        let mut missing_flag = valid;
        missing_flag
            .as_object_mut()
            .unwrap()
            .remove("blocks_progress");
        assert!(serde_json::from_value::<HumanRequestUpdate>(missing_flag).is_err());
        assert!(matches!(
            serde_json::from_value::<HumanRequestUpdate>(
                json!({"version":3,"recipient_user_id":7})
            )
            .unwrap(),
            HumanRequestUpdate::Assignment(_)
        ));
    }

    #[test]
    fn assignment_requires_write_access_and_current_responsibility() {
        let mut issue = Issue {
            id: "issue".into(),
            cloud_project_id: "project".into(),
            title: None,
            status: Some("in_progress".into()),
            assignee_user_id: Some(7),
            created_by_user_id: Some(9),
            metadata: Some(Json(
                json!({"collaboration_group":{"leader":{"kind":"human","id":"8"}}}),
            )),
        };
        let request = json!({"reported_by_user_id":9,"responsible_user_id":9});
        assert!(!may_assign(&issue, &request, 7, "Reporter"));
        assert!(!may_assign(&issue, &request, 10, "Developer"));
        for user in [7, 8] {
            assert!(may_assign(&issue, &request, user, "Developer"));
        }
        assert!(!may_assign(&issue, &request, 9, "Developer"));
        assert!(may_assign(&issue, &request, 10, "Maintainer"));
        issue.metadata = Some(Json(
            json!({"collaboration_group":{"leader":{"kind":"agent","id":"10"}}}),
        ));
        assert!(!may_assign(&issue, &request, 10, "Developer"));
        issue.assignee_user_id = None;
        assert!(may_assign(&issue, &request, 9, "Developer"));
    }
    #[test]
    fn cloud_zero_assignee_preserves_creator_and_leader_responsibility() {
        let mut issue = Issue {
            id: "issue".into(),
            cloud_project_id: "project".into(),
            title: None,
            status: Some("in_progress".into()),
            assignee_user_id: Some(0),
            created_by_user_id: Some(9),
            metadata: None,
        };
        let creator_request = json!({"reported_by_user_id":10,"responsible_user_id":9});
        for unset in [None, Some(0), Some(-1)] {
            issue.assignee_user_id = unset;
            assert_eq!(responsible_user_id(&issue), Some(9));
            assert!(may_assign(&issue, &creator_request, 9, "Developer"));
            assert!(!may_assign(&issue, &creator_request, 9, "Reporter"));
            assert!(!may_assign(&issue, &creator_request, 10, "Developer"));
            assert!(may_assign(&issue, &creator_request, 10, "Maintainer"));
        }
        issue.assignee_user_id = Some(0);
        issue.metadata = Some(Json(
            json!({"collaboration_group":{"leader":{"kind":"human","id":"8"}}}),
        ));
        let leader_request = json!({"reported_by_user_id":10,"responsible_user_id":8});
        assert_eq!(responsible_user_id(&issue), Some(8));
        assert!(may_assign(&issue, &leader_request, 8, "Developer"));
        assert!(!may_assign(&issue, &creator_request, 9, "Developer"));
        issue.assignee_user_id = Some(7);
        assert_eq!(responsible_user_id(&issue), Some(7));
        for user in [7, 8] {
            assert!(may_assign(&issue, &leader_request, user, "Developer"));
        }
        assert!(!may_assign(&issue, &creator_request, 9, "Developer"));
        issue.assignee_user_id = Some(0);
        issue.metadata = Some(Json(
            json!({"collaboration_group":{"leader":{"kind":"agent","id":"8"}}}),
        ));
        assert_eq!(responsible_user_id(&issue), Some(9));
        assert!(may_assign(&issue, &creator_request, 9, "Developer"));
        assert!(!may_assign(&issue, &creator_request, 8, "Developer"));
        issue.created_by_user_id = Some(0);
        assert_eq!(responsible_user_id(&issue), None);
    }
    #[test]
    fn stable_question_identity_is_scoped_to_its_execution() {
        assert_eq!(
            request_id("device", "task", "question"),
            request_id("device", "task", "question")
        );
        assert_ne!(
            request_id("device", "task", "question"),
            request_id("device", "other-task", "question")
        );
        assert_ne!(
            request_id("device", "task", "question"),
            request_id("other-device", "task", "question")
        );
    }
    #[test]
    fn reported_question_uses_persisted_source_identity_not_the_payload_alias() {
        let mut payload = Question {
            runtime_device_id: "app-record-1".into(),
            runtime_task_id: "task".into(),
            item_id: "question".into(),
            question: "Decision".into(),
            questions: vec![],
            blocks_progress: false,
        };
        let first = reported_request_id("source-device", &payload);
        payload.runtime_device_id = "transport-alias".into();
        assert_eq!(first, reported_request_id("source-device", &payload));
        payload.runtime_task_id = "other-task".into();
        assert_ne!(first, reported_request_id("source-device", &payload));
    }
    #[test]
    fn read_or_queued_answer_does_not_resolve_a_question() {
        assert!(pending(&json!({"status":"pending"})));
        assert!(pending(&json!({"status":"answering"})));
        assert!(!pending(&json!({"status":"resolved"})));
        assert!(!pending(&json!({"status":"cancelled"})));
    }
}
