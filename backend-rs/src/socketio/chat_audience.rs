//! Publication uses persisted container identity and current group grants.
use super::device_runtime_event::{project_chat_room, runtime_user_room};
use crate::http_compat::FastApiError;
use brz_mysql::{FromMysqlRow, Mysql};
use serde_json::Value;

#[derive(FromMysqlRow)]
struct Container {
    resource_type: String,
    status: Option<String>,
}

#[derive(FromMysqlRow)]
pub(crate) struct GroupRecipient {
    pub id: i64,
}

pub(crate) const GROUP_USERS_SQL: &str = "SELECT u.id AS id FROM loop_items g JOIN resource_members m ON m.resource_type='CollaborationChatGroup' AND m.resource_id=CAST(g.id AS SIGNED) AND m.entity_type='user' AND m.status='approved' AND m.role IN ('Owner','Maintainer','Developer','Viewer') JOIN users u ON u.id=CAST(m.entity_id AS SIGNED) AND CAST(m.entity_id AS BINARY)=CAST(u.id AS BINARY) AND u.id>0 AND u.is_active=1 WHERE g.id=? AND g.resource_type='chat_group' AND g.status IN ('active','archived') AND (g.deleted_at IS NULL OR g.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND (?='' OR EXISTS (SELECT 1 FROM loop_items t WHERE t.id=? AND t.cloud_project_id=g.id AND t.resource_type='task' AND (t.deleted_at IS NULL OR t.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))))";

pub(crate) async fn notification_allowed<M: Mysql>(
    db: &M,
    user: i64,
    payload: &Value,
) -> Result<bool, brz_mysql::MysqlError> {
    let Some(group) = payload["groupId"]
        .as_str()
        .or_else(|| payload["projectId"].as_str())
    else {
        return Ok(true);
    };
    let root: Option<(String,)> = db
        .fetch_optional("SELECT resource_type FROM loop_items WHERE id=?", (group,))
        .await?;
    if root.is_some_and(|root| root.0 != "chat_group") {
        return Ok(payload["groupId"].is_null());
    }
    let thread = payload["itemId"].as_str().unwrap_or_default();
    let members: Vec<GroupRecipient> = db
        .fetch_all(GROUP_USERS_SQL, (group, thread, thread))
        .await?;
    if !members.iter().any(|member| member.id == user) {
        return Ok(false);
    }
    if thread.is_empty() {
        return Ok(true);
    }
    let Ok(user) = i32::try_from(user) else {
        return Ok(false);
    };
    let joined: Option<(String,)> = db.fetch_optional(
        "SELECT id FROM loop_items WHERE id=? AND resource_type='thread_participant' AND parent_id=? AND user_id=? AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.notifications')),'all')='all'",
        (crate::chat_groups::participant_id(thread,user),thread,user),
    ).await?;
    Ok(joined.is_some())
}

pub(crate) async fn rooms<M: Mysql>(
    db: &M,
    container: &str,
    thread: Option<&str>,
) -> Result<Vec<String>, FastApiError> {
    let fail = |_| {
        FastApiError::detail(
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
            "Chat audience unavailable",
        )
    };
    let root: Option<Container> = db.fetch_optional("SELECT resource_type,status FROM loop_items WHERE id=? AND resource_type IN ('project','chat_group') AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",(container,)).await.map_err(fail)?;
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    if root.resource_type == "project" {
        return Ok(vec![project_chat_room(container, thread)]);
    }
    if !matches!(root.status.as_deref(), Some("active" | "archived")) {
        return Ok(Vec::new());
    }
    let users: Vec<GroupRecipient> = db
        .fetch_all(
            GROUP_USERS_SQL,
            (
                container,
                thread.unwrap_or_default(),
                thread.unwrap_or_default(),
            ),
        )
        .await
        .map_err(fail)?;
    Ok(users
        .into_iter()
        .map(|user| runtime_user_room(user.id))
        .collect())
}
