// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects` — list cloud projects accessible to the
//! current user
//! (`app.api.endpoints.cloud_projects.list_cloud_projects`, router prefix
//! `/v1/cloud-projects` under the app prefix `/api`).
//!
//! Source pipeline:
//! 1. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup (the full twelve-column `users_<column>` projection);
//! 2. `cloud_project_service.list_accessible` — one `loop_items` scan for
//!    `resource_type IN ('project')` rows that are active and either created
//!    by the user, list the user as an approved `resource_members` member,
//!    or carry `metadata.visibility = public`, ordered by
//!    `updated_at DESC` (recorded as a fully labeled 60-column projection
//!    over `loop_items`);
//! 3. per project, `_project_response` -> `cloud_project_service.access` ->
//!    `require_cloud_project_role`, which re-reads the project row
//!    (`WHERE id = ? AND status='active' AND resource_type IN ('project')`)
//!    and, for non-creators, the approved `resource_members` membership row;
//!    the resolved role becomes `access_role` (Owner for the creator,
//!    membership role, or RestrictedAnalyst for public projects);
//!
//! The per-project body derives from the `loop_items` row plus its
//! `metadata` JSON (`CloudProjectResponse.populate_tags` in
//! `app.schemas.cloud_project`).
use crate::json_compat::{JsonProjection, OpaqueJson, raw_json};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;
use serde_json::json;
use serde_json::{Value, value::RawValue};

use crate::auth::{SessionUser, UserRow};
use crate::board_snapshot;
use crate::http_compat::FastApiError;
use crate::state::AppState;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CloudMetadataInput {
    pub visibility: Option<String>,
    pub task_provider: Option<String>,
    pub provider_config: Option<OpaqueJson>,
    pub card_display: Option<OpaqueJson>,
    pub board_config: Option<OpaqueJson>,
    pub ai_automation: Option<OpaqueJson>,
    pub pull_request_automation: Option<OpaqueJson>,
    pub workflow_definition: Option<OpaqueJson>,
    pub workflow_automation_id: Option<OpaqueJson>,
    pub tags: Option<OpaqueJson>,
    pub member_capabilities: Option<OpaqueJson>,
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

/// The source's full column projection (all mapped `loop_items` columns,
/// labeled like SQLAlchemy's query rendering). Selected to match the
/// recorded statement; the typed row consumes only the response fields.
pub(crate) const PROJECT_COLUMNS: &str = "loop_items.id AS loop_items_id, \
     loop_items.resource_type AS loop_items_resource_type, \
     loop_items.project_space AS loop_items_project_space, \
     loop_items.cloud_project_id AS loop_items_cloud_project_id, \
     loop_items.parent_id AS loop_items_parent_id, \
     loop_items.loop_item_id AS loop_items_loop_item_id, \
     loop_items.delivery_id AS loop_items_delivery_id, \
     loop_items.public_id AS loop_items_public_id, \
     loop_items.project_key AS loop_items_project_key, \
     loop_items.name AS loop_items_name, \
     loop_items.title AS loop_items_title, \
     loop_items.description AS loop_items_description, \
     loop_items.storage_prefix AS loop_items_storage_prefix, \
     loop_items.sequence_number AS loop_items_sequence_number, \
     loop_items.next_item_number AS loop_items_next_item_number, \
     loop_items.created_by_user_id AS loop_items_created_by_user_id, \
     loop_items.updated_by_user_id AS loop_items_updated_by_user_id, \
     loop_items.assignee_user_id AS loop_items_assignee_user_id, \
     loop_items.user_id AS loop_items_user_id, \
     loop_items.added_by_user_id AS loop_items_added_by_user_id, \
     loop_items.source AS loop_items_source, \
     loop_items.status AS loop_items_status, \
     loop_items.priority AS loop_items_priority, \
     loop_items.due_at AS loop_items_due_at, \
     loop_items.sort_order AS loop_items_sort_order, \
     loop_items.current_delivery_id AS loop_items_current_delivery_id, \
     loop_items.local_project_id AS loop_items_local_project_id, \
     loop_items.device_id AS loop_items_device_id, \
     loop_items.is_default AS loop_items_is_default, \
     loop_items.task_user_id AS loop_items_task_user_id, \
     loop_items.assignee_agent_id AS loop_items_assignee_agent_id, \
     loop_items.assignee_team_id AS loop_items_assignee_team_id, \
     loop_items.task_id AS loop_items_task_id, \
     loop_items.task_title AS loop_items_task_title, \
     loop_items.backend_task_id AS loop_items_backend_task_id, \
     loop_items.linked_by_user_id AS loop_items_linked_by_user_id, \
     loop_items.linked_at AS loop_items_linked_at, \
     loop_items.unlinked_at AS loop_items_unlinked_at, \
     loop_items.path AS loop_items_path, \
     loop_items.kind AS loop_items_kind, \
     loop_items.display_name AS loop_items_display_name, \
     loop_items.relative_path AS loop_items_relative_path, \
     loop_items.object_key AS loop_items_object_key, \
     loop_items.content_type AS loop_items_content_type, \
     loop_items.size_bytes AS loop_items_size_bytes, \
     loop_items.sha256 AS loop_items_sha256, \
     loop_items.source_task_binding_id AS loop_items_source_task_binding_id, \
     loop_items.source_task_snapshot AS loop_items_source_task_snapshot, \
     loop_items.markdown_object_key AS loop_items_markdown_object_key, \
     loop_items.chat_object_key AS loop_items_chat_object_key, \
     loop_items.manifest_object_key AS loop_items_manifest_object_key, \
     loop_items.metadata AS loop_items_metadata, \
     loop_items.version AS loop_items_version, \
     loop_items.created_at AS loop_items_created_at, \
     loop_items.updated_at AS loop_items_updated_at, \
     loop_items.completed_at AS loop_items_completed_at, \
     loop_items.delivered_at AS loop_items_delivered_at, \
     loop_items.deleted_at AS loop_items_deleted_at";

/// `cloud_project_service.list_accessible`: active project rows the user
/// created, is an approved member of, or that are public, newest first.
async fn list_accessible<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<Vec<ProjectListRow>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {PROJECT_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.status = 'active' \
         AND (loop_items.created_by_user_id = ? OR loop_items.id IN \
         (SELECT resource_members.resource_id \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = ? \
         AND resource_members.status = 'approved') \
         OR CASE JSON_EXTRACT(loop_items.metadata, '$.\"visibility\"') \
         WHEN 'null' THEN NULL \
         ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\"visibility\"')) \
         END = 'public') \
         AND loop_items.resource_type IN ('project') \
         ORDER BY loop_items.updated_at DESC",
    );
    mysql
        .fetch_all(sql, (i64::from(user_id), user_id.to_string()))
        .await
}

/// The `require_cloud_project_role` project re-read
/// (`cloud_project_service.access`); the recorded COM_QUERY inlines the
/// snowflake id as an integer literal instead of a bound parameter.
pub(crate) async fn access_project<M: Mysql>(
    mysql: &M,
    project_id: &str,
) -> Result<Option<ProjectListRow>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {PROJECT_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.id = {project_id} AND loop_items.status = 'active' \
         AND loop_items.resource_type IN ('project') \n LIMIT 1",
    );
    mysql.fetch_optional(sql, ()).await
}

/// The `require_cloud_project_role` membership lookup for a non-creator.
pub(crate) async fn membership_role<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct RoleRow {
        #[mysql(rename = "resource_members_role")]
        role: String,
    }
    let row: Option<RoleRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type, \
             resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.entity_display_name AS resource_members_entity_display_name, \
             resource_members.user_id AS resource_members_user_id, \
             resource_members.`role` AS resource_members_role, \
             resource_members.status AS resource_members_status, \
             resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
             resource_members.share_link_id AS resource_members_share_link_id, \
             resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
             resource_members.reviewed_at AS resource_members_reviewed_at, \
             resource_members.copied_resource_id AS resource_members_copied_resource_id, \
             resource_members.requested_at AS resource_members_requested_at, \
             resource_members.created_at AS resource_members_created_at, \
             resource_members.updated_at AS resource_members_updated_at \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = {project_id} \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '{user_id}' \
             AND resource_members.status = 'approved' \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.role))
}

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
fn datetime_value(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

/// `normalize_tags` (`app.schemas.tagging`): trim, dedupe, cap.
fn normalize_tags(value: Option<&OpaqueJson>) -> Vec<String> {
    const MAX_TAG_LENGTH: usize = 64;
    const MAX_TAGS_PER_ITEM: usize = 16;
    let value = value.map(OpaqueJson::to_value);
    let Some(list) = value.as_ref().and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut tags: Vec<String> = Vec::new();
    for raw in list {
        let rendered = match raw {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        let tag: String = rendered.trim().chars().take(MAX_TAG_LENGTH).collect();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
        if tags.len() >= MAX_TAGS_PER_ITEM {
            break;
        }
    }
    tags
}

/// `mask_provider_config` (`app.core.provider_credentials`): drop the token
/// and credential, expose `credential_configured`.
fn mask_provider_config(config: Option<&OpaqueJson>) -> ProviderConfig {
    let config = config.map(OpaqueJson::to_value);
    let map = config.as_ref().and_then(Value::as_object);
    ProviderConfig {
        extra: map
            .into_iter()
            .flat_map(|map| map.iter())
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "token" | "credential" | "credential_configured"
                )
            })
            .map(|(key, value)| (key.clone(), raw_json(value)))
            .collect(),
        credential_configured: map
            .is_some_and(|map| matches!(map.get("credential"), Some(Value::Object(_)))),
    }
}

/// Default board statuses (`default_board_statuses`).
fn default_board_statuses() -> Value {
    json!([
        {"id": "inbox", "name": "收集箱", "color": "gray"},
        {"id": "pending", "name": "待开始", "color": "blue"},
        {"id": "in_progress", "name": "进行中", "color": "orange"},
        {"id": "in_review", "name": "待确认", "color": "purple"},
        {"id": "completed", "name": "已完成", "color": "green"},
    ])
}

/// Apply the source's pydantic defaults over a metadata sub-object: missing
/// keys fall back to the schema defaults.
fn board_config_value(config: Option<&OpaqueJson>) -> BoardConfig {
    let config = config.map(OpaqueJson::to_value);
    let source = config
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let statuses = match source.get("statuses") {
        Some(Value::Array(list)) if !list.is_empty() => json!(list),
        _ => default_board_statuses(),
    };
    let group_by = source
        .get("group_by")
        .and_then(Value::as_str)
        .unwrap_or("status");
    // Schema default: the second status id when more than one exists, else
    // the first; an explicit value wins.
    let mut processing = if let Some(list) = statuses.as_array() {
        list.get(if list.len() > 1 { 1 } else { 0 })
            .and_then(|status| status.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        None
    };
    if let Some(value) = source
        .get("processing_start_status_id")
        .and_then(Value::as_str)
    {
        processing = Some(value.to_string());
    }
    BoardConfig {
        group_by: group_by.to_owned(),
        statuses: raw_json(&statuses),
        processing_start_status_id: processing,
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct CardInput {
    show_assignee: Option<bool>,
    show_priority: Option<bool>,
    show_tags: Option<bool>,
    show_date: Option<bool>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct AutomationInput {
    auto_retry_on_failure: Option<bool>,
    max_retry_count: Option<i64>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct WorkflowInput {
    version: Option<i64>,
    stage_mode: Option<String>,
    advancement_policy: Option<String>,
    coordinator_prompt: Option<String>,
    approval_policy: Option<String>,
    ai_automation_rule_id: Option<OpaqueJson>,
    execution_config: Option<OpaqueJson>,
    nodes: Option<Vec<OpaqueJson>>,
}

/// Card display with schema defaults.
fn card_display_value(config: Option<&OpaqueJson>) -> CardDisplay {
    let input = config
        .and_then(OpaqueJson::project::<CardInput>)
        .unwrap_or_default();
    CardDisplay {
        show_assignee: input.show_assignee.unwrap_or(true),
        show_priority: input.show_priority.unwrap_or(true),
        show_tags: input.show_tags.unwrap_or(true),
        show_date: input.show_date.unwrap_or(true),
    }
}

fn ai_automation_value(config: Option<&OpaqueJson>) -> AiAutomation {
    let input = config
        .and_then(OpaqueJson::project::<AutomationInput>)
        .unwrap_or_default();
    AiAutomation {
        auto_retry_on_failure: input.auto_retry_on_failure.unwrap_or(false),
        max_retry_count: input.max_retry_count.unwrap_or(1),
    }
}

/// Pull-request automation with schema defaults.
fn pull_request_automation_value(config: Option<&OpaqueJson>) -> PullRequestAutomation {
    let config = config.map(OpaqueJson::to_value);
    let source = config
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let statuses = source
        .get("statuses")
        .and_then(Value::as_array)
        .map(|list| {
            let mut seen: Vec<Value> = Vec::new();
            for status in list {
                if !seen.contains(status) {
                    seen.push(status.clone());
                }
            }
            json!(seen)
        })
        .unwrap_or_else(|| {
            json!([
                "checks_failed",
                "merge_conflict",
                "merge_queue_failed",
                "merge_queue_timed_out",
                "merge_queue_conflicting",
            ])
        });
    PullRequestAutomation {
        enabled: source
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        statuses: raw_json(&statuses),
        prompt: source
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

/// Workflow definition with schema defaults.
fn workflow_definition_value(config: Option<&OpaqueJson>) -> WorkflowDefinition {
    let input = config
        .and_then(OpaqueJson::project::<WorkflowInput>)
        .unwrap_or_default();
    let opaque = |value: OpaqueJson| {
        serde_json::value::to_raw_value(&value).expect("workflow value serializes")
    };
    WorkflowDefinition {
        version: input.version.unwrap_or(1),
        stage_mode: input.stage_mode.unwrap_or_else(|| "none".into()),
        advancement_policy: input.advancement_policy.unwrap_or_else(|| "manual".into()),
        coordinator_prompt: input.coordinator_prompt.unwrap_or_default(),
        approval_policy: input.approval_policy.unwrap_or_else(|| "required".into()),
        ai_automation_rule_id: input.ai_automation_rule_id.map(opaque),
        execution_config: input.execution_config.map(opaque),
        nodes: input
            .nodes
            .unwrap_or_default()
            .into_iter()
            .map(opaque)
            .collect(),
    }
}

/// `CloudProject.task_provider`: known providers only, else `local`.
fn task_provider(metadata: Option<&CloudMetadataInput>) -> String {
    let known = ["local", "github", "gitlab", "dingtalk_aitable"];
    metadata
        .and_then(|metadata| metadata.task_provider.as_deref())
        .filter(|provider| known.contains(provider))
        .unwrap_or("local")
        .to_string()
}

/// Serialize one project row the way `_project_response` +
/// `CloudProjectResponse` do.
pub(crate) fn project_response(
    project: &ProjectListRow,
    current_user_id: i32,
    current_user_name: &str,
    access_role: &str,
) -> CloudProjectBody {
    let metadata = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref());
    let visibility =
        if metadata.and_then(|metadata| metadata.visibility.as_deref()) == Some("public") {
            "public"
        } else {
            "private"
        };
    CloudProjectBody {
        id: project.id.clone(),
        public_id: project.public_id.clone().unwrap_or_default(),
        project_key: project.project_key.clone().unwrap_or_default(),
        name: project.name.clone().unwrap_or_default(),
        description: project.description.clone().unwrap_or_default(),
        project_store: "backend",
        task_provider: task_provider(metadata),
        provider_config: mask_provider_config(
            metadata.and_then(|metadata| metadata.provider_config.as_ref()),
        ),
        card_display: card_display_value(
            metadata.and_then(|metadata| metadata.card_display.as_ref()),
        ),
        board_config: board_config_value(
            metadata.and_then(|metadata| metadata.board_config.as_ref()),
        ),
        ai_automation: ai_automation_value(
            metadata.and_then(|metadata| metadata.ai_automation.as_ref()),
        ),
        pull_request_automation: pull_request_automation_value(
            metadata.and_then(|metadata| metadata.pull_request_automation.as_ref()),
        ),
        workflow_definition: workflow_definition_value(
            metadata.and_then(|metadata| metadata.workflow_definition.as_ref()),
        ),
        workflow_automation_id: metadata
            .and_then(|metadata| metadata.workflow_automation_id.as_ref())
            .filter(|value| !value.is_null())
            .map(|value| serde_json::value::to_raw_value(value).unwrap()),
        visibility,
        created_by_user_id: project.created_by_user_id,
        current_user_id,
        current_user_name: current_user_name.to_owned(),
        access_role: access_role.to_owned(),
        status: project.status.clone(),
        tags: normalize_tags(metadata.and_then(|metadata| metadata.tags.as_ref())),
        version: project.version,
        created_at: datetime_value(project.created_at),
        updated_at: datetime_value(project.updated_at),
    }
}

/// GET /api/v1/cloud-projects: the cloud-projects free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects")]
async fn list_cloud_projects(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<ProjectListResponse, FastApiError> {
    cloud_projects(state, current_user.0).await
}

/// Handler body for `GET /api/v1/cloud-projects`.
async fn cloud_projects(
    state: &AppState,
    current_user: UserRow,
) -> Result<ProjectListResponse, FastApiError> {
    let projects = list_accessible(&state.mysql, current_user.id)
        .await
        .map_err(internal_error)?;

    let mut items = Vec::with_capacity(projects.len());
    for project in &projects {
        // `cloud_project_service.access` -> `require_cloud_project_role`:
        // re-read the project and resolve the caller's role.
        let role = project_role(&state.mysql, project, current_user.id)
            .await
            .map_err(internal_error)?;
        items.push(project_response(
            project,
            current_user.id,
            &current_user.user_name,
            &role,
        ));
    }

    Ok(ProjectListResponse { items })
}

/// Fixed project response; provider-specific values remain opaque JSON.
#[derive(Debug, serde::Serialize)]
pub(crate) struct CloudProjectBody {
    id: String,
    public_id: String,
    project_key: String,
    name: String,
    description: String,
    project_store: &'static str,
    task_provider: String,
    provider_config: ProviderConfig,
    card_display: CardDisplay,
    board_config: BoardConfig,
    ai_automation: AiAutomation,
    pull_request_automation: PullRequestAutomation,
    workflow_definition: WorkflowDefinition,
    workflow_automation_id: Option<Box<RawValue>>,
    visibility: &'static str,
    created_by_user_id: i32,
    current_user_id: i32,
    current_user_name: String,
    access_role: String,
    status: String,
    tags: Vec<String>,
    version: i64,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct ProviderConfig {
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, Box<RawValue>>,
    credential_configured: bool,
}
#[derive(Debug, serde::Serialize)]
struct CardDisplay {
    show_assignee: bool,
    show_priority: bool,
    show_tags: bool,
    show_date: bool,
}
#[derive(Debug, serde::Serialize)]
struct BoardConfig {
    group_by: String,
    statuses: Box<RawValue>,
    processing_start_status_id: Option<String>,
}
#[derive(Debug, serde::Serialize)]
struct AiAutomation {
    auto_retry_on_failure: bool,
    max_retry_count: i64,
}
#[derive(Debug, serde::Serialize)]
struct PullRequestAutomation {
    enabled: bool,
    statuses: Box<RawValue>,
    prompt: String,
}
#[derive(Debug, serde::Serialize)]
struct WorkflowDefinition {
    version: i64,
    stage_mode: String,
    advancement_policy: String,
    coordinator_prompt: String,
    approval_policy: String,
    ai_automation_rule_id: Option<Box<RawValue>>,
    execution_config: Option<Box<RawValue>>,
    nodes: Vec<Box<RawValue>>,
}
#[derive(serde::Serialize)]
struct ProjectListResponse {
    items: Vec<CloudProjectBody>,
}

impl CloudProjectBody {
    pub(crate) fn from_project(
        project: &ProjectListRow,
        current_user_id: i32,
        current_user_name: &str,
        access_role: &str,
    ) -> Self {
        project_response(project, current_user_id, current_user_name, access_role)
    }
}

/// `require_cloud_project_role` role resolution for one listed project.
pub(crate) async fn project_role<M: Mysql>(
    mysql: &M,
    project: &ProjectListRow,
    user_id: i32,
) -> Result<String, brz_mysql::MysqlError> {
    // The recorded flow re-reads the row through the identity map's
    // per-project query; the re-read project is the same active row.
    if access_project(mysql, &project.id).await?.is_none() {
        // Not reachable for rows the accessible scan just returned.
        return Ok("RestrictedAnalyst".to_string());
    }
    if project.created_by_user_id == user_id {
        return Ok("Owner".to_string());
    }
    if let Some(role) = membership_role(mysql, &project.id, user_id).await? {
        return Ok(role);
    }
    // Public projects resolve to RestrictedAnalyst; a private project the
    // caller can see only through membership reaches the membership branch
    // above, so this is the public fallback.
    Ok("RestrictedAnalyst".to_string())
}

pub(crate) fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// GET /api/v1/cloud-projects/{project_id}/chat-agents: the chat-agents free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/chat-agents")]
async fn list_project_chat_agents(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<Vec<board_snapshot::handler::AgentView>, FastApiError> {
    project_chat_agents(state, project_id, current_user.0).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/chat-agents`.
///
/// Mirrors `app.api.endpoints.cloud_projects.list_project_chat_agents` ->
/// `project_chat_service.list_agents(db, user_id, project_id)`. The source
/// pipeline:
/// 1. `get_current_user_jwt_apikey_tasktoken` — the same JWT decode and
///    labeled `users` lookup as `get_current_user` (the recorded `users`
///    exchange matches the standard twelve-column projection). The target's
///    `get_current_user` reproduces that lookup.
/// 2. `require_cloud_project_role(db, project_id, user_id, Reporter)` —
///    re-read the active project row (inlined snowflake id) and, for
///    non-creators, the approved `resource_members` membership row. Public
///    visitors resolve to `RestrictedAnalyst`, which fails the Reporter
///    permission check and the source raises `403 {"detail": "Insufficient
///    permission"}`.
/// 3. `ProjectChatAgent` scan — active `loop_items` chat-agent rows
///    (`resource_type='chat_agent'`, `status='active'`, unset `deleted_at`)
///    ordered by `created_at ASC`, filtered by `_agent_visible_to_user`
///    against the caller's role.
async fn project_chat_agents(
    state: &AppState,
    project_id: &str,
    current_user: UserRow,
) -> Result<Vec<board_snapshot::handler::AgentView>, FastApiError> {
    // `require_cloud_project_role`: re-read the active project row plus the
    // approved membership row for non-creators. The source passes
    // `project_id=str(project_id)` (a string) to `list_agents`, which forwards
    // it to `require_cloud_project_role`; SQLAlchemy renders the string value
    // as a quoted string literal, so the recorded COM_QUERY has
    // `loop_items.id = '8869148083931743937'` (not an unquoted integer).
    // `access_project` inlines `{project_id}` without quotes (matching the
    // integer-literal recording of other endpoints like loop-item-pages), so
    // the chat-agents handler inlines its own project and membership lookups
    // with quoted string literals to match this endpoint's recording.
    let project: Option<ProjectListRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT {PROJECT_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.id = '{project_id}' AND loop_items.status = 'active' \
                 AND loop_items.resource_type IN ('project') \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(internal_error)?;
    let project = project.ok_or_else(|| {
        FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Cloud project not found",
        )
    })?;

    let role = if project.created_by_user_id == current_user.id {
        "Owner".to_string()
    } else {
        let current_user_id = current_user.id;
        // `require_cloud_project_role` membership lookup for a non-creator.
        // Like the project lookup, the recorded SQL inlines the snowflake id
        // as a quoted string literal because the source passes `str(project_id)`.
        #[derive(Debug, FromMysqlRow)]
        struct RoleRow {
            #[mysql(rename = "resource_members_role")]
            role: String,
        }
        let row: Option<RoleRow> = state
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT resource_members.id AS resource_members_id, \
                 resource_members.resource_type AS resource_members_resource_type, \
                 resource_members.resource_id AS resource_members_resource_id, \
                 resource_members.entity_type AS resource_members_entity_type, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.entity_display_name AS resource_members_entity_display_name, \
                 resource_members.user_id AS resource_members_user_id, \
                 resource_members.`role` AS resource_members_role, \
                 resource_members.status AS resource_members_status, \
                 resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
                 resource_members.share_link_id AS resource_members_share_link_id, \
                 resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
                 resource_members.reviewed_at AS resource_members_reviewed_at, \
                 resource_members.copied_resource_id AS resource_members_copied_resource_id, \
                 resource_members.requested_at AS resource_members_requested_at, \
                 resource_members.created_at AS resource_members_created_at, \
                 resource_members.updated_at AS resource_members_updated_at \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'CloudProject' \
                 AND resource_members.resource_id = '{project_id}' \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{current_user_id}' \
                 AND resource_members.status = 'approved' \n LIMIT 1"
                ),
                (),
            )
            .await
            .map_err(internal_error)?;
        match row {
            Some(row) => row.role,
            None if project
                .metadata
                .as_ref()
                .and_then(|json| json.0.value.as_ref())
                .and_then(|metadata| metadata.visibility.as_deref())
                == Some("public") =>
            {
                "RestrictedAnalyst".to_string()
            }
            None => {
                return Err(FastApiError::detail(
                    brz_http_server::StatusCode::NOT_FOUND,
                    "Cloud project not found",
                ));
            }
        }
    };

    // `has_permission(role, Reporter)`: RestrictedAnalyst (public visitor)
    // fails and the source raises `403 {"detail": "Insufficient permission"}`.
    if !board_snapshot::repository::has_permission(&role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `project_chat_service.list_agents`: active chat-agent rows for the
    // project, filtered by visibility against the caller.
    let repository = board_snapshot::repository::BoardSnapshotRepository::new(&state.mysql);
    let agents = repository
        .list_agents(project_id)
        .await
        .map_err(internal_error)?;
    let visible_agents: Vec<board_snapshot::handler::AgentView> = agents
        .iter()
        .filter(|agent| {
            board_snapshot::handler::agent_visible_to_user(agent, current_user.id, &role)
        })
        .map(board_snapshot::handler::agent_to_view)
        .collect();

    Ok(visible_agents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    #[test]
    fn cloud_project_legacy_json_baseline() {
        let output: Vec<_> = [json!({}), Value::Null, json!([]),
            json!({"task_provider":"local","provider_config":{"credential":{"token":"x"},"other":null},"tags":[" a ","a",""]}),
            json!({"board_config":{"statuses":[{"id":"custom","extra":null}],"default_status":null},"card_display":{},"ai_automation":null,"workflow_definition":null}),
            json!({"workflow_definition":{"version":2,"nodes":[{"x":null}],"edges":[{}]},"pull_request_automation":{"trigger_events":["a","a",null]}})
        ].into_iter().map(|metadata| project_response(&row(metadata), 1, "user", "Owner")).collect();
        crate::json_contract_tests::assert_fixture("cloud_project", output);
    }

    fn project_response(
        project: &ProjectListRow,
        current_user_id: i32,
        current_user_name: &str,
        access_role: &str,
    ) -> Value {
        crate::json_contract_tests::serialized(super::project_response(
            project,
            current_user_id,
            current_user_name,
            access_role,
        ))
        .unwrap()
    }
    fn datetime_value(value: Option<NaiveDateTime>) -> Value {
        crate::json_contract_tests::serialized(super::datetime_value(value)).unwrap()
    }
    fn row(metadata: Value) -> ProjectListRow {
        ProjectListRow {
            id: "1712605396200092385".to_string(),
            public_id: Some("99f780dd-f8c3-4df9-99d8-2c5dfa9c3336".to_string()),
            project_key: Some("WEWORKBU0CEBB1".to_string()),
            name: Some("WeWork Bug Feedback".to_string()),
            description: Some("Description".to_string()),
            created_by_user_id: 86,
            status: "active".to_string(),
            version: 4,
            created_at: NaiveDateTime::parse_from_str("2026-07-28 15:44:57", "%Y-%m-%d %H:%M:%S")
                .ok(),
            updated_at: NaiveDateTime::parse_from_str("2026-07-28 17:30:01", "%Y-%m-%d %H:%M:%S")
                .ok(),
            metadata: Some(Json(metadata.into())),
        }
    }

    #[test]
    fn serializes_the_recorded_gitlab_project_shape() {
        let metadata = serde_json::json!({
            "tags": [],
            "visibility": "public",
            "project_store": "backend",
            "task_provider": "gitlab",
            "provider_config": {
                "domain": "git.example.invalid",
                "api_base": "https://git.example.invalid/api/v4",
                "credential": {"nonce": "n", "version": 2},
                "repository": "example_org/common/example/wework-issues",
            },
        });
        let value = project_response(&row(metadata), 302, "dehua", "RestrictedAnalyst");
        assert_eq!(value["id"], "1712605396200092385");
        assert_eq!(value["visibility"], "public");
        assert_eq!(value["task_provider"], "gitlab");
        // credential masked, other keys kept, flag appended last
        assert_eq!(
            value["provider_config"],
            serde_json::json!({
                "domain": "git.example.invalid",
                "api_base": "https://git.example.invalid/api/v4",
                "repository": "example_org/common/example/wework-issues",
                "credential_configured": true,
            })
        );
        assert_eq!(value["access_role"], "RestrictedAnalyst");
        assert_eq!(value["current_user_id"], 302);
        assert_eq!(value["created_by_user_id"], 86);
        assert_eq!(value["created_at"], "2026-07-28T15:44:57");
        // defaults
        assert_eq!(value["card_display"]["show_assignee"], true);
        assert_eq!(value["board_config"]["group_by"], "status");
        assert_eq!(
            value["board_config"]["processing_start_status_id"],
            "pending"
        );
        assert_eq!(value["ai_automation"]["max_retry_count"], 1);
        assert_eq!(value["pull_request_automation"]["prompt"], "");
        assert_eq!(value["workflow_definition"]["version"], 1);
        assert_eq!(value["workflow_definition"]["nodes"], serde_json::json!([]));
        assert_eq!(value["tags"], serde_json::json!([]));
    }

    #[test]
    fn masks_local_provider_config_to_the_flag() {
        let value = project_response(
            &row(serde_json::json!({"task_provider": "local", "provider_config": {}})),
            302,
            "dehua",
            "Maintainer",
        );
        assert_eq!(
            value["provider_config"],
            serde_json::json!({"credential_configured": false})
        );
        assert_eq!(value["task_provider"], "local");
        assert_eq!(value["visibility"], "private");
    }

    #[test]
    fn unknown_task_provider_falls_back_to_local() {
        let value = project_response(
            &row(serde_json::json!({"task_provider": "weird"})),
            1,
            "u",
            "Owner",
        );
        assert_eq!(value["task_provider"], "local");
    }

    #[test]
    fn normalize_tags_dedupes_and_trims() {
        let tags = serde_json::json!([" a ", "a", "", "b"]);
        let tags = OpaqueJson::from(tags);
        assert_eq!(
            normalize_tags(Some(&tags)),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            normalize_tags(Some(&OpaqueJson::from(serde_json::json!("x")))),
            Vec::<String>::new()
        );
        assert_eq!(normalize_tags(None), Vec::<String>::new());
    }

    #[test]
    fn fractional_datetimes_render_with_microseconds() {
        let parsed =
            NaiveDateTime::parse_from_str("2026-09-01 15:18:26.901656", "%Y-%m-%d %H:%M:%S%.f")
                .unwrap();
        assert_eq!(
            datetime_value(Some(parsed)),
            json!("2026-09-01T15:18:26.901656")
        );
    }
}

#[cfg(test)]
mod round_two_config_contracts {
    use super::*;
    #[test]
    fn round_two_cloud_configs() {
        let mut outputs = Vec::new();
        for field in [
            "show_assignee",
            "show_priority",
            "show_tags",
            "show_date",
            "auto_retry_on_failure",
            "max_retry_count",
            "version",
            "stage_mode",
            "advancement_policy",
            "coordinator_prompt",
            "approval_policy",
            "ai_automation_rule_id",
            "execution_config",
            "nodes",
        ] {
            for value in [
                json!(null),
                json!(false),
                json!(0),
                json!(1.0),
                json!(""),
                json!("x"),
                json!([]),
                json!({}),
                json!([null,{"id":1}]),
            ] {
                let mut input = json!({});
                input[field] = value;
                let input = OpaqueJson::from(input);
                outputs.push(json!([
                    json!(card_display_value(Some(&input))),
                    json!(ai_automation_value(Some(&input))),
                    json!(workflow_definition_value(Some(&input)))
                ]));
            }
        }
        crate::json_contract_tests::assert_fixture("round_two_cloud_configs", outputs);
    }
}
