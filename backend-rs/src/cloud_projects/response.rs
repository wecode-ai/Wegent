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

use crate::json_compat::{OpaqueJson, raw_json};
use chrono::NaiveDateTime;
use serde_json::json;
use serde_json::{Value, value::RawValue};

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

/// `ExecutionEnvironmentConfig` (`app.schemas.workspace`): the shared
/// execution-environment definition plus the per-device preparation state.
#[derive(Debug, serde::Serialize)]
struct ExecutionEnvironment {
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

/// `ExecutionEnvironmentConfig` over `metadata.execution_environment`, with the
/// schema defaults applied (`repositories`/`setup_steps` empty, `fingerprint`
/// empty, `devices` empty) and unknown sub-fields dropped.
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

/// `CloudProjectResponse.populate_tags` visibility: the metadata value when it
/// is one of the schema literals, else `private`.
fn visibility_value(metadata: Option<&CloudMetadataInput>) -> &'static str {
    match metadata.and_then(|metadata| metadata.visibility.as_deref()) {
        Some("public") => "public",
        Some("public_restricted") => "public_restricted",
        _ => "private",
    }
}

/// Serialize one project row the way `_project_response` +
/// `CloudProjectResponse` do. `workspace` is the resolved parent-space
/// navigation context; the source passes `None` when the project has no
/// readable parent workspace.
pub(crate) fn project_response(
    project: &ProjectListRow,
    current_user_id: i32,
    current_user_name: &str,
    access_role: &str,
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
        execution_environment: execution_environment_value(
            metadata.and_then(|metadata| metadata.execution_environment.as_ref()),
        ),
        visibility: visibility_value(metadata),
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
    ai_automation: AiAutomation,
    pull_request_automation: PullRequestAutomation,
    workflow_definition: WorkflowDefinition,
    workflow_automation_id: Option<Box<RawValue>>,
    execution_environment: ExecutionEnvironment,
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
pub(crate) struct ProjectListResponse {
    pub(crate) items: Vec<CloudProjectBody>,
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
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::Json;
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
            None,
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

    #[test]
    fn execution_environment_defaults_when_metadata_omits_it() {
        let value =
            crate::json_contract_tests::serialized(execution_environment_value(None)).unwrap();
        assert_eq!(
            value,
            json!({
                "repositories": [],
                "setup_steps": [],
                "fingerprint": "",
                "devices": {},
            })
        );
    }

    #[test]
    fn execution_environment_normalizes_devices_and_drops_unknown_keys() {
        let metadata = json!({
            "repositories": [
                {"name": " Wegent ", "url": "https://example.invalid/r", "path": "wegent",
                 "primary": true, "unknown": "dropped"},
            ],
            "fingerprint": "abc",
            "devices": {
                "app-record-1": {"status": "ready", "workspace_path": "/tmp/x",
                                 "prepared_at": "2026-09-18T02:59:27.317525+00:00",
                                 "error": "", "unknown": "dropped"},
                "app-record-2": {"status": "error", "prepared_at": null},
            },
        });
        let value = crate::json_contract_tests::serialized(execution_environment_value(Some(
            &OpaqueJson::from(metadata),
        )))
        .unwrap();
        assert_eq!(
            value,
            json!({
                "repositories": [{
                    "name": "Wegent",
                    "url": "https://example.invalid/r",
                    "ref": "",
                    "path": "wegent",
                    "primary": true,
                }],
                "setup_steps": [],
                "fingerprint": "abc",
                "devices": {
                    "app-record-1": {
                        "status": "ready",
                        "workspace_path": "/tmp/x",
                        "prepared_at": "2026-09-18T02:59:27.317525Z",
                        "error": "",
                    },
                    "app-record-2": {
                        "status": "error",
                        "workspace_path": "",
                        "prepared_at": null,
                        "error": "",
                    },
                },
            })
        );
    }

    #[test]
    fn workspace_context_fills_the_navigation_fields() {
        let workspace = WorkspaceContext {
            id: "4242".to_string(),
            public_id: "11111111-2222-3333-4444-555555555555".to_string(),
            name: "示例空间".to_string(),
        };
        let value = crate::json_contract_tests::serialized(super::project_response(
            &row(json!({"visibility": "public"})),
            302,
            "user",
            "RestrictedAnalyst",
            Some(&workspace),
        ))
        .unwrap();
        assert_eq!(value["workspace_id"], json!("4242"));
        assert_eq!(value["workspace_context"]["id"], json!("4242"));
        assert_eq!(
            value["workspace_context"]["public_id"],
            json!("11111111-2222-3333-4444-555555555555")
        );
        assert_eq!(value["workspace_context"]["name"], json!("示例空间"));
    }

    #[test]
    fn missing_workspace_context_renders_null_navigation_fields() {
        let value = project_response(&row(json!({})), 1, "user", "Owner");
        assert_eq!(value["workspace_id"], Value::Null);
        assert_eq!(value["workspace_context"], Value::Null);
    }

    #[test]
    fn visibility_keeps_the_schema_literals_and_falls_back_to_private() {
        for (stored, expected) in [
            ("public", "public"),
            ("public_restricted", "public_restricted"),
            ("private", "private"),
            ("weird", "private"),
        ] {
            let value = project_response(&row(json!({"visibility": stored})), 1, "u", "Owner");
            assert_eq!(value["visibility"], json!(expected), "stored {stored}");
        }
        let value = project_response(&row(json!({})), 1, "u", "Owner");
        assert_eq!(value["visibility"], json!("private"));
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
