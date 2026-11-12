//! Classifications evaluate locked current facts, never a materialized grant snapshot.
use std::collections::{BTreeMap, BTreeSet};

use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlRow, MysqlTransaction};
use serde_json::Value;

use super::reject;
use crate::cloud_projects::members::{collaboration_role, effective_project_role, has_permission};

#[derive(FromMysqlRow)]
struct ProjectFacts {
    metadata: Option<Json<Value>>,
}

fn inherits(project: &ProjectFacts) -> bool {
    match project
        .metadata
        .as_ref()
        .and_then(|value| value.0.get("membership_mode"))
    {
        None | Some(Value::Null) => true,
        Some(Value::String(mode)) => mode == "inherit",
        _ => false,
    }
}

#[derive(FromMysqlRow)]
struct Grant {
    entity_type: String,
    entity_id: Option<String>,
    role: Option<String>,
    status: Option<String>,
}

#[derive(FromMysqlRow)]
struct WorkspaceFacts {
    user_id: i32,
    kind: String,
    is_active: bool,
}

fn direct_role(grants: &[Grant]) -> Option<&str> {
    grants.iter().find_map(|grant| {
        let role = grant.role.as_deref()?;
        (grant.entity_type == "user"
            && grant.status.as_deref() == Some("approved")
            && matches!(
                role,
                "Owner" | "Maintainer" | "Developer" | "Viewer" | "Reporter"
            ))
        .then(|| collaboration_role(role))
    })
}

async fn actor_grants<T: MysqlTransaction>(
    tx: &mut T,
    kind: &str,
    id: i64,
    actor: i32,
) -> MysqlResult<Vec<Grant>> {
    tx.fetch_all("SELECT entity_type,entity_id,role,status FROM resource_members WHERE resource_type=? AND resource_id=? AND ((entity_type='user' AND entity_id=?) OR (entity_type='authenticated_users' AND entity_id='*')) ORDER BY id FOR UPDATE",(kind,id,actor.to_string().as_str())).await
}

pub(super) async fn lock_project_edits<T: MysqlTransaction>(
    tx: &mut T,
    projects: &BTreeSet<i64>,
    actor: i32,
) -> MysqlResult<()> {
    let user: Option<MysqlRow> = tx
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=1 FOR UPDATE",
            (actor,),
        )
        .await?;
    if user.is_none() {
        return Err(reject(404, "Project not found"));
    }
    let mut facts = BTreeMap::new();
    for id in projects {
        let row: Option<ProjectFacts> = tx.fetch_optional("SELECT metadata FROM loop_items WHERE id=? AND resource_type='project' AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE",(id.to_string().as_str(),)).await?;
        facts.insert(*id, row.ok_or_else(|| reject(404, "Project not found"))?);
    }
    let mut parents = BTreeMap::new();
    for id in projects {
        let rows: Vec<Grant> = tx.fetch_all("SELECT entity_type,entity_id,role,status FROM resource_members WHERE resource_type='CloudProject' AND resource_id=? AND entity_type='workspace' ORDER BY id FOR UPDATE",(*id,)).await?;
        let ids: BTreeSet<_> = rows
            .iter()
            .filter(|row| row.status.as_deref() == Some("approved"))
            .filter_map(|row| row.entity_id.as_deref())
            .collect();
        if ids.len() != 1 {
            return Err(reject(404, "Project not found"));
        }
        let parent = ids
            .first()
            .expect("one parent")
            .parse::<i64>()
            .map_err(|_| reject(404, "Project not found"))?;
        parents.insert(*id, parent);
    }
    let mut workspaces = BTreeMap::new();
    for id in parents.values().copied().collect::<BTreeSet<_>>() {
        let row: Option<WorkspaceFacts> = tx
            .fetch_optional(
                "SELECT user_id,kind,is_active FROM kinds WHERE id=? FOR UPDATE",
                (id,),
            )
            .await?;
        let row = row
            .filter(|row| row.kind == "CollaborationWorkspace" && row.is_active)
            .ok_or_else(|| reject(404, "Project not found"))?;
        workspaces.insert(id, row);
    }
    let mut direct = BTreeMap::new();
    for id in projects {
        direct.insert(*id, actor_grants(tx, "CloudProject", *id, actor).await?);
    }
    let mut inherited = BTreeMap::new();
    for id in workspaces.keys() {
        inherited.insert(*id, actor_grants(tx, "Workspace", *id, actor).await?);
    }
    for id in projects {
        let parent = parents[id];
        let inherited_role = if workspaces[&parent].user_id == actor {
            Some("Maintainer")
        } else {
            direct_role(&inherited[&parent])
                .filter(|role| *role == "Maintainer" || inherits(&facts[id]))
        };
        let grants = &direct[id];
        let role = effective_project_role(direct_role(grants), inherited_role)
            .or_else(|| {
                grants
                    .iter()
                    .any(|row| {
                        row.entity_type == "authenticated_users"
                            && row.status.as_deref() == Some("approved")
                            && matches!(row.role.as_deref(), Some("Viewer" | "Developer"))
                    })
                    .then_some("Viewer")
            })
            .ok_or_else(|| reject(404, "Project not found"))?;
        if !has_permission(role, "Developer") {
            return Err(reject(
                403,
                "Project editing is required to classify a Thread",
            ));
        }
    }
    Ok(())
}
