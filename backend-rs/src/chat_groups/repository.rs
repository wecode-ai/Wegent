//! Chat groups have explicit human grants; project membership grants no group access.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction};
use serde::Serialize;

use super::{error, internal};
use crate::http_compat::FastApiError;

pub(crate) const ACTIVE: &str =
    "(g.deleted_at IS NULL OR g.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";
pub(crate) const COLUMNS: &str = "g.id,g.project_key,g.name,g.description,g.status,g.version,g.created_by_user_id,JSON_OBJECT('board_config',JSON_EXTRACT(g.metadata,'$.board_config'),'board_views',JSON_EXTRACT(g.metadata,'$.board_views'),'card_display',JSON_EXTRACT(g.metadata,'$.card_display'),'tags',JSON_EXTRACT(g.metadata,'$.tags')) AS configuration,DATE_FORMAT(g.created_at,'%Y-%m-%dT%H:%i:%sZ') AS created_at,DATE_FORMAT(g.updated_at,'%Y-%m-%dT%H:%i:%sZ') AS updated_at";
pub(crate) const GRANTS: &str = "JOIN resource_members m ON m.resource_type='CollaborationChatGroup' AND m.resource_id=CAST(g.id AS SIGNED) AND m.entity_type='user' AND CAST(m.entity_id AS BINARY)=CAST(? AS BINARY) AND m.status='approved' AND m.role IN ('Owner','Maintainer','Developer','Viewer') JOIN users actor ON actor.id=? AND actor.is_active=1";

#[derive(FromMysqlRow, Serialize)]
pub(crate) struct Group {
    pub id: String,
    pub project_key: String,
    pub name: Option<String>,
    pub description: String,
    pub status: Option<String>,
    pub version: i64,
    pub created_by_user_id: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
    pub role: String,
    #[serde(serialize_with = "serialize_configuration")]
    pub configuration: Json<serde_json::Value>,
}

fn serialize_configuration<S: serde::Serializer>(
    value: &Json<serde_json::Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut configuration = value.0.clone();
    configuration["board_config"] =
        super::configuration::board_configuration(&configuration["board_config"])
            .map_err(|_| serde::ser::Error::custom("Invalid group board configuration"))?;
    configuration.serialize(serializer)
}

impl Group {
    pub fn can_manage(&self) -> bool {
        matches!(self.role.as_str(), "Owner" | "Maintainer")
    }
    pub fn can_write(&self) -> bool {
        self.role != "Viewer" && self.status.as_deref() == Some("active")
    }
}

pub(crate) async fn access<M: Mysql>(db: &M, id: &str, user: i32) -> Result<Group, FastApiError> {
    db.fetch_optional(format!("SELECT {COLUMNS},m.role FROM loop_items g {GRANTS} WHERE g.id=? AND g.resource_type='chat_group' AND g.status IN ('active','archived') AND {ACTIVE}"), (user,user,id))
        .await.map_err(internal)?.ok_or_else(|| error(404,"Chat group not found"))
}

pub(crate) async fn lock_access<T: MysqlTransaction>(
    db: &mut T,
    id: &str,
    user: i32,
) -> MysqlResult<Group> {
    db.fetch_optional(format!("SELECT {COLUMNS},m.role FROM loop_items g {GRANTS} WHERE g.id=? AND g.resource_type='chat_group' AND g.status IN ('active','archived') AND {ACTIVE} FOR UPDATE"), (user,user,id))
        .await?.ok_or_else(|| super::reject(404,"Chat group not found"))
}

pub(crate) async fn lock_group_users<T: MysqlTransaction>(
    db: &mut T,
    id: &str,
    actor: i32,
    users: impl IntoIterator<Item = i32>,
) -> MysqlResult<std::collections::BTreeSet<i32>> {
    lock_group_scope(db, id, actor).await?;
    lock_active_accounts(db, actor, users).await
}

pub(crate) async fn lock_group_scope<T: MysqlTransaction>(
    db: &mut T,
    id: &str,
    actor: i32,
) -> MysqlResult<()> {
    #[derive(FromMysqlRow)]
    struct Identity {
        id: String,
    }
    let root: Option<Identity> = db.fetch_optional(
        format!("SELECT g.id FROM loop_items g WHERE g.id=? AND g.resource_type='chat_group' AND g.status IN ('active','archived') AND {ACTIVE} FOR UPDATE"), (id,),
    ).await?;
    if root.is_none_or(|root| root.id != id) {
        return Err(super::reject(404, "Chat group not found"));
    }
    let grant: Option<Identity> = db.fetch_optional(
        "SELECT CAST(id AS CHAR) AS id FROM resource_members WHERE resource_type='CollaborationChatGroup' AND resource_id=CAST(? AS SIGNED) AND entity_type='user' AND entity_id=? AND status='approved' AND role IN ('Owner','Maintainer','Developer','Viewer') FOR UPDATE", (id, actor.to_string()),
    ).await?;
    if grant.is_none_or(|grant| grant.id.is_empty()) {
        return Err(super::reject(404, "Chat group not found"));
    }
    Ok(())
}

pub(crate) async fn lock_active_accounts<T: MysqlTransaction>(
    db: &mut T,
    actor: i32,
    users: impl IntoIterator<Item = i32>,
) -> MysqlResult<std::collections::BTreeSet<i32>> {
    #[derive(FromMysqlRow)]
    struct Account {
        id: i32,
        is_active: bool,
    }
    let mut found = std::collections::BTreeSet::new();
    for user in std::iter::once(actor)
        .chain(users)
        .collect::<std::collections::BTreeSet<_>>()
    {
        let account: Option<Account> = db
            .fetch_optional(
                "SELECT id,is_active FROM users WHERE id=? FOR UPDATE",
                (user,),
            )
            .await?;
        if let Some(account) = account.filter(|account| account.is_active) {
            found.insert(account.id);
        }
    }
    Ok(found)
}

pub(crate) async fn lock_thread<T: MysqlTransaction>(
    db: &mut T,
    id: &str,
    group_id: &str,
) -> MysqlResult<Thread> {
    db.fetch_optional("SELECT cloud_project_id AS group_id,status,version FROM loop_items WHERE id=? AND cloud_project_id=? AND resource_type='task' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE",(id,group_id)).await?.ok_or_else(|| super::reject(404,"Thread not found"))
}

/// Messages lock current direct grants, then every canonical account in numeric order.
pub(crate) async fn lock_message_authority<T: MysqlTransaction>(
    tx: &mut T,
    group: &str,
    actor: i32,
) -> MysqlResult<(Group, std::collections::BTreeSet<i32>)> {
    lock_group_scope(tx, group, actor).await?;
    let grants: Vec<(String,)> = tx.fetch_all(
        "SELECT entity_id FROM resource_members WHERE resource_type='CollaborationChatGroup' AND resource_id=CAST(? AS SIGNED) AND entity_type='user' AND status='approved' AND role IN ('Owner','Maintainer','Developer','Viewer') ORDER BY id FOR UPDATE",(group,),
    ).await?;
    let users: std::collections::BTreeSet<i32> = grants
        .into_iter()
        .filter_map(|(id,)| {
            id.parse::<i32>()
                .ok()
                .filter(|user| *user > 0 && user.to_string() == id)
        })
        .collect();
    let active = lock_active_accounts(tx, actor, users).await?;
    let group = lock_access(tx, group, actor).await?;
    if !group.can_write() {
        return Err(super::reject(
            if group.status.as_deref() == Some("archived") {
                409
            } else {
                403
            },
            "Group discussion is not writable",
        ));
    }
    Ok((group, active))
}

pub(crate) async fn list<M: Mysql>(db: &M, user: i32) -> Result<Vec<Group>, FastApiError> {
    db.fetch_all(format!("SELECT {COLUMNS},m.role FROM loop_items g {GRANTS} WHERE g.resource_type='chat_group' AND g.status='active' AND {ACTIVE} ORDER BY g.updated_at DESC,g.id"),(user,user)).await.map_err(internal)
}

#[derive(FromMysqlRow, Serialize)]
pub(crate) struct Member {
    pub user_id: i32,
    pub name: String,
    pub role: String,
}

pub(crate) async fn members<M: Mysql>(db: &M, id: &str) -> Result<Vec<Member>, FastApiError> {
    db.fetch_all("SELECT u.id AS user_id,u.user_name AS name,m.role FROM resource_members m JOIN users u ON u.id=CAST(m.entity_id AS SIGNED) AND CAST(m.entity_id AS BINARY)=CAST(u.id AS BINARY) AND u.is_active=1 WHERE m.resource_type='CollaborationChatGroup' AND m.resource_id=CAST(? AS SIGNED) AND m.entity_type='user' AND m.status='approved' AND m.role IN ('Owner','Maintainer','Developer','Viewer') ORDER BY u.user_name,u.id",(id,)).await.map_err(internal)
}

#[derive(FromMysqlRow)]
pub(crate) struct Thread {
    pub group_id: String,
    pub status: Option<String>,
    pub version: i64,
}

pub(crate) async fn thread<M: Mysql>(
    db: &M,
    id: &str,
    user: i32,
) -> Result<(Thread, Group), FastApiError> {
    let row:Thread=db.fetch_optional("SELECT cloud_project_id AS group_id,status,version FROM loop_items WHERE id=? AND resource_type='task' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",(id,)).await.map_err(internal)?.ok_or_else(||error(404,"Thread not found"))?;
    let group = access(db, &row.group_id, user).await?;
    Ok((row, group))
}
