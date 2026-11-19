// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `CloudProjectResponse` construction for the cloud-projects module.
//!
//! Renders one `loop_items` project row (plus its `metadata` JSON) the way
//! `app.services.cloud_projects.responses._response` and
//! `app.schemas.cloud_project.CloudProjectResponse` do, including the
//! metadata-derived `populate_tags` defaults. The parent-space navigation
//! context is optional: the list endpoint resolves it from
//! `_parent_contexts`, while the cloud-context endpoint renders the project
//! without one.

use brz_json::RawJson;
use brz_json::{OpaqueJson, raw_json};
use chrono::NaiveDateTime;
use serde_json::Value;
use serde_json::json;

use super::workflow_definition::{WorkflowDefinition, workflow_definition_value};
use super::{CloudMetadataInput, ProjectListRow};

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

/// `normalize_tags` (`app.schemas.tagging`): trim and dedupe without losing stored tags.
fn normalize_tags(value: Option<&OpaqueJson>) -> Vec<String> {
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
        let tag = rendered.trim().to_string();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
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
        Some(Value::Array(list)) => json!(list),
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
    // `CloudProjectScheduleViewConfig` has a `default_factory`, so the source
    // always renders `schedule_view`; a stored partial object supplies only the
    // present keys and the rest fall back to the schema defaults.
    let schedule = source.get("schedule_view").and_then(Value::as_object);
    let schedule_text = |key: &str| {
        schedule
            .and_then(|map| map.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let schedule_view = ScheduleView {
        status_filter: schedule_text("status_filter"),
        assignee_filter: schedule_text("assignee_filter"),
        tag_filter: schedule_text("tag_filter"),
        group_by: schedule_text("group_by").unwrap_or_else(|| "none".to_string()),
        sort_by: schedule_text("sort_by").unwrap_or_else(|| "start_asc".to_string()),
    };
    BoardConfig {
        group_by: group_by.to_owned(),
        statuses: raw_json(&statuses),
        processing_start_status_id: processing,
        schedule_view,
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

/// `ExecutionEnvironmentConfig` (`app.schemas.workspace`): the shared
/// execution-environment definition plus the per-device preparation state.
#[derive(Debug, serde::Serialize)]
struct ExecutionEnvironment {
    workspace_policy: String,
    repositories: Vec<ExecutionRepository>,
    setup_steps: Vec<ExecutionSetupStep>,
    fingerprint: String,
    devices: std::collections::BTreeMap<String, ExecutionDevice>,
}

#[derive(Debug, serde::Serialize)]
struct ExecutionRepository {
    name: String,
    url: String,
    r#ref: String,
    path: String,
    primary: bool,
}

#[derive(Debug, serde::Serialize)]
struct ExecutionSetupStep {
    command: String,
    working_directory: String,
}

#[derive(Debug, serde::Serialize)]
struct ExecutionDevice {
    status: String,
    workspace_path: String,
    prepared_at: Option<String>,
    error: String,
}

/// pydantic datetime serialization for one persisted RFC3339 timestamp: a UTC
/// offset renders as `Z`, every other offset is preserved.
fn normalize_datetime(value: &str) -> String {
    match value.strip_suffix("+00:00") {
        Some(base) => format!("{base}Z"),
        None => value.to_string(),
    }
}

/// One trimmed string field of a persisted execution-environment sub-object.
/// The source validators strip their text fields; a non-string or missing
/// value falls back to the schema default.
fn striped_text(object: &serde_json::Map<String, Value>, key: &str, default: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .trim()
        .to_string()
}

/// `ExecutionEnvironmentDefinition.workspace_policy`: the stored literal within
/// the known set, otherwise the schema default (`git_worktree`).
fn workspace_policy_value(source: Option<&serde_json::Map<String, Value>>) -> String {
    source
        .and_then(|object| object.get("workspace_policy"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "git_worktree" | "project"))
        .unwrap_or("git_worktree")
        .to_string()
}

/// `ExecutionEnvironmentConfig` over `metadata.execution_environment`, with the
/// schema defaults applied (`workspace_policy` `git_worktree`,
/// `repositories`/`setup_steps` empty, `fingerprint` empty, `devices` empty)
/// and unknown sub-fields dropped.
fn execution_environment_value(config: Option<&OpaqueJson>) -> ExecutionEnvironment {
    let config = config.map(OpaqueJson::to_value);
    let source = config.as_ref().and_then(Value::as_object);
    let repositories = source
        .and_then(|object| object.get("repositories"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_object)
                .map(|item| ExecutionRepository {
                    name: striped_text(item, "name", ""),
                    url: striped_text(item, "url", ""),
                    r#ref: striped_text(item, "ref", ""),
                    path: striped_text(item, "path", ""),
                    primary: item
                        .get("primary")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let setup_steps = source
        .and_then(|object| object.get("setup_steps"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_object)
                .map(|item| ExecutionSetupStep {
                    command: striped_text(item, "command", ""),
                    working_directory: striped_text(item, "working_directory", ""),
                })
                .collect()
        })
        .unwrap_or_default();
    let devices = source
        .and_then(|object| object.get("devices"))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    let item = value.as_object()?;
                    Some((
                        key.clone(),
                        ExecutionDevice {
                            status: striped_text(item, "status", "preparing"),
                            workspace_path: striped_text(item, "workspace_path", ""),
                            prepared_at: item
                                .get("prepared_at")
                                .and_then(Value::as_str)
                                .map(normalize_datetime),
                            error: striped_text(item, "error", ""),
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    ExecutionEnvironment {
        workspace_policy: workspace_policy_value(source),
        repositories,
        setup_steps,
        fingerprint: source
            .map(|object| striped_text(object, "fingerprint", ""))
            .unwrap_or_default(),
        devices,
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

/// `WorkspaceNavigationContextResponse`: the parent `CollaborationWorkspace`
/// a project belongs to (`_parent_contexts` in
/// `app.services.cloud_projects.responses`).
#[derive(Debug, serde::Serialize)]
pub(crate) struct WorkspaceContext {
    pub id: String,
    pub public_id: String,
    pub name: String,
}

/// `ProjectVisibility` (`app.schemas.cloud_project`): a project carrying any
/// approved `authenticated_users` grant is `public`, otherwise `private`. The
/// `_response` helper overrides the stored metadata value, so this no longer
/// reads `metadata.visibility`.
fn visibility_value(all_user_role: Option<&str>) -> &'static str {
    if all_user_role.is_some() {
        "public"
    } else {
        "private"
    }
}

/// `CloudProjectResponse.populate_tags` `default_issue_security`: the metadata
/// literal within the schema set, else the default (`open`).
fn default_issue_security_value(metadata: Option<&CloudMetadataInput>) -> String {
    metadata
        .and_then(|metadata| metadata.default_issue_security.as_deref())
        .filter(|value| matches!(*value, "open" | "related"))
        .unwrap_or("open")
        .to_string()
}

/// `PublicAccessGrant` (`app.schemas.cloud_project`): the stored role of the
/// all-signed-in-users grant, or `None` when the project is private.
#[derive(Debug, serde::Serialize)]
struct PublicAccessGrant {
    role: String,
}

/// Serialize one project row the way `_project_response` +
/// `CloudProjectResponse` do. `access_role` is the caller's effective role;
/// `all_user_role` is the stored role of the project's approved
/// `authenticated_users` grant (`None` for a private project). `workspace` is
/// the resolved parent-space navigation context; the source passes `None` when
/// the project has no readable parent workspace.
pub(crate) fn project_response(
    project: &ProjectListRow,
    current_user_id: i32,
    current_user_name: &str,
    access_role: &str,
    all_user_role: Option<&str>,
    workspace: Option<&WorkspaceContext>,
) -> CloudProjectBody {
    let metadata = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref());
    CloudProjectBody {
        id: project.id.clone(),
        workspace_id: workspace.map(|workspace| workspace.id.clone()),
        workspace_context: workspace.map(|workspace| WorkspaceContext {
            id: workspace.id.clone(),
            public_id: workspace.public_id.clone(),
            name: workspace.name.clone(),
        }),
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
        board_views: metadata
            .and_then(|metadata| metadata.board_views.as_ref())
            .map(|value| brz_json::to_raw_value(value).unwrap()),
        collaboration_policy: metadata
            .and_then(|metadata| metadata.collaboration_policy.as_ref())
            .map_or_else(
                || raw_json(&json!({"content": "", "revision": 1})),
                |value| brz_json::to_raw_value(value).unwrap(),
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
            .map(|value| brz_json::to_raw_value(value).unwrap()),
        execution_environment: execution_environment_value(
            metadata.and_then(|metadata| metadata.execution_environment.as_ref()),
        ),
        visibility: visibility_value(all_user_role),
        public_access: all_user_role.map(|role| PublicAccessGrant {
            role: role.to_owned(),
        }),
        default_issue_security: default_issue_security_value(metadata),
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

/// Fixed project response; provider-specific values remain opaque JSON.
#[derive(Debug, serde::Serialize)]
pub(crate) struct CloudProjectBody {
    id: String,
    workspace_id: Option<String>,
    workspace_context: Option<WorkspaceContext>,
    public_id: String,
    project_key: String,
    name: String,
    description: String,
    project_store: &'static str,
    task_provider: String,
    provider_config: ProviderConfig,
    card_display: CardDisplay,
    board_config: BoardConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    board_views: Option<RawJson>,
    collaboration_policy: RawJson,
    ai_automation: AiAutomation,
    pull_request_automation: PullRequestAutomation,
    workflow_definition: WorkflowDefinition,
    workflow_automation_id: Option<RawJson>,
    execution_environment: ExecutionEnvironment,
    visibility: &'static str,
    public_access: Option<PublicAccessGrant>,
    default_issue_security: String,
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
    extra: std::collections::BTreeMap<String, RawJson>,
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
    statuses: RawJson,
    processing_start_status_id: Option<String>,
    schedule_view: ScheduleView,
}
#[derive(Debug, serde::Serialize)]
struct ScheduleView {
    status_filter: Option<String>,
    assignee_filter: Option<String>,
    tag_filter: Option<String>,
    group_by: String,
    sort_by: String,
}
#[derive(Debug, serde::Serialize)]
struct AiAutomation {
    auto_retry_on_failure: bool,
    max_retry_count: i64,
}
#[derive(Debug, serde::Serialize)]
struct PullRequestAutomation {
    enabled: bool,
    statuses: RawJson,
    prompt: String,
}
impl CloudProjectBody {
    /// Render one project without a parent-space navigation context
    /// (`cloud_project_service.access` callers such as the runtime-task
    /// cloud-context endpoint).
    pub(crate) fn from_project(
        project: &ProjectListRow,
        current_user_id: i32,
        current_user_name: &str,
        access_role: &str,
    ) -> Self {
        project_response(
            project,
            current_user_id,
            current_user_name,
            access_role,
            // The runtime-task cloud-context source builds `project` straight
            // from `project.__dict__`, which carries no all-signed-in-users
            // grant, so the project always renders `private`.
            None,
            None,
        )
    }
}

#[cfg(test)]
mod tests;
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
