// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project authorization and typed cloud-resource projections.

use brz_json::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;

mod access;
pub mod collaboration_access;
pub mod environment_authorization;
pub mod members;
mod read;
pub use read::{
    ProjectAccessRow, all_user_grant_roles, cloud_project_not_found, internal_error,
    parent_contexts, parse_project_id, project_access, project_access_details,
};
pub mod response;
mod workflow_definition;

pub use access::{
    LOOP_ITEMS_COLUMNS, WORKSPACE_ID_COLUMN, WORKSPACE_ID_EXPRESSION, entity_columns,
    project_access_point_statement, project_permission_statement, role_for_priority,
};
use response::{CloudProjectBody, WorkspaceContext};

/// Resolve a point read with the same CP grants as the project catalog.
pub async fn authorized_project<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> Result<Option<(ProjectListRow, &'static str)>, brz_mysql::MysqlError> {
    Ok(
        collaboration_access::authorized_projects(mysql, user_id, Some(project_id), None)
            .await?
            .into_iter()
            .next()
            .and_then(|access| {
                role_for_priority(access.priority).map(|role| (access.project, role))
            }),
    )
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CloudMetadataInput {
    pub membership_mode: Option<String>,
    pub legacy_device_revocations: Option<OpaqueJson>,
    pub visibility: Option<String>,
    pub task_provider: Option<String>,
    pub default_issue_security: Option<String>,
    pub provider_config: Option<OpaqueJson>,
    pub card_display: Option<OpaqueJson>,
    pub board_config: Option<OpaqueJson>,
    pub board_views: Option<OpaqueJson>,
    pub ai_automation: Option<OpaqueJson>,
    pub pull_request_automation: Option<OpaqueJson>,
    pub workflow_definition: Option<OpaqueJson>,
    pub workflow_automation_id: Option<OpaqueJson>,
    pub execution_environment: Option<OpaqueJson>,
    pub tags: Option<OpaqueJson>,
    pub member_capabilities: Option<OpaqueJson>,
}

impl CloudMetadataInput {
    /// `CloudProject.membership_mode`: `inherit` unless the metadata stores
    /// another explicit mode.
    pub fn membership_mode(&self) -> &str {
        self.membership_mode.as_deref().unwrap_or("inherit")
    }

    /// `CloudProjectService._member_capabilities(project)`: the metadata
    /// `member_capabilities` object reduced to trimmed, non-empty string
    /// descriptions keyed by member id.
    pub fn member_capabilities(&self) -> std::collections::HashMap<String, String> {
        let Some(values) = self.member_capabilities.as_ref().map(OpaqueJson::to_value) else {
            return std::collections::HashMap::new();
        };
        let Some(values) = values.as_object() else {
            return std::collections::HashMap::new();
        };
        values
            .iter()
            .filter_map(|(member_id, description)| {
                let description = description.as_str()?.trim();
                (!description.is_empty()).then(|| (member_id.clone(), description.to_string()))
            })
            .collect()
    }
}

/// `loop_items` project-row columns consumed by the list projection.
///
/// The recorded projection lists all 60 mapped columns labeled
/// `loop_items_<column>`; only the fields below feed the response, but the
/// full labeled projection is selected so the prepared statement matches the
/// recorded exchange for replay.
#[derive(Debug, FromMysqlRow)]
pub struct ProjectListRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_public_id")]
    pub public_id: Option<String>,
    #[mysql(rename = "loop_items_project_key")]
    pub project_key: Option<String>,
    #[mysql(rename = "loop_items_name")]
    pub name: Option<String>,
    #[mysql(rename = "loop_items_description")]
    pub description: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: i32,
    #[mysql(rename = "loop_items_status")]
    pub status: String,
    #[mysql(rename = "loop_items_version")]
    pub version: i64,
    #[mysql(rename = "loop_items_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<JsonProjection<CloudMetadataInput>>>,
}

mod agent_deletion;
#[cfg(test)]
mod agent_deletion_mysql_tests;
mod collaboration_groups;
mod execution_environments;
mod update;
pub use update::metadata_board_statuses;
