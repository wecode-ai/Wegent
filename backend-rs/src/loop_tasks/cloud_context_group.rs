//! Runtime recovery reads the actual group without consulting project grants.
use serde_json::{Value, json};

use super::http_error::HttpError;
use super::item_response::{ItemReadAuthority, Permissions, response_with_authority};
use super::loop_repository::{CloudContextBindingRow, LoopItemRepository};
use crate::{
    auth::SessionUser, chat_groups::repository, http_compat::FastApiError, state::AppState,
};

pub(super) fn permissions(role: &str, active: bool, joined: bool, status: &str) -> Permissions {
    let writable = active && matches!(role, "Owner" | "Maintainer" | "Developer");
    Permissions {
        edit_content: writable,
        assign: writable,
        comment: writable && joined,
        execute: writable && joined && !matches!(status, "completed" | "cancelled" | "archived"),
    }
}

pub(super) async fn resolve(
    state: &AppState,
    binding: &CloudContextBindingRow,
    user: &SessionUser,
) -> Result<Option<(Value, Value)>, FastApiError> {
    let Some((group, id, joined)) = authority(&state.mysql, binding, user.id).await? else {
        return Ok(None);
    };
    let item = LoopItemRepository::new(&state.mysql)
        .get_task_item_full(&id)
        .await
        .map_err(HttpError::internal)?
        .filter(|item| item.id == id && item.cloud_project_id == group.id)
        .ok_or_else(HttpError::todo_not_found)?;
    let active = group.status.as_deref() == Some("active");
    let authority = ItemReadAuthority {
        can_view_detail: true,
        security_level: "open",
        provider_is_local: true,
        permissions: permissions(
            &group.role,
            active,
            joined,
            item.status.as_deref().unwrap_or(""),
        ),
    };
    let response = response_with_authority(state, &item, user, authority).await?;
    let mut response = serde_json::to_value(response).map_err(|_| HttpError::internal_detail())?;
    response["group_id"] = json!(group.id);
    response["group_name"] = json!(group.name);
    response["joined"] = json!(joined);
    response["can_join"] = json!(!joined && active);
    Ok(Some((projection(&group, user.id)?, response)))
}

pub(super) async fn authority<M: brz_mysql::Mysql>(
    db: &M,
    binding: &CloudContextBindingRow,
    actor: i32,
) -> Result<Option<(repository::Group, String, bool)>, FastApiError> {
    let kind: Option<(String,)> = db
        .fetch_optional(
            "SELECT resource_type FROM loop_items WHERE id=?",
            (binding.cloud_project_id.as_str(),),
        )
        .await
        .map_err(HttpError::internal)?;
    if !kind.is_some_and(|kind| kind.0 == "chat_group") {
        return Ok(None);
    }
    if binding.task_user_id != actor {
        return Err(HttpError::cloud_context_not_found().into());
    }
    let id = binding
        .loop_item_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or_else(HttpError::cloud_context_not_found)?;
    let (_, group) = repository::thread(db, id, actor).await?;
    if group.id != binding.cloud_project_id {
        return Err(HttpError::todo_not_found().into());
    }
    // Current grant/account validation above is independent from participation.
    let joined: Option<(String,)> = db.fetch_optional(
        "SELECT id FROM loop_items WHERE parent_id=? AND user_id=? AND resource_type='thread_participant' AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",
        (id,actor),
    ).await.map_err(HttpError::internal)?;
    let joined = joined.is_some();
    Ok(Some((group, id.to_owned(), joined)))
}

pub(super) fn projection(group: &repository::Group, user: i32) -> Result<Value, FastApiError> {
    let view = serde_json::to_value(group).map_err(|_| HttpError::internal_detail())?;
    let configuration = &view["configuration"];
    Ok(json!({
        "id":group.id,"resource_type":"chat_group","public_id":group.id,
        "project_key":group.project_key,"name":group.name,"description":group.description,
        "status":group.status,"version":group.version,"created_by_user_id":group.created_by_user_id,
        "created_at":group.created_at,"updated_at":group.updated_at,"access_role":group.role,
        "current_user_id":user,"project_store":"backend","task_provider":"local","provider_config":{},
        "tags":configuration["tags"].as_array().cloned().unwrap_or_default(),
        "board_config":configuration["board_config"],"board_views":configuration["board_views"],
        "card_display":configuration["card_display"],
    }))
}
