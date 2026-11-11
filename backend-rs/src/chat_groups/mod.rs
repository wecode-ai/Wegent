//! Independent group identity and explicit Thread participation reuse the unified node store.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{http_compat::FastApiError, loop_tasks::auth::FlexibleUser, state::AppState};
mod configuration;
#[cfg(test)]
mod group_authority_tests;
#[cfg(test)]
pub(crate) use group_authority_tests::verify_group_account_order;
mod members;
mod participation;
pub(crate) use participation::participant_id;
mod project_authority;
#[cfg(test)]
mod project_authority_tests;
#[cfg(test)]
pub(crate) use project_authority_tests::verify_project_classification_facts;
mod project_link;
pub(crate) mod repository;

#[brz_http_server::get("/api/v1/chat-group-navigation")]
async fn navigation(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    #[derive(FromMysqlRow, serde::Serialize)]
    struct Entry {
        id: String,
        group_id: String,
        title: Option<String>,
        status: Option<String>,
    }
    let rows: Vec<Entry> = state.mysql.fetch_all(format!("SELECT t.id,t.cloud_project_id AS group_id,t.title,t.status FROM loop_items g {} JOIN loop_items t ON t.cloud_project_id=g.id AND t.resource_type='task' JOIN loop_items p ON p.parent_id=t.id AND p.resource_type='thread_participant' AND p.user_id=? AND p.status='active' WHERE g.resource_type='chat_group' AND g.status='active' AND {} AND (t.deleted_at IS NULL OR t.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND (p.deleted_at IS NULL OR p.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND COALESCE(t.status,'') NOT IN ('completed','cancelled','archived') ORDER BY t.updated_at DESC,t.id",repository::GRANTS,repository::ACTIVE),(user.id,user.id,user.id)).await.map_err(internal)?;
    Ok(json!({"items":rows}))
}

fn error(code: u16, message: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        message,
    )
}
pub(crate) fn internal(cause: brz_mysql::MysqlError) -> FastApiError {
    if let brz_mysql::MysqlError::InvalidQuery { reason } = &cause
        && let Some(reason) = reason.strip_prefix("chat-group:")
        && let Some((code, message)) = reason.split_once(':')
        && let Ok(code) = code.parse()
    {
        return error(code, message);
    }
    tracing::error!(%cause,"chat group persistence failed");
    error(500, "Chat group operation failed")
}
pub(crate) fn reject(code: u16, message: &str) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: format!("chat-group:{code}:{message}"),
    }
}
fn numeric_id() -> Result<String, FastApiError> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).map_err(|_| error(500, "Cannot allocate group identity"))?;
    Ok((u64::from_be_bytes(bytes) & i64::MAX as u64)
        .max(1)
        .to_string())
}
fn group_key(id: &str) -> String {
    let mut value: u64 = id.parse().expect("server allocated numeric identity");
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[(value % 36) as usize] as char);
        value /= 36;
    }
    format!("G{}", digits.into_iter().rev().collect::<String>())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    member_ids: Vec<i32>,
}
impl Create {
    fn validate(&self) -> Result<(), FastApiError> {
        if self.name.trim().is_empty()
            || self.name.chars().count() > 255
            || self.description.chars().count() > 10000
            || self.member_ids.len() > 100
            || self.member_ids.iter().any(|id| *id <= 0)
        {
            return Err(error(422, "Invalid group name or members"));
        }
        Ok(())
    }
}
#[brz_http_server::get("/api/v1/chat-groups")]
async fn list(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    Ok(json!({"items":repository::list(&state.mysql,user.id).await?}))
}
#[brz_http_server::get("/api/v1/chat-groups/:group_id")]
async fn get(
    #[inject(state)] state: &AppState,
    group_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let group = repository::access(&state.mysql, group_id, user.id).await?;
    Ok(json!({"group":group,"members":repository::members(&state.mysql,group_id).await?}))
}
#[brz_http_server::post("/api/v1/chat-groups")]
async fn create(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: Create =
        serde_json::from_value(body).map_err(|_| error(422, "Invalid group request"))?;
    input.validate()?;
    let id = numeric_id()?;
    let key = group_key(&id);
    let mut members = input.member_ids.clone();
    members.push(user.id);
    members.sort_unstable();
    members.dedup();
    state.mysql.with_transaction(async |tx|{
        let required=crate::loop_node_storage::required_columns(tx).await?;
        let sql=crate::loop_node_storage::insert_sql(&["id","resource_type","project_space","public_id","project_key","storage_prefix","name","description","status","metadata","created_by_user_id","next_item_number","sort_order","assignee_agent_id","version","created_at","updated_at"],&["?","'chat_group'","'default'","?","?","?","?","?","'active'","?","?","1","0","''","1","UTC_TIMESTAMP()","UTC_TIMESTAMP()"],&required);
        tx.execute(sql,(id.as_str(),id.as_str(),key.as_str(),format!("groups/{id}"),input.name.trim(),input.description.as_str(),Json(json!({"task_provider":"local","default_issue_security":"open"})),user.id)).await?;
        for member in &members {
            tx.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,user_id,role,status,invited_by_user_id,created_at,updated_at) VALUES('CollaborationChatGroup',?,'user',?,?,?,'approved',?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",(id.as_str(),member.to_string(),*member,if *member==user.id{"Owner"}else{"Developer"},user.id)).await?;
        }
        let active=repository::lock_active_accounts(tx,user.id,members.iter().copied()).await?;
        if members.iter().any(|member| !active.contains(member)) {
            return Err(reject(422,"Group member is unavailable"));
        }
        Ok(())
    }).await.map_err(internal)?;
    Ok(
        json!({"group":repository::access(&state.mysql,&id,user.id).await?,"members":repository::members(&state.mysql,&id).await?}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    version: i64,
    name: String,
    #[serde(default)]
    description: String,
    status: String,
    #[serde(default)]
    configuration: Option<Value>,
}
#[brz_http_server::patch("/api/v1/chat-groups/:group_id")]
async fn update(
    #[inject(state)] state: &AppState,
    group_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: Update =
        serde_json::from_value(body).map_err(|_| error(422, "Invalid group update"))?;
    if input.version < 1
        || input.name.trim().is_empty()
        || input.name.chars().count() > 255
        || !matches!(input.status.as_str(), "active" | "archived")
    {
        return Err(error(422, "Invalid group update"));
    }
    let configuration = input
        .configuration
        .as_ref()
        .map(configuration::normalize)
        .transpose()?
        .unwrap_or_else(|| json!({}));
    state.mysql.with_transaction(async |tx| {
        let group = repository::lock_access(tx, group_id, user.id).await?;
        if !group.can_manage() {
            return Err(reject(403, "Group management requires administrator access"));
        }
        if input.status == "archived" {
            #[derive(FromMysqlRow)]
            struct Running { id: i64 }
            let running:Option<Running>=tx.fetch_optional("SELECT id FROM loop_item_executions WHERE cloud_project_id=? AND status NOT IN ('completed','failed','cancelled') LIMIT 1 FOR UPDATE",(group_id,)).await?;
            if running.is_some_and(|run| run.id > 0) {
                return Err(reject(409,"Stop active executions before archiving the group"));
            }
        }
        let changed=tx.execute("UPDATE loop_items SET name=?,description=?,status=?,metadata=JSON_MERGE_PATCH(COALESCE(metadata,JSON_OBJECT()),?),version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=? AND resource_type='chat_group' AND version=?",(input.name.trim(),input.description.as_str(),input.status.as_str(),Json(configuration.clone()),group_id,input.version)).await?;
        if changed.rows_affected != 1 {
            return Err(reject(409, "Group changed; refresh and try again"));
        }
        Ok(())
    }).await.map_err(internal)?;
    Ok(json!({"group":repository::access(&state.mysql,group_id,user.id).await?}))
}
#[brz_http_server::get("/api/v1/chat-groups/:group_id/members")]
async fn members(
    #[inject(state)] state: &AppState,
    group_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    repository::access(&state.mysql, group_id, user.id).await?;
    Ok(json!({"items":repository::members(&state.mysql,group_id).await?}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_group_identity_and_explicit_invites() {
        assert!(
            Create {
                name: "  ".into(),
                description: String::new(),
                member_ids: vec![]
            }
            .validate()
            .is_err()
        );
        assert!(
            Create {
                name: "Group".into(),
                description: String::new(),
                member_ids: vec![0]
            }
            .validate()
            .is_err()
        );
        assert!(
            Create {
                name: "Group".into(),
                description: String::new(),
                member_ids: vec![]
            }
            .validate()
            .is_ok()
        );
    }
    #[test]
    fn ids_fit_the_existing_relationship_store() {
        let a = numeric_id().unwrap();
        let b = numeric_id().unwrap();
        assert!(a.parse::<i64>().unwrap() > 0);
        assert_ne!(a, b);
    }
}
