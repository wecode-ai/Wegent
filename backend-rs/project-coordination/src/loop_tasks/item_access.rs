// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemService._require_item_access`: the project-role and per-item
//! visibility and native Issue invitation guard shared by the loop-item reads.
//!
//! The guard resolves the caller's effective project role, re-reads the
//! project entity, and applies `can_view_item` (maintainers see every item;
//! everyone else needs an `open` item or a related-item relationship).
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectAccess};
use crate::cloud_projects::cloud_project_not_found;
use crate::http_compat::FastApiError;
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow, MysqlTransaction};
use wegent_backend_persistence::mysql_query::MysqlQuery;

use super::http_error::HttpError;
use super::loop_repository::{TaskItemFullRow, has_permission, is_related_item_on};
use crate::cloud_projects::members;
use crate::cloud_projects::{
    CloudMetadataInput, project_access_details, project_access_point_statement, role_for_priority,
};

pub struct ItemReadAccess {
    pub project: members::ProjectEntityRow,
    pub invited_only: bool,
    can_edit: bool,
}

#[derive(Debug, FromMysqlRow)]
pub struct IssueReadScope {
    pub project_id: Option<String>,
    creator_id: Option<i32>,
    participants: Option<Json<Vec<i32>>>,
    security_level: Option<String>,
}

impl IssueReadScope {
    pub fn security_level(&self) -> Option<&str> {
        self.security_level.as_deref()
    }

    pub async fn load(mysql: &impl Mysql, issue_id: &str) -> brz_mysql::MysqlResult<Option<Self>> {
        // Scope changes and invitation revocation take effect on the primary immediately.
        let people = super::issue_invitation::collaborator_people("issue.id", false);
        mysql.with_transaction(async |tx| tx.fetch_optional(
            format!("SELECT NULLIF(cloud_project_id,'') AS project_id, created_by_user_id AS creator_id,
                    CASE WHEN cloud_project_id IS NULL OR cloud_project_id='' THEN
                      {people}
                    END AS participants,
                    CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.security_level'))
                      AS CHAR CHARACTER SET utf8mb4) AS security_level
             FROM loop_items issue WHERE id=? AND resource_type='task'
               AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))"),
            (issue_id,),
        ).await).await
    }

    pub async fn require(
        &self,
        mysql: &brz_mysql::MysqlService,
        issue_id: &str,
        user_id: i32,
    ) -> Result<(), HttpError> {
        if let Some(project_id) = &self.project_id {
            require_project_item_access(
                mysql,
                issue_id,
                project_id,
                self.security_level(),
                user_id,
            )
            .await?;
        } else if !can_read_issue_without_project(
            self.creator_id,
            self.participants
                .as_ref()
                .map_or(&[], |value| value.0.as_slice()),
            user_id,
        ) {
            return Err(HttpError::new(StatusCode::NOT_FOUND, "Issue not found"));
        }
        Ok(())
    }
}

pub fn can_read_issue_without_project(
    creator: Option<i32>,
    participants: &[i32],
    user: i32,
) -> bool {
    creator == Some(user) || participants.contains(&user)
}

/// Resolve project access or a current invitation for this Issue.
pub async fn require_item_access(
    mysql: &brz_mysql::MysqlService,
    item: &TaskItemFullRow,
    user_id: i32,
) -> Result<ItemReadAccess, HttpError> {
    let level = item
        .metadata()
        .and_then(|metadata| metadata.security_level.as_ref())
        .and_then(serde_json::Value::as_str);
    require_project_item_access(mysql, &item.id, &item.cloud_project_id, level, user_id).await
}

async fn require_project_item_access(
    mysql: &brz_mysql::MysqlService,
    issue_id: &str,
    project_id: &str,
    security_level: Option<&str>,
    user_id: i32,
) -> Result<ItemReadAccess, HttpError> {
    // `collaboration_permission_service.check` rejects a non-decimal
    // `cloud_project_id` before any statement runs (404, not 422).
    let project_number: i64 = project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;

    // The access point statement plus the caller's permission-source reads.
    let access = project_access_details(mysql, project_number, user_id)
        .await
        .map_err(HttpError::internal)?;
    let role = access
        .map(|access| role_for_priority(access.priority).ok_or_else(HttpError::internal_detail))
        .transpose()?;
    require_project_item_access_on(
        &mut &*mysql,
        issue_id,
        project_number,
        security_level,
        user_id,
        role,
    )
    .await
}

pub async fn require_project_collaborator_edit(
    query: &mut impl MysqlQuery,
    issue_id: &str,
    project_id: &str,
    security_level: Option<&str>,
    user_id: i32,
) -> Result<(), HttpError> {
    let project_number = project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    let row: Option<MysqlRow> = query
        .fetch_optional(project_access_point_statement(user_id, project_number), ())
        .await
        .map_err(HttpError::internal)?;
    let role = row
        .map(|row| row.get_required("anon_3_priority"))
        .transpose()
        .map_err(HttpError::internal)?
        .map(|priority| role_for_priority(priority).ok_or_else(HttpError::internal_detail))
        .transpose()?;
    let access = require_project_item_access_on(
        query,
        issue_id,
        project_number,
        security_level,
        user_id,
        role,
    )
    .await?;
    if !access.can_edit {
        return Err(HttpError::insufficient_permission());
    }
    Ok(())
}

async fn require_project_item_access_on(
    query: &mut impl MysqlQuery,
    issue_id: &str,
    project_number: i64,
    security_level: Option<&str>,
    user_id: i32,
    role: Option<&str>,
) -> Result<ItemReadAccess, HttpError> {
    if role.is_some_and(|role| !has_permission(role, "Viewer")) {
        return Err(HttpError::insufficient_permission());
    }

    let invited_only = !role.is_some_and(|role| has_permission(role, "Developer"))
        && super::issue_invitation::permits_read_on(query, issue_id, user_id)
            .await
            .map_err(HttpError::internal)?;
    if !invited_only && role.is_none() {
        return Err(HttpError::cloud_project_not_found());
    }

    // The project metadata feeds `item_security` and the response projection.
    let project = members::project_entity_on(query, project_number)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::internal_detail)?;

    // `can_view_item`: Maintainer+ sees any item; everyone else needs an
    // invitation, an `open` item or a related-item relationship.
    if !invited_only
        && !role.is_some_and(|role| has_permission(role, "Maintainer"))
        && item_security(security_level, &project) != "open"
        && !is_related_item_on(query, issue_id, user_id)
            .await
            .map_err(HttpError::internal)?
    {
        return Err(HttpError::todo_not_found());
    }
    Ok(ItemReadAccess {
        project,
        invited_only,
        can_edit: invited_only || role.is_some_and(|role| has_permission(role, "Developer")),
    })
}

/// `item_security(item, project)`: the item's stored `security_level` when it
/// is one of the known levels, otherwise the project's default.
fn item_security(level: Option<&str>, project: &members::ProjectEntityRow) -> &'static str {
    match level {
        Some("open") => "open",
        Some("related") => "related",
        _ if default_issue_security(project) == "related" => "related",
        _ => "open",
    }
}

/// `default_issue_security(project)`: `related` only when the project
/// metadata sets it, otherwise `open`.
pub(crate) fn default_issue_security(project: &members::ProjectEntityRow) -> &'static str {
    let value = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata: &CloudMetadataInput| metadata.default_issue_security.as_deref());
    if value == Some("related") {
        "related"
    } else {
        "open"
    }
}

/// `project.visibility`: the metadata value, defaulting to `private`.
pub(crate) fn project_visibility(project: &members::ProjectEntityRow) -> String {
    project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata: &CloudMetadataInput| metadata.visibility.clone())
        .unwrap_or_else(|| "private".to_string())
}

/// `project.task_provider`: the metadata value when it is one of the known
/// providers, otherwise `local`.
pub(crate) fn project_task_provider(project: &members::ProjectEntityRow) -> String {
    const KNOWN: [&str; 4] = ["local", "github", "gitlab", "dingtalk_aitable"];
    project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata: &CloudMetadataInput| metadata.task_provider.as_deref())
        .filter(|provider| KNOWN.contains(provider))
        .unwrap_or("local")
        .to_string()
}

/// `require_cloud_project_role(db, project_id, user_id, Viewer)`.
pub async fn require_cloud_project_role(
    mysql: &brz_mysql::MysqlService,
    project_id: &str,
    user_id: i32,
) -> Result<ProjectAccess, FastApiError> {
    let number: i64 = project_id.parse().map_err(|_| cloud_project_not_found())?;
    BoardSnapshotRepository::new(mysql)
        .require_cloud_project_role(number, user_id)
        .await
        .map_err(assignment_error)?
        .ok_or_else(cloud_project_not_found)
}

/// `_item_number`: the numeric suffix of a `KEY-number` id.
pub fn item_number(item_id: &str) -> Option<i64> {
    let (_, number) = item_id.rsplit_once('-')?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

pub fn todo_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "TODO not found")
}

pub fn assignment_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "loop-items assignments dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
