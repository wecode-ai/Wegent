//! Explicit group grants do not change project, workspace or private-resource access.
use super::{error, internal, reject, repository};
use crate::{http_compat::FastApiError, loop_tasks::auth::FlexibleUser, state::AppState};
use brz_mysql::{FromMysqlRow, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberInput {
    user_id: i32,
    #[serde(default = "developer")]
    role: String,
}
fn developer() -> String {
    "Developer".into()
}

#[derive(FromMysqlRow)]
struct Existing {
    role: String,
}
#[derive(FromMysqlRow)]
struct ActiveUser {
    id: i32,
}

async fn apply(
    state: &AppState,
    group_id: &str,
    user: &FlexibleUser,
    input: MemberInput,
    remove: bool,
) -> Result<(), FastApiError> {
    if input.user_id <= 0 || !matches!(input.role.as_str(), "Maintainer" | "Developer" | "Viewer") {
        return Err(error(422, "Invalid group member"));
    }
    state.mysql.with_transaction(async |tx| {
        repository::lock_group_scope(tx, group_id, user.id).await?;
        if !remove {
            // Acquire the insertion position before account locks: another group's
            // current grant scan can hold its neighboring unique-index gap.
            // This unapproved row is invisible until commit and rolls back on denial.
            // Existing grants, including Owner, remain unchanged by the reservation.
            tx.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,user_id,role,status,invited_by_user_id,created_at,updated_at) VALUES('CollaborationChatGroup',?,'user',?,?,'Viewer','pending',?,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE id=resource_members.id",(group_id,input.user_id.to_string(),input.user_id,user.id)).await?;
        }
        repository::lock_active_accounts(tx, user.id, [input.user_id]).await?;
        let actor = repository::lock_access(tx, group_id, user.id).await?;
        if !actor.can_manage() { return Err(reject(403,"Group administration is required")) }
        if actor.status.as_deref() != Some("active") { return Err(reject(409,"Chat group is archived")) }
        let target: Option<ActiveUser> = tx.fetch_optional("SELECT id FROM users WHERE id=? AND is_active=1 FOR UPDATE",(input.user_id,)).await?;
        if !target.is_some_and(|target|target.id == input.user_id) { return Err(reject(404,"Member not found")) }
        let existing: Option<Existing> = tx.fetch_optional("SELECT role FROM resource_members WHERE resource_type='CollaborationChatGroup' AND resource_id=CAST(? AS SIGNED) AND entity_type='user' AND entity_id=? FOR UPDATE",(group_id,input.user_id.to_string())).await?;
        if existing.as_ref().is_some_and(|member|member.role == "Owner") {
            return Err(reject(409,"The group owner cannot be removed or demoted"));
        }
        if actor.role != "Owner" && (input.role == "Maintainer" || existing.as_ref().is_some_and(|member|member.role == "Maintainer")) {
            return Err(reject(403,"Only the group owner can manage administrators"));
        }
        if remove {
            tx.execute("DELETE FROM resource_members WHERE resource_type='CollaborationChatGroup' AND resource_id=CAST(? AS SIGNED) AND entity_type='user' AND entity_id=?",(group_id,input.user_id.to_string())).await?;
        } else {
            tx.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,user_id,role,status,invited_by_user_id,created_at,updated_at) VALUES('CollaborationChatGroup',?,'user',?,?,?,'approved',?,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE role=VALUES(role),status='approved',updated_at=UTC_TIMESTAMP()",(group_id,input.user_id.to_string(),input.user_id,input.role.as_str(),user.id)).await?;
        }
        Ok(())
    }).await.map_err(internal)
}

#[brz_http_server::post("/api/v1/chat-groups/:group_id/members")]
async fn add(
    #[inject(state)] state: &AppState,
    group_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: MemberInput =
        serde_json::from_value(body).map_err(|_| error(422, "Invalid group member"))?;
    apply(state, group_id, &user, input, false).await?;
    Ok(json!({"items":repository::members(&state.mysql,group_id).await?}))
}

#[brz_http_server::delete("/api/v1/chat-groups/:group_id/members/:user_id")]
async fn remove(
    #[inject(state)] state: &AppState,
    group_id: &str,
    user_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let target = user_id
        .parse()
        .map_err(|_| error(422, "Invalid member identity"))?;
    apply(
        state,
        group_id,
        &user,
        MemberInput {
            user_id: target,
            role: developer(),
        },
        true,
    )
    .await?;
    Ok(json!({"success":true}))
}
