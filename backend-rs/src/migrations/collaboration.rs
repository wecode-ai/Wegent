//! b8e2c4f6a901: preserve legacy collaboration grants and assignment history.

use super::{
    rows::{insert, select, string, uuid},
    schema_changes::column,
};
use crate::json_compat::python_truthy as truthy;
use brz_mysql::{MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MARKER: &str = "collaboration-storage-b8e2c4f6a901";

fn metadata(value: &Value) -> Value {
    if value.is_object() {
        return value.clone();
    }
    value
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(Value::is_object)
        .unwrap_or(json!({}))
}

async fn member(
    tx: &mut impl MysqlTransaction,
    kind: &str,
    id: &Value,
    entity: (&str, &str),
    user: i64,
    role: &str,
    invited_by: i64,
) -> MysqlResult<()> {
    let (entity, entity_id) = entity;
    let existing = select(
        tx,
        "resource_members",
        &["resource_id"],
        "resource_type=? AND resource_id=? AND entity_type=? AND entity_id=?",
        (kind, string(id), entity, entity_id),
    )
    .await?;
    if !existing.is_empty() {
        return Ok(());
    }
    let mut values = json!({"resource_type":kind,"resource_id":id,"entity_type":entity,"entity_id":entity_id,"user_id":user,"role":role,"status":"approved"});
    if column(tx, "resource_members", "invited_by_user_id").await? {
        values["invited_by_user_id"] = json!(invited_by);
    }
    insert(tx, "resource_members", &values).await?;
    Ok(())
}

pub(super) async fn upgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let projects = select(
        tx,
        "loop_items",
        &["id", "created_by_user_id"],
        "resource_type='project'",
        (),
    )
    .await?;
    let mut by_owner = BTreeMap::new();
    let mut by_project = BTreeMap::new();
    for project in projects {
        let owner = project["created_by_user_id"].as_i64().unwrap_or(0);
        let workspace = match by_owner.get(&owner) {
            Some(id) => *id,
            None => {
                let payload = json!({"apiVersion":"agent.wecode.io/v1","kind":"CollaborationWorkspace","metadata":{"name":"默认协作空间","namespace":"default","publicId":uuid(),"migrationSource":MARKER},"spec":{"description":"","isDefault":true},"status":{"state":"active","version":1}});
                let id=insert(tx,"kinds",&json!({"user_id":owner,"kind":"CollaborationWorkspace","name":"默认协作空间","namespace":"default","json":payload,"is_active":true})).await?;
                by_owner.insert(owner, id);
                if owner != 0 {
                    member(
                        tx,
                        "Workspace",
                        &json!(id),
                        ("user", &owner.to_string()),
                        owner,
                        "Owner",
                        0,
                    )
                    .await?;
                }
                id
            }
        };
        by_project.insert(string(&project["id"]), workspace);
        member(
            tx,
            "CloudProject",
            &project["id"],
            ("workspace", &workspace.to_string()),
            0,
            "Owner",
            owner,
        )
        .await?;
    }
    let members = select(
        tx,
        "resource_members",
        &["resource_id", "entity_id", "user_id", "role"],
        "resource_type='CloudProject' AND entity_type='user' AND status='approved'",
        (),
    )
    .await?;
    for row in members {
        let Some(workspace) = by_project.get(&string(&row["resource_id"])) else {
            continue;
        };
        let user = match row["user_id"].as_i64().filter(|v| *v != 0) {
            Some(user) => user,
            None => string(&row["entity_id"]).parse::<i64>().map_err(|_| {
                brz_mysql::MysqlError::InvalidQuery {
                    reason: "legacy project member has a non-integer user identity".into(),
                }
            })?,
        };
        let role = if row["role"] == "RestrictedAnalyst" {
            "Reporter"
        } else {
            row["role"].as_str().unwrap_or("")
        };
        member(
            tx,
            "Workspace",
            &json!(workspace),
            ("user", &string(&row["entity_id"])),
            user,
            role,
            0,
        )
        .await?;
    }
    let devices = select(
        tx,
        "kinds",
        &["id", "user_id", "name"],
        "kind='Device' AND is_active=1",
        (),
    )
    .await?;
    let devices: BTreeMap<_, _> = devices
        .into_iter()
        .map(|r| {
            (
                (r["user_id"].as_i64().unwrap_or(0), string(&r["name"])),
                r["id"].clone(),
            )
        })
        .collect();
    let agents = select(
        tx,
        "loop_items",
        &[
            "cloud_project_id",
            "created_by_user_id",
            "device_id",
            "metadata",
        ],
        "resource_type='chat_agent'",
        (),
    )
    .await?;
    for agent in agents {
        let Some(workspace) = by_project.get(&string(&agent["cloud_project_id"])) else {
            continue;
        };
        let owner = agent["created_by_user_id"].as_i64().unwrap_or(0);
        let team = metadata(&agent["metadata"])["wegent_team_id"].clone();
        let team = team
            .as_i64()
            .or_else(|| team.as_str().and_then(|s| s.parse::<i64>().ok()));
        if let Some(team) = team.filter(|id| *id != 0) {
            member(
                tx,
                "Team",
                &json!(team),
                ("workspace", &workspace.to_string()),
                0,
                "Developer",
                owner,
            )
            .await?;
        }
        if truthy(&agent["device_id"])
            && let Some(id) = devices.get(&(owner, string(&agent["device_id"])))
        {
            member(
                tx,
                "Device",
                id,
                ("workspace", &workspace.to_string()),
                0,
                "Developer",
                owner,
            )
            .await?;
        }
    }
    let tasks = select(
        tx,
        "loop_items",
        &[
            "id",
            "cloud_project_id",
            "created_by_user_id",
            "assignee_user_id",
            "assignee_agent_id",
            "assignee_team_id",
        ],
        "resource_type='task'",
        (),
    )
    .await?;
    for task in tasks {
        let target = [
            ("assignee_agent_id", "agent"),
            ("assignee_team_id", "agent"),
            ("assignee_user_id", "human"),
        ]
        .into_iter()
        .find(|(key, _)| truthy(&task[*key]));
        let Some((key, kind)) = target else {
            continue;
        };
        insert(tx,"loop_items",&json!({"id":format!("assignment-{}",uuid().replace('-',"")),"resource_type":"comment","cloud_project_id":string(&task["cloud_project_id"]),"loop_item_id":string(&task["id"]),"description":"","created_by_user_id":task["created_by_user_id"].as_i64().unwrap_or(0),"updated_by_user_id":task["created_by_user_id"].as_i64().unwrap_or(0),"status":"active","assignee_agent_id":"","metadata":{"event_type":"assignment","action":"assign","target_type":kind,"target_id":string(&task[key]),"target_name":"","workflow_step":"","notify":false,"trigger":"manual","migration_source":MARKER}})).await?;
    }
    Ok(())
}

pub(super) async fn downgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let workspaces = select(
        tx,
        "kinds",
        &["id", "json"],
        "kind='CollaborationWorkspace'",
        (),
    )
    .await?;
    let comments = select(
        tx,
        "loop_items",
        &["id", "metadata"],
        "resource_type='comment'",
        (),
    )
    .await?;
    for comment in comments {
        if metadata(&comment["metadata"])["migration_source"] == MARKER {
            tx.execute(
                "DELETE FROM loop_items WHERE id=?",
                (comment["id"].as_str().unwrap_or(""),),
            )
            .await?;
        }
    }
    for workspace in workspaces {
        if metadata(&workspace["json"])["metadata"]["migrationSource"] == MARKER {
            let id = workspace["id"].as_i64().unwrap_or(0);
            tx.execute("DELETE FROM resource_members WHERE (resource_type='Workspace' AND resource_id=?) OR (entity_type='workspace' AND entity_id=?)",(id,id.to_string())).await?;
            tx.execute("DELETE FROM kinds WHERE id=?", (id,)).await?;
        }
    }
    Ok(())
}
