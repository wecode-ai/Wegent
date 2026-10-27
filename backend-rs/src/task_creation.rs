// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task/Workspace CRD payload construction for task creation
//! (`app/services/chat/storage/task_manager.py:create_new_task` and its
//! `workspace_factory`).
//!
//! `POST /api/v1/responses` reaches this through `setup_chat_session` ->
//! `prepare_execution_session` -> `create_new_task`, so the payloads here are
//! what the create path persists. Key order is contractual: the stored JSON is
//! compared byte-for-byte, and the source builds an insertion-ordered Python
//! dict. `serde_json`'s `preserve_order` feature keeps the same order, and
//! [`crate::json_compat::python_json_value`] renders the Python
//! `json.dumps(..., ensure_ascii=True)` separators and `\uXXXX` escapes.
use serde_json::{Map, Value, json};

/// `workspace_factory`'s repository block (`WorkspaceConfig` / task
/// `git_url` / `branch`).
#[derive(Default)]
pub struct WorkspaceRepository<'a> {
    pub git_url: &'a str,
    pub git_repo: &'a str,
    pub git_repo_id: i64,
    pub git_domain: &'a str,
    pub branch_name: &'a str,
}

/// `workspace_factory`: the Workspace CRD payload for `workspace-{task_id}`.
pub fn build_workspace_payload(
    name: &str,
    namespace: &str,
    repository: &WorkspaceRepository<'_>,
) -> Value {
    json!({
        "kind": "Workspace",
        "spec": {
            "repository": {
                "gitUrl": repository.git_url,
                "gitRepo": repository.git_repo,
                "gitRepoId": repository.git_repo_id,
                "gitDomain": repository.git_domain,
                "branchName": repository.branch_name,
            }
        },
        "status": {"state": "Available"},
        "metadata": {"name": name, "namespace": namespace},
        "apiVersion": "agent.wecode.io/v1",
    })
}

/// The subset of `TaskCreationParams` / `create_new_task` inputs the Task CRD
/// payload depends on.
#[derive(Clone, Copy)]
pub struct TaskCrdInput<'a> {
    pub task_id: i64,
    pub team_name: &'a str,
    pub team_namespace: &'a str,
    pub team_user_id: i64,
    pub message: &'a str,
    /// `params.title`; defaults to the message (truncated at 50 chars).
    pub title: Option<&'a str>,
    /// `params.task_type`; defaults to `code` for a git workspace else `chat`.
    pub task_type: Option<&'a str>,
    pub source: &'a str,
    /// `params.project_id`: the Task's project row. The source writes the
    /// `projectId` label between `source` and `is_api_call`.
    pub project_id: i64,
    pub api_key_name: Option<&'a str>,
    pub model_id: Option<&'a str>,
    pub force_override_bot_model: bool,
    pub is_group_chat: bool,
    pub is_api_call: bool,
    pub auto_delete_executor: Option<&'a str>,
    pub omit_mcp_binary_output: bool,
    pub device_id: Option<&'a str>,
    /// `params.git_url` is set: drives the `taskType` default (`code`).
    pub git_workspace: bool,
    /// `datetime.now().isoformat()` at request time.
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

/// `params.task_name or f"task-{task_id}"`.
pub fn task_name(task_id: i64) -> String {
    format!("task-{task_id}")
}

/// `create_pending_task_shell`'s placeholder name
/// (`f"task-pending-{uuid4().hex}"`): 32 lowercase hex characters from 16
/// random bytes, discarded once `create_new_task` renames the row.
pub fn pending_task_name() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    let mut hex = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!("task-pending-{hex}")
}

/// `create_new_task`'s title: the explicit title, else the message truncated to
/// 50 characters with an ellipsis.
pub fn task_title(message: &str, title: Option<&str>) -> String {
    match title {
        Some(title) => title.to_string(),
        None if message.chars().count() > 50 => {
            let prefix: String = message.chars().take(50).collect();
            format!("{prefix}...")
        }
        None => message.to_string(),
    }
}

/// `create_new_task`: the Task CRD payload persisted by the follow-up UPDATE.
pub fn build_task_crd(input: &TaskCrdInput<'_>) -> Value {
    let task_type = input
        .task_type
        .unwrap_or(if input.git_workspace { "code" } else { "chat" });
    let task_name = task_name(input.task_id);

    let mut labels = Map::new();
    labels.insert("type".to_string(), json!("online"));
    labels.insert("taskType".to_string(), json!(task_type));
    labels.insert(
        "autoDeleteExecutor".to_string(),
        json!(input.auto_delete_executor.unwrap_or("false")),
    );
    labels.insert("source".to_string(), json!(input.source));
    if input.project_id != 0 {
        labels.insert("projectId".to_string(), json!(input.project_id.to_string()));
    }
    if input.is_api_call {
        labels.insert("is_api_call".to_string(), json!("true"));
    }
    if let Some(model_id) = input.model_id {
        labels.insert("modelId".to_string(), json!(model_id));
    }
    if input.force_override_bot_model {
        labels.insert("forceOverrideBotModel".to_string(), json!("true"));
    }
    if let Some(api_key_name) = input.api_key_name {
        labels.insert("api_key_name".to_string(), json!(api_key_name));
    }
    if input.omit_mcp_binary_output {
        labels.insert("omitMcpBinaryOutput".to_string(), json!("true"));
    }

    let mut spec = Map::new();
    spec.insert(
        "title".to_string(),
        json!(task_title(input.message, input.title)),
    );
    spec.insert("prompt".to_string(), json!(input.message));
    spec.insert(
        "teamRef".to_string(),
        json!({
            "name": input.team_name,
            "namespace": input.team_namespace,
            "user_id": input.team_user_id,
        }),
    );
    spec.insert(
        "workspaceRef".to_string(),
        json!({"name": format!("workspace-{}", input.task_id), "namespace": "default"}),
    );
    spec.insert("is_group_chat".to_string(), json!(input.is_group_chat));
    if let Some(device_id) = input.device_id {
        spec.insert("device_id".to_string(), json!(device_id));
    }

    json!({
        "kind": "Task",
        "spec": Value::Object(spec),
        "status": {
            "state": "Available",
            "status": "PENDING",
            "progress": 0,
            "result": null,
            "errorMessage": "",
            "createdAt": input.created_at,
            "updatedAt": input.updated_at,
            "completedAt": null,
        },
        "metadata": {
            "name": task_name,
            "namespace": "default",
            "labels": Value::Object(labels),
        },
        "apiVersion": "agent.wecode.io/v1",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_compat::python_json_value;

    fn recorded_input() -> TaskCrdInput<'static> {
        TaskCrdInput {
            task_id: 897_064_049_841_442,
            team_name: "team-beta",
            team_namespace: "ns-b",
            team_user_id: 1809,
            message: "不吃糊饼",
            title: None,
            task_type: Some("chat"),
            source: "chat_shell",
            project_id: 0,
            api_key_name: Some("auth_intro_audit"),
            model_id: Some("deepseek-flash-not-think(公网)"),
            force_override_bot_model: true,
            is_group_chat: false,
            is_api_call: true,
            auto_delete_executor: Some("false"),
            omit_mcp_binary_output: false,
            device_id: None,
            created_at: "2026-10-10T14:20:16.492497",
            updated_at: "2026-10-10T14:20:16.492500",
            git_workspace: false,
        }
    }

    #[test]
    fn task_crd_matches_the_recorded_payload() {
        let payload = build_task_crd(&recorded_input());

        // The recorded UPDATE tasks_0383 json, rebuilt independently here in
        // its insertion order. Python `json.dumps` escapes non-ASCII, so the
        // rendered strings (which are order-sensitive) are compared.
        let expected = serde_json::json!({
            "kind": "Task",
            "spec": {
                "title": "不吃糊饼",
                "prompt": "不吃糊饼",
                "teamRef": {"name": "team-beta", "namespace": "ns-b", "user_id": 1809},
                "workspaceRef": {"name": "workspace-897064049841442", "namespace": "default"},
                "is_group_chat": false,
            },
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "result": null,
                "errorMessage": "",
                "createdAt": "2026-10-10T14:20:16.492497",
                "updatedAt": "2026-10-10T14:20:16.492500",
                "completedAt": null,
            },
            "metadata": {
                "name": "task-897064049841442",
                "namespace": "default",
                "labels": {
                    "type": "online",
                    "taskType": "chat",
                    "autoDeleteExecutor": "false",
                    "source": "chat_shell",
                    "is_api_call": "true",
                    "modelId": "deepseek-flash-not-think(公网)",
                    "forceOverrideBotModel": "true",
                    "api_key_name": "auth_intro_audit",
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        });

        assert_eq!(payload, expected);
        assert_eq!(python_json_value(&payload), python_json_value(&expected));
        // The stored text escapes the non-ASCII fields.
        assert!(python_json_value(&payload).contains("deepseek-flash-not-think(\\u516c\\u7f51)"));
    }

    #[test]
    fn workspace_payload_matches_the_recorded_insert() {
        let payload = build_workspace_payload(
            "workspace-897064049841442",
            "default",
            &WorkspaceRepository::default(),
        );
        assert_eq!(
            python_json_value(&payload),
            concat!(
                r#"{"kind": "Workspace", "spec": {"repository": {"gitUrl": "", "#,
                r#""gitRepo": "", "gitRepoId": 0, "gitDomain": "", "branchName": ""}}, "#,
                r#""status": {"state": "Available"}, "#,
                r#""metadata": {"name": "workspace-897064049841442", "namespace": "default"}, "#,
                r#""apiVersion": "agent.wecode.io/v1"}"#
            )
        );
    }

    #[test]
    fn title_truncates_long_messages() {
        let long = "a".repeat(60);
        assert_eq!(task_title(&long, None), format!("{}...", "a".repeat(50)));
        assert_eq!(task_title("short", None), "short");
        assert_eq!(task_title("short", Some("custom")), "custom");
    }

    #[test]
    fn project_id_label_sits_between_source_and_is_api_call() {
        // Recorded create Task: labels `... "source": "chat_shell",
        // "projectId": "2571", "is_api_call": "true", ...`.
        let payload = build_task_crd(&TaskCrdInput {
            project_id: 2571,
            ..recorded_input()
        });
        let labels = payload["metadata"]["labels"].as_object().expect("labels");
        assert_eq!(labels["projectId"], serde_json::json!("2571"));
        let keys: Vec<&String> = labels.keys().collect();
        let source = keys
            .iter()
            .position(|key| *key == "source")
            .expect("source");
        let project = keys
            .iter()
            .position(|key| *key == "projectId")
            .expect("projectId");
        let api = keys
            .iter()
            .position(|key| *key == "is_api_call")
            .expect("is_api_call");
        assert_eq!(project, source + 1);
        assert_eq!(api, project + 1);
        // A task without a project keeps the source's conditional label.
        assert!(
            build_task_crd(&recorded_input())["metadata"]["labels"]
                .get("projectId")
                .is_none()
        );
    }

    #[test]
    fn task_type_defaults_to_chat_without_git_workspace() {
        let payload = build_task_crd(&TaskCrdInput {
            task_type: None,
            ..recorded_input()
        });
        assert_eq!(
            payload["metadata"]["labels"]["taskType"],
            serde_json::json!("chat")
        );
    }
}
