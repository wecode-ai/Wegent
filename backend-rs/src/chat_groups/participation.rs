//! Reading, participating and receiving notifications are independent capabilities.
use super::{error, internal, repository};
use crate::{http_compat::FastApiError, loop_tasks::auth::FlexibleUser, state::AppState};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) fn participant_id(thread: &str, user: i32) -> String {
    let digest = Sha256::digest(format!("thread:{thread}:user:{user}"));
    (u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & i64::MAX as u64)
        .to_string()
}
#[derive(FromMysqlRow)]
struct Participant {
    user_id: i32,
    name: String,
    metadata: Option<Json<Value>>,
}

async fn require_participant_identity<T: MysqlTransaction>(
    tx: &mut T,
    id: &str,
    thread: &str,
    user: i32,
) -> MysqlResult<Option<Json<Value>>> {
    #[derive(FromMysqlRow)]
    struct Identity {
        resource_type: String,
        parent_id: Option<String>,
        user_id: Option<i32>,
        metadata: Option<Json<Value>>,
    }
    let existing: Option<Identity> = tx
        .fetch_optional(
            "SELECT resource_type,parent_id,user_id,metadata FROM loop_items WHERE id=? FOR UPDATE",
            (id,),
        )
        .await?;
    if existing.as_ref().is_some_and(|row| {
        row.resource_type != "thread_participant"
            || row.parent_id.as_deref() != Some(thread)
            || row.user_id != Some(user)
    }) {
        return Err(super::reject(409, "Participant identity collision"));
    }
    Ok(existing.and_then(|row| row.metadata))
}
async fn list<M: Mysql>(db: &M, thread: &str, group: &str) -> Result<Vec<Value>, FastApiError> {
    let rows:Vec<Participant>=db.fetch_all("SELECT p.user_id,u.user_name AS name,p.metadata FROM loop_items p JOIN users u ON u.id=p.user_id AND u.is_active=1 JOIN resource_members m ON m.resource_type='CollaborationChatGroup' AND m.resource_id=CAST(? AS SIGNED) AND m.entity_type='user' AND CAST(m.entity_id AS BINARY)=CAST(p.user_id AS BINARY) AND m.status='approved' AND m.role IN ('Owner','Maintainer','Developer','Viewer') WHERE p.parent_id=? AND p.resource_type='thread_participant' AND p.status='active' AND (p.deleted_at IS NULL OR p.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) ORDER BY p.created_at,p.id",(group,thread)).await.map_err(internal)?;
    Ok(rows.into_iter().map(|p|json!({"user_id":p.user_id,"name":p.name,"notifications":p.metadata.and_then(|m|m.0["notifications"].as_str().map(str::to_owned)).unwrap_or_else(||"all".into())})).collect())
}
#[brz_http_server::get("/api/v1/loop-items/:item_id/participation")]
async fn get(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let (thread, group) = repository::thread(&state.mysql, item_id, user.id).await?;
    let participants = list(&state.mysql, item_id, &group.id).await?;
    let joined = participants.iter().any(|p| p["user_id"] == user.id);
    Ok(
        json!({"current_user_id":user.id,"participants":participants,"joined":joined,"can_comment":joined&&group.can_write(),"show_in_sidebar":joined&&group.status.as_deref()==Some("active")&&!matches!(thread.status.as_deref(),Some("completed"|"cancelled"|"archived"))}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    joined: bool,
    #[serde(default)]
    notifications: Option<String>,
}
fn all() -> String {
    "all".into()
}

fn participation_metadata(
    previous: Option<Json<Value>>,
    requested: Option<&str>,
) -> MysqlResult<Json<Value>> {
    let mut metadata = match previous.map(|value| value.0) {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(metadata)) => metadata,
        _ => return Err(super::reject(409, "Invalid participant metadata")),
    };
    let preference = requested
        .map(str::to_owned)
        .or_else(|| {
            metadata
                .get("notifications")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(all);
    if !matches!(preference.as_str(), "all" | "muted") {
        return Err(super::reject(409, "Invalid stored notification preference"));
    }
    metadata.insert("notifications".into(), Value::String(preference));
    Ok(Json(Value::Object(metadata)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invite {
    user_ids: Vec<i32>,
}

#[brz_http_server::post("/api/v1/loop-items/:item_id/participants")]
async fn invite(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: Invite =
        serde_json::from_value(body).map_err(|_| error(422, "Invalid Thread participants"))?;
    if input.user_ids.is_empty()
        || input.user_ids.len() > 50
        || input.user_ids.iter().any(|id| *id <= 0)
    {
        return Err(error(422, "Invalid Thread participants"));
    }
    let (_, group) = repository::thread(&state.mysql, item_id, user.id).await?;
    state.mysql.with_transaction(async |tx| {
        repository::lock_group_users(tx, &group.id, user.id, input.user_ids.iter().copied()).await?;
        let group=repository::lock_access(tx,&group.id,user.id).await?;
        repository::lock_thread(tx,item_id,&group.id).await?;
        if !group.can_write() { return Err(super::reject(403,"Thread participation management is unavailable")) }
        #[derive(FromMysqlRow)] struct Membership { id:String }
        if !group.can_manage() {
            let joined:Option<Membership>=tx.fetch_optional("SELECT id FROM loop_items WHERE id=? AND resource_type='thread_participant' AND parent_id=? AND user_id=? AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE",(participant_id(item_id,user.id),item_id,user.id)).await?;
            if !joined.is_some_and(|row|!row.id.is_empty()) { return Err(super::reject(403,"Join the Thread before inviting participants")) }
        }
        let required=crate::loop_node_storage::required_columns(tx).await?;
        let sql=crate::loop_node_storage::insert_sql(&["id","resource_type","project_space","parent_id","user_id","status","metadata","sort_order","next_item_number","assignee_agent_id","version","created_at","updated_at"],&["?","'thread_participant'","'default'","?","?","'active'","?","0","1","''","1","UTC_TIMESTAMP()","UTC_TIMESTAMP()"],&required);
        let mut targets=input.user_ids.clone(); targets.sort_unstable(); targets.dedup();
        for target in targets {
            repository::lock_access(tx,&group.id,target).await?;
            let _ = require_participant_identity(tx,&participant_id(item_id,target),item_id,target).await?;
            tx.execute(format!("{sql} ON DUPLICATE KEY UPDATE status=IF(parent_id=VALUES(parent_id) AND user_id=VALUES(user_id),'active',status),version=version+1,updated_at=UTC_TIMESTAMP()"),(participant_id(item_id,target),item_id,target,Json(json!({"notifications":"all"})))).await?;
        }
        Ok(())
    }).await.map_err(internal)?;
    get(state, item_id, user).await
}
#[brz_http_server::put("/api/v1/loop-items/:item_id/participation")]
async fn change(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: Change =
        serde_json::from_value(body).map_err(|_| error(422, "Invalid participation request"))?;
    if input
        .notifications
        .as_deref()
        .is_some_and(|value| !matches!(value, "all" | "muted"))
    {
        return Err(error(422, "Invalid notification preference"));
    }
    let (_thread, group) = repository::thread(&state.mysql, item_id, user.id).await?;
    state
        .mysql
        .with_transaction(async |tx| {
            apply_change(
                tx,
                &group.id,
                item_id,
                user.id,
                input.joined,
                input.notifications.as_deref(),
            )
            .await
        })
        .await
        .map_err(internal)?;
    get(state, item_id, user).await
}

pub(super) async fn apply_change<T: MysqlTransaction>(
    tx: &mut T,
    group_id: &str,
    item_id: &str,
    user_id: i32,
    joined: bool,
    notifications: Option<&str>,
) -> MysqlResult<()> {
    let id = participant_id(item_id, user_id);
    let group = repository::lock_access(tx, group_id, user_id).await?;
    repository::lock_thread(tx, item_id, group_id).await?;
    if group.status.as_deref() != Some("active") {
        return Err(super::reject(409, "Chat group is archived"));
    }
    let previous = require_participant_identity(tx, &id, item_id, user_id).await?;
    let metadata = participation_metadata(previous, notifications)?;
    let required = crate::loop_node_storage::required_columns(tx).await?;
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "project_space",
            "parent_id",
            "user_id",
            "status",
            "metadata",
            "sort_order",
            "next_item_number",
            "assignee_agent_id",
            "version",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "'thread_participant'",
            "'default'",
            "?",
            "?",
            "?",
            "?",
            "0",
            "1",
            "''",
            "1",
            "UTC_TIMESTAMP()",
            "UTC_TIMESTAMP()",
        ],
        &required,
    );
    tx.execute(format!("{sql} ON DUPLICATE KEY UPDATE status=IF(parent_id=VALUES(parent_id) AND user_id=VALUES(user_id),VALUES(status),status),metadata=IF(parent_id=VALUES(parent_id) AND user_id=VALUES(user_id),VALUES(metadata),metadata),updated_at=UTC_TIMESTAMP()"),(id.as_str(),item_id,user_id,if joined{"active"}else{"left"},metadata)).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leave_and_rejoin_keep_muted_preferences_and_unrelated_metadata() {
        for joined in [false, true] {
            let input: Change = serde_json::from_value(json!({"joined":joined})).unwrap();
            assert!(input.notifications.is_none());
            let previous = json!({"notifications":"muted","retained":"choice"});
            assert_eq!(
                participation_metadata(
                    Some(Json(previous.clone())),
                    input.notifications.as_deref()
                )
                .unwrap()
                .0,
                previous
            );
        }
        assert_eq!(
            participation_metadata(None, None).unwrap().0,
            json!({"notifications":"all"})
        );
        assert_eq!(
            participation_metadata(
                Some(Json(json!({"notifications":"muted","retained":true}))),
                Some("all")
            )
            .unwrap()
            .0,
            json!({"notifications":"all","retained":true})
        );
    }
    #[test]
    fn participation_keys_bind_both_identities() {
        assert_eq!(participant_id("thread", 7), participant_id("thread", 7));
        assert_ne!(participant_id("thread", 7), participant_id("thread", 8));
        assert_ne!(participant_id("thread", 7), participant_id("other", 7));
        assert!(participant_id("thread", 7).parse::<i64>().is_ok());
    }
}
