// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Recoverable lifecycle operations, separate from active collaboration access.
//! Archived spaces are recoverable only by their current owner. Project recovery
//! uses the canonical CP policy and requires an active parent and Maintainer role.

use super::collaboration_access::{
    authorized_lifecycle_projects, lifecycle_access_sql, projects_from_rows,
};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlError, MysqlTransaction};
use chrono::NaiveDateTime;
use serde_json::{Value, json};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecycleBinItem {
    id: String,
    kind: &'static str,
    name: String,
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    deleted_at: String,
    version: i64,
    parent_deleted: bool,
}

#[derive(FromMysqlRow)]
struct DeletedWorkspace {
    id: i64,
    name: String,
    version: i64,
    updated_at: NaiveDateTime,
}

fn workspace_sql(user_id: i32, id: Option<i64>) -> String {
    let target = id
        .map(|id| format!("AND kinds.id = {id}"))
        .unwrap_or_default();
    format!(
        "SELECT kinds.id, kinds.name, \
         COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(kinds.json, '$.status.version')) AS SIGNED), 1) AS version, \
         kinds.updated_at FROM kinds \
         JOIN users AS caller ON caller.id = {user_id} AND caller.is_active = true \
         WHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active = false \
         AND kinds.user_id = {user_id} {target} ORDER BY kinds.updated_at DESC, kinds.id"
    )
}

fn internal(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "Recycle bin operation failed");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Recycle bin operation failed",
    )
}

#[brz_http_server::get("/api/v1/recycle-bin")]
async fn list_recycle_bin(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<Value, FastApiError> {
    list_items(&state.mysql, current_user.0.id).await
}

async fn list_items<M: Mysql>(mysql: &M, user_id: i32) -> Result<Value, FastApiError> {
    let spaces: Vec<DeletedWorkspace> = mysql
        .fetch_all(workspace_sql(user_id, None), ())
        .await
        .map_err(internal)?;
    let projects = authorized_lifecycle_projects(mysql, user_id, None, None, true)
        .await
        .map_err(internal)?;
    let mut items: Vec<RecycleBinItem> = spaces
        .into_iter()
        .map(|space| RecycleBinItem {
            id: space.id.to_string(),
            kind: "workspace",
            name: space.name,
            workspace_id: None,
            workspace_name: None,
            deleted_at: space.updated_at.and_utc().to_rfc3339(),
            version: space.version,
            parent_deleted: false,
        })
        .collect();
    items.extend(projects.into_iter().filter(|p| p.priority <= 1).map(|p| {
        RecycleBinItem {
            id: p.project.id,
            kind: "project",
            name: p.project.name.unwrap_or_default(),
            workspace_id: Some(p.workspace.id),
            workspace_name: Some(p.workspace.name),
            deleted_at: p
                .project
                .updated_at
                .map(|t| t.and_utc().to_rfc3339())
                .unwrap_or_default(),
            version: p.project.version,
            parent_deleted: !p.workspace_active,
        }
    }));
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(a.id.cmp(&b.id)));
    Ok(json!({ "items": items }))
}

fn denied(status: &str) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: format!("recycle-bin:{status}"),
    }
}

fn restore_error(error: MysqlError) -> FastApiError {
    if let MysqlError::InvalidQuery { reason } = &error {
        match reason.as_str() {
            "recycle-bin:not-found" => {
                return FastApiError::detail(StatusCode::NOT_FOUND, "Deleted resource not found");
            }
            "recycle-bin:parent" => {
                return FastApiError::detail(
                    StatusCode::CONFLICT,
                    "Restore the parent space first",
                );
            }
            "recycle-bin:version" => {
                return FastApiError::detail(
                    StatusCode::CONFLICT,
                    "Deleted resource changed; refresh the recycle bin",
                );
            }
            _ => {}
        }
    }
    internal(error)
}

#[brz_http_server::post("/api/v1/recycle-bin/:kind/:resource_id/restore")]
#[tracing::instrument(name = "collaboration.resource.restore", skip_all, fields(resource_kind = kind, resource_id))]
async fn restore_resource(
    #[inject(state)] state: &AppState,
    kind: &str,
    resource_id: &str,
    #[auth] current_user: SessionUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let (id, version) = restore_input(kind, resource_id, &body)?;
    state
        .mysql
        .with_transaction(async |tx| {
            restore_in_transaction(tx, current_user.0.id, kind, id, version).await
        })
        .await
        .map_err(restore_error)?;
    Ok(json!({}))
}

fn restore_input(kind: &str, id: &str, body: &Value) -> Result<(i64, i64), FastApiError> {
    let invalid = || {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Expected workspace/project, positive resource ID and version",
        )
    };
    if !matches!(kind, "workspace" | "project") {
        return Err(invalid());
    }
    let id = id
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(invalid)?;
    let version = body
        .get("version")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .ok_or_else(invalid)?;
    Ok((id, version))
}

async fn restore_in_transaction<T: MysqlTransaction>(
    tx: &mut T,
    user_id: i32,
    kind: &str,
    id: i64,
    version: i64,
) -> Result<(), MysqlError> {
    // Serialize lifecycle changes with the versioned target mutation.
    if kind == "workspace" {
        restore_workspace(tx, user_id, id, version).await
    } else {
        restore_project(tx, user_id, id, version).await
    }
}

async fn restore_workspace<T: MysqlTransaction>(
    tx: &mut T,
    user_id: i32,
    id: i64,
    version: i64,
) -> Result<(), MysqlError> {
    let rows: Vec<DeletedWorkspace> = tx
        .fetch_all(
            format!("{} FOR UPDATE", workspace_sql(user_id, Some(id))),
            (),
        )
        .await?;
    let target = rows.first().ok_or_else(|| denied("not-found"))?;
    if target.version != version {
        return Err(denied("version"));
    }
    let result = tx.execute(
            "UPDATE kinds SET is_active = true, updated_at = UTC_TIMESTAMP(), \
             json = JSON_SET(json, '$.status.state', 'active', '$.status.version', ?) \
             WHERE id = ? AND kind = 'CollaborationWorkspace' AND user_id = ? AND is_active = false",
            (version + 1, id, user_id),
        ).await?;
    if result.rows_affected != 1 {
        return Err(denied("version"));
    }
    Ok(())
}

async fn restore_project<T: MysqlTransaction>(
    tx: &mut T,
    user_id: i32,
    id: i64,
    version: i64,
) -> Result<(), MysqlError> {
    // Space deletion takes the same parent-before-project lock order.
    lock_project_recovery_context(tx, id, user_id).await?;
    #[derive(FromMysqlRow)]
    struct LockedProject {
        id: String,
    }
    let locked: Option<LockedProject> = tx.fetch_optional(
            "SELECT id FROM loop_items WHERE id = ? AND resource_type = 'project' AND status = 'archived' FOR UPDATE",
            (id.to_string(),),
        ).await?;
    let _id = locked.ok_or_else(|| denied("not-found"))?.id;
    let rows = tx
        .fetch_all(lifecycle_access_sql(user_id, Some(id), None, true), ())
        .await?;
    let projects = projects_from_rows(rows)?;
    let target = projects.first().ok_or_else(|| denied("not-found"))?;
    validate_project_recovery(
        target.priority,
        target.workspace_active,
        target.project.version,
        version,
    )?;
    let result = tx.execute(
            "UPDATE loop_items SET status = 'active', version = version + 1, updated_at = UTC_TIMESTAMP() \
             WHERE id = ? AND resource_type = 'project' AND status = 'archived' AND version = ?",
            (id.to_string(), version),
        ).await?;
    if result.rows_affected != 1 {
        return Err(denied("version"));
    }
    Ok(())
}

fn validate_project_recovery(
    priority: i64,
    parent_active: bool,
    stored_version: i64,
    version: i64,
) -> Result<(), MysqlError> {
    if priority > 1 {
        return Err(denied("not-found"));
    }
    if !parent_active {
        return Err(denied("parent"));
    }
    if stored_version != version {
        return Err(denied("version"));
    }
    Ok(())
}

async fn lock_project_recovery_context<T: MysqlTransaction>(
    tx: &mut T,
    project_id: i64,
    user_id: i32,
) -> Result<(), MysqlError> {
    #[derive(FromMysqlRow)]
    struct Parent {
        entity_id: String,
    }
    let parents: Vec<Parent> = tx
        .fetch_all(
            "SELECT entity_id FROM resource_members WHERE resource_type = 'CloudProject' \
         AND resource_id = ? AND entity_type = 'workspace' AND status = 'approved' FOR UPDATE",
            (project_id,),
        )
        .await?;
    let first = parents.first().ok_or_else(|| denied("not-found"))?;
    if parents
        .iter()
        .any(|parent| parent.entity_id != first.entity_id)
    {
        return Err(denied("not-found"));
    }
    let workspace_id = first
        .entity_id
        .parse::<i64>()
        .map_err(|_| denied("not-found"))?;
    #[derive(FromMysqlRow)]
    struct Identity {
        #[allow(dead_code)]
        id: i64,
    }
    // Lock the administrative boundary before taking the authorization snapshot.
    // Space archival and ownership transfer must not race project restoration.
    let parent: Option<Identity> = tx
        .fetch_optional(
            "SELECT id FROM kinds WHERE id = ? AND kind = 'CollaborationWorkspace' FOR UPDATE",
            (workspace_id,),
        )
        .await?;
    parent.ok_or_else(|| denied("not-found"))?;
    let _: Vec<Identity> = tx
        .fetch_all(
            "SELECT id FROM resource_members WHERE entity_type = 'user' AND entity_id = ? \
         AND ((resource_type = 'Workspace' AND resource_id = ?) \
         OR (resource_type = 'CloudProject' AND resource_id = ?)) FOR UPDATE",
            (user_id.to_string(), workspace_id, project_id),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::collaboration_access::{access_sql, lifecycle_access_sql};
    use super::*;

    #[test]
    fn recovery_rechecks_administration_parent_and_version() {
        assert!(validate_project_recovery(1, true, 5, 5).is_ok());
        for priority in [2, 4, 5] {
            assert!(matches!(validate_project_recovery(priority, true, 5, 5),
                Err(MysqlError::InvalidQuery { reason }) if reason == "recycle-bin:not-found"));
        }
        assert!(matches!(validate_project_recovery(1, false, 5, 5),
            Err(MysqlError::InvalidQuery { reason }) if reason == "recycle-bin:parent"));
        assert!(matches!(validate_project_recovery(1, true, 5, 4),
            Err(MysqlError::InvalidQuery { reason }) if reason == "recycle-bin:version"));
    }

    #[tokio::test]
    async fn empty_recycle_bin_reads_only_authorized_deleted_catalogs() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert_eq!(list_items(&mysql, 52).await.unwrap(), json!({"items": []}));
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert!(queries[0].sql.contains("kinds.user_id = 52"));
        assert!(queries[1].sql.contains("loop_items.status = 'archived'"));
        assert!(mysql.writes().is_empty());
    }

    #[test]
    fn recycle_bin_preserves_active_permission_policy_and_owner_only_recovery() {
        let active = access_sql(52, None, None);
        assert!(active.contains("loop_items.status = 'active'"));
        assert!(active.contains("AND (kinds.is_active = true)"));
        assert!(!active.contains("kinds.is_active = true OR"));
        let archived = lifecycle_access_sql(52, Some(1001), None, true);
        assert!(archived.contains("loop_items.status = 'archived'"));
        assert!(archived.contains("kinds.is_active = true OR kinds.user_id = 52"));
        for sql in [&active, &archived] {
            assert!(sql.contains("status = 'approved'"));
            assert!(sql.contains("HAVING COUNT(DISTINCT entity_id) = 1"));
            assert!(sql.contains("caller.is_active = true"));
            assert!(sql.contains(
                "ELSE COALESCE(direct_priority, inherited_priority, public_priority, 5)"
            ));
            assert!(!sql.contains("created_by_user_id = 52"));
            assert!(!sql.contains('{'));
        }
        let sql = workspace_sql(52, Some(9));
        assert!(sql.contains("kinds.user_id = 52"));
        assert!(sql.contains("kinds.is_active = false"));
    }

    #[test]
    fn restore_validates_identity_and_version() {
        assert_eq!(
            restore_input("project", "17", &json!({"version": 3})).unwrap(),
            (17, 3)
        );
        for (kind, id, body) in [
            ("other", "17", json!({"version": 3})),
            ("project", "0", json!({"version": 3})),
            ("workspace", "17", json!({})),
            ("project", "17", json!({"version": -1})),
        ] {
            assert!(restore_input(kind, id, &body).is_err());
        }
    }
}
