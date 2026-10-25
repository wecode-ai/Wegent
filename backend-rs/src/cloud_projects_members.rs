// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/members` — the effective member
//! roster of one cloud project.
//!
//! Mirrors `app.api.endpoints.cloud_projects.list_cloud_project_members` ->
//! `cloud_project_service.list_members(db, project_id, current_user.id)`,
//! returning `list[CloudProjectMemberResponse]`.
//!
//! Source pipeline:
//! 1. `get_current_user_jwt_apikey_tasktoken` — JWT/API-key/task-token
//!    authentication plus the labeled `users` lookup;
//! 2. `require_cloud_project_role(db, project_id, user_id, Viewer)` — the
//!    point form of `project_access_query` resolves the active project row,
//!    the caller's effective role priority and the parent workspace id; the
//!    same call records the caller's permission sources (`project_sources`);
//!    no grant for the caller is `404 "Cloud project not found"`, a role
//!    below `Viewer` is `403 "Insufficient permission"`;
//! 3. `db.get(CloudProject, str(project_id))` — the unlabeled entity re-read
//!    that supplies the project metadata (`membership_mode` and
//!    `member_capabilities`);
//! 4. [`crate::cloud_projects::members::list_project_members`] — the roster,
//!    per-member permission sources, direct-grant id and capabilities.
use brz_http_server::StatusCode;
use brz_mysql::Mysql;

use crate::cloud_projects::members::{self, MemberResponse};
use crate::cloud_projects::{CloudMetadataInput, parse_project_id, project_access_details};
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::state::AppState;

/// GET /api/v1/cloud-projects/{project_id}/members: the members free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/members")]
async fn list_cloud_project_members(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<Vec<MemberResponse>, FastApiError> {
    list_members(&state.mysql, project_id, current_user.id).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/members`.
async fn list_members<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
) -> Result<Vec<MemberResponse>, FastApiError> {
    // FastAPI parses `project_id` as `int`; a non-integer path segment is a
    // 422 validation error.
    let project_id = parse_project_id(project_id)?;

    // `require_cloud_project_role(db, project_id, user_id, Viewer)`: the
    // access statement plus the caller's permission-source reads.
    let Some(access) = project_access_details(mysql, project_id, user_id)
        .await
        .map_err(internal_error)?
    else {
        return Err(cloud_project_not_found());
    };
    let Some(role) = crate::cloud_projects::role_for_priority(access.priority) else {
        return Err(internal_error_detail());
    };

    // `db.get(CloudProject, str(project_id))` runs before the role check in
    // `require_cloud_project_role`; the project is only dereferenced by the
    // roster afterwards.
    let entity = members::project_entity(mysql, project_id)
        .await
        .map_err(internal_error)?;

    if !members::has_permission(role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let Some(entity) = entity else {
        // A missing entity after a successful access check would raise
        // `AttributeError` in the source's roster read.
        return Err(internal_error_detail());
    };

    let metadata = entity
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref());
    let membership_mode = metadata.map(CloudMetadataInput::membership_mode);
    let capabilities = metadata.map(CloudMetadataInput::member_capabilities);

    members::list_project_members(
        mysql,
        project_id,
        entity.workspace_id,
        membership_mode.unwrap_or("inherit"),
        &capabilities.unwrap_or_default(),
        user_id,
    )
    .await
    .map_err(internal_error)
}

/// `404 "Cloud project not found"` raised by `require_cloud_project_role`
/// when no permission source resolves the project.
fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found")
}

/// The source's unhandled failure path mapped to FastAPI's generic 500.
fn internal_error_detail() -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects members dependency failure");
    internal_error_detail()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    #[tokio::test]
    async fn invalid_project_id_is_rejected_before_querying_permissions() {
        let mysql = KindQueryCapture::default();
        let error = list_members(&mysql, "invalid", 86)
            .await
            .expect_err("invalid project ids must not be accepted");
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn missing_access_grant_is_not_found_after_the_access_statement() {
        let mysql = KindQueryCapture::default();
        let error = list_members(&mysql, "4712514671486395195", 86)
            .await
            .expect_err("a caller without a grant must receive 404");
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.detail_message(), Some("Cloud project not found"));
        // The access statement is the only read when no grant resolves.
        assert_eq!(mysql.queries().len(), 1);
        assert!(
            mysql.queries()[0]
                .sql
                .contains("resource_members.entity_id = '86'")
        );
    }
}
