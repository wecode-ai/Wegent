// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The shared `TaskLite` projection of the personal and group lite lists
//! (`build_lite_task_list`, `_batch_query_devices` and their helpers).
//!
//! Extracted from [`super::lite_repository`] to keep that module within the
//! repository's file-size bound; `lite_repository` re-exports nothing here, so
//! callers import the projection items directly.

use std::collections::{HashMap, HashSet};

use brz_mysql::Mysql;
use chrono::NaiveDateTime;
use serde_json::Value as Json;

use crate::crd::{CrdDocument, CrdSpec};

use super::lite_repository::{TaskCandidateRow, TeamData, TeamKindRow};

/// One `TaskLite` item (`app/schemas/task.py`), the `TaskLiteListResponse`
/// element shared by the personal and group lite lists.
#[derive(Debug, serde::Serialize)]
pub struct LiteTask {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub task_type: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub team_id: Option<i64>,
    pub team_name: String,
    pub team_namespace: String,
    pub team_display_name: Option<String>,
    pub team_icon: Option<String>,
    pub project_id: i64,
    pub client_origin: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub execution_workspace_source: Option<String>,
    pub execution_workspace_path: Option<String>,
    pub git_repo: String,
    pub is_group_chat: bool,
    pub knowledge_base_id: Option<i64>,
}

/// How `build_lite_task_list` derives `is_group_chat`.
pub enum GroupChatRule<'a> {
    /// The personal list passes `include_group_chat_info=False`, so only the
    /// CRD `spec.is_group_chat` is read.
    SpecOnly,
    /// The group list passes `include_group_chat_info=True`: the row's own
    /// `is_group_chat`, the CRD `spec.is_group_chat`, or an approved group-chat
    /// member (`_add_group_chat_info`).
    WithMembers(&'a HashSet<i64>),
}

/// `build_lite_task_list`: the shared per-task projection of the lite lists.
pub fn project_lite_tasks(
    tasks: &[TaskCandidateRow],
    team_data: &TeamData,
    workspace_data: &HashMap<(String, String), String>,
    device_data: &HashMap<String, String>,
    group_chat: GroupChatRule<'_>,
) -> Vec<LiteTask> {
    let mut items = Vec::with_capacity(tasks.len());
    for task in tasks {
        let crd = CrdDocument::project(&task.json);
        let spec = crd.spec.as_ref();
        let labels = crd
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.labels.as_ref());
        let task_type = labels
            .and_then(|labels| labels.task_type.clone())
            .unwrap_or_else(|| "chat".to_owned());
        let type_value = labels
            .and_then(|labels| labels.legacy_type.clone())
            .unwrap_or_else(|| "online".to_owned());
        let source = labels
            .and_then(|labels| labels.source.clone())
            .filter(|value| !value.is_empty());

        let task_status = crd.status.as_ref();
        let status = task_status
            .and_then(|status| status.status.clone())
            .unwrap_or_else(|| "PENDING".to_owned());
        let datetime = |value: Option<String>, fallback: NaiveDateTime| {
            value
                .and_then(|value| {
                    NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f").ok()
                })
                .unwrap_or(fallback)
        };
        let created_at = datetime(
            task_status.and_then(|status| opaque_string(&status.created_at)),
            task.created_at,
        );
        let updated_at = datetime(
            task_status.and_then(|status| opaque_string(&status.updated_at)),
            task.updated_at,
        );

        let team_ref = crd.spec.as_ref().and_then(|spec| spec.team_ref.as_ref());
        let team_name_ref = team_ref
            .map(|reference| reference.name())
            .unwrap_or("")
            .to_owned();
        let team_namespace_ref = team_ref
            .map(|reference| reference.namespace())
            .unwrap_or("default")
            .to_owned();
        let team_user_id = team_ref
            .and_then(|reference| reference.user_id.as_ref())
            .and_then(|id| id.json_integer());
        let team = team_data.resolve(&team_name_ref, &team_namespace_ref, team_user_id);

        let workspace_ref = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.workspace_ref.as_ref());
        let workspace_name = workspace_ref
            .map(|reference| reference.name())
            .unwrap_or("")
            .to_owned();
        let workspace_namespace = workspace_ref
            .map(|reference| reference.namespace())
            .unwrap_or("default")
            .to_owned();
        let git_repo = workspace_data
            .get(&(workspace_name, workspace_namespace))
            .cloned()
            .unwrap_or_default();

        let device_id = spec
            .and_then(|spec| opaque_string(&spec.device_id))
            .filter(|value| !value.is_empty());
        let device_name = device_id
            .as_ref()
            .and_then(|id| device_data.get(id).cloned())
            .unwrap_or_default();

        let spec_is_group_chat = spec.and_then(|spec| spec.is_group_chat).unwrap_or(false);
        let is_group_chat = match group_chat {
            GroupChatRule::SpecOnly => spec_is_group_chat,
            GroupChatRule::WithMembers(members) => {
                task.is_group_chat || spec_is_group_chat || members.contains(&task.id)
            }
        };

        let knowledge_base_id = if task_type == "knowledge" {
            spec.and_then(|spec| spec.knowledge_base_refs.as_ref())
                .and_then(|refs| refs.first())
                .and_then(|first| first.as_ref())
                .and_then(|reference| reference.id)
        } else {
            None
        };

        items.push(LiteTask {
            id: task.id,
            title: spec
                .and_then(|spec| opaque_string(&spec.title))
                .unwrap_or_default(),
            status,
            task_type,
            kind: type_value,
            source,
            created_at: format_python_datetime(&created_at),
            updated_at: format_python_datetime(&updated_at),
            completed_at: task_status.and_then(|status| opaque_string(&status.completed_at)),
            team_id: team.id,
            team_name: team.name,
            team_namespace: team.namespace,
            team_display_name: team.display_name,
            team_icon: team.icon,
            project_id: task.project_id.unwrap_or(0),
            client_origin: task
                .client_origin
                .clone()
                .unwrap_or_else(|| "frontend".to_string()),
            device_id,
            device_name: (!device_name.is_empty()).then_some(device_name),
            execution_workspace_source: execution_workspace_field(spec, true),
            execution_workspace_path: execution_workspace_field(spec, false),
            git_repo,
            is_group_chat,
            knowledge_base_id,
        });
    }
    items
}

/// Render a naive datetime exactly like pydantic's default serialization:
/// `YYYY-MM-DDTHH:MM:SS.ffffff` with microsecond precision.
pub fn format_python_datetime(value: &NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

/// `get_task_execution_workspace_source` / `get_task_execution_workspace_path`
/// (`spec.execution.workspace.{source,path}`, trimmed non-empty strings).
pub(crate) fn opaque_string(field: &Option<crate::json_compat::OpaqueJson>) -> Option<String> {
    field.as_ref()?.project::<String>()
}

fn execution_workspace_field(spec: Option<&CrdSpec>, source: bool) -> Option<String> {
    let workspace = spec?.execution.as_ref()?.workspace.as_ref()?;
    let value = if source {
        &workspace.source
    } else {
        &workspace.path
    };
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `_batch_query_devices`: display names for the page's device references.
pub async fn device_display_names<M>(
    mysql: &M,
    user_id: i64,
    device_ids: &[String],
) -> HashMap<String, String>
where
    M: Mysql,
{
    let mut result = HashMap::new();
    if device_ids.is_empty() {
        return result;
    }
    let placeholders = vec!["?"; device_ids.len()].join(", ");
    let sql = format!(
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
         kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
         AND kinds.namespace = 'default' AND kinds.name IN ({placeholders}) \
         AND kinds.is_active IS true"
    );
    // Bind with recorded literal kinds: `user_id` int, device names strings
    // (`serde_json::Value` would serialize every parameter as a string).
    let mut args: Vec<crate::task_store::StatementArg> =
        vec![crate::task_store::StatementArg::Int(user_id)];
    args.extend(
        device_ids
            .iter()
            .map(|id| crate::task_store::StatementArg::Str(id.clone())),
    );
    let rows: Result<Vec<TeamKindRow>, _> = mysql.fetch_all(sql.as_str(), args).await;
    if let Ok(rows) = rows {
        for row in rows {
            let display_name = row
                .json
                .as_ref()
                .and_then(|json| {
                    json.get("spec")
                        .and_then(|spec| spec.get("displayName"))
                        .and_then(Json::as_str)
                        .or_else(|| {
                            json.get("metadata")
                                .and_then(|metadata| metadata.get("displayName"))
                                .and_then(Json::as_str)
                        })
                })
                .map(str::to_string)
                .unwrap_or_else(|| row.name.clone());
            result.insert(row.name, display_name);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, spec: Json, project_id: i64, row_group_chat: bool) -> TaskCandidateRow {
        let epoch = chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc();
        TaskCandidateRow {
            id,
            user_id: 1,
            json: serde_json::json!({"spec": spec}),
            created_at: epoch,
            updated_at: epoch,
            project_id: Some(project_id),
            client_origin: None,
            is_group_chat: row_group_chat,
        }
    }

    #[test]
    fn spec_only_reads_the_crd_flag() {
        let tasks = vec![
            row(1, serde_json::json!({"is_group_chat": true}), 0, false),
            row(2, serde_json::json!({"is_group_chat": false}), 0, true),
        ];
        let items = project_lite_tasks(
            &tasks,
            &TeamData::default(),
            &Default::default(),
            &Default::default(),
            GroupChatRule::SpecOnly,
        );
        // Only the CRD flag is read; the row's own flag is ignored.
        assert!(items[0].is_group_chat);
        assert!(!items[1].is_group_chat);
    }

    #[test]
    fn members_rule_ors_the_row_flag_crd_flag_and_member_set() {
        let tasks = vec![
            row(1, serde_json::json!({}), 0, false),
            row(2, serde_json::json!({"is_group_chat": true}), 0, false),
            row(3, serde_json::json!({}), 5, true),
        ];
        let members: HashSet<i64> = [1].into_iter().collect();
        let items = project_lite_tasks(
            &tasks,
            &TeamData::default(),
            &Default::default(),
            &Default::default(),
            GroupChatRule::WithMembers(&members),
        );
        // `_add_group_chat_info`: a membership makes task 1 a group chat, the
        // CRD flag makes task 2 one, and the row flag makes task 3 one.
        assert!(items[0].is_group_chat);
        assert!(items[1].is_group_chat);
        assert!(items[2].is_group_chat);
        assert_eq!(items[2].project_id, 5);
    }
}
