// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value};

// These fields are intentionally deserialized to enforce the complete producer
// contract even when task creation consumes only a subset directly.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTaskCreateV2 {
    schema_version: u8,
    runtime: RuntimeName,
    message: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    runtime_permission_mode: Option<RuntimePermissionMode>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    model_type: Option<ModelType>,
    #[serde(default)]
    model_options: Map<String, Value>,
    #[serde(default)]
    model_selection: Option<ModelSelection>,
    #[serde(default)]
    project_plugins: Vec<Value>,
    #[serde(default)]
    additional_skills: Vec<Value>,
    #[serde(default)]
    attachment_ids: Vec<u64>,
    #[serde(default)]
    attachments: Vec<Value>,
    #[serde(default)]
    initial_goal: Option<InitialGoal>,
    #[serde(default)]
    initial_supervisor: Option<InitialSupervisor>,
    #[serde(default)]
    additional_context: BTreeMap<String, AdditionalContextEntry>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeName {
    Codex,
    ClaudeCode,
}

#[derive(Debug, Deserialize)]
enum RuntimePermissionMode {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "bypassPermissions")]
    BypassPermissions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModelType {
    Public,
    User,
    Group,
    Runtime,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSelection {
    model_name: String,
    #[serde(default)]
    model_type: Option<ModelType>,
    #[serde(default)]
    options: Map<String, Value>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialGoal {
    objective: String,
    #[serde(default)]
    status: Option<GoalStatus>,
    #[serde(default)]
    token_budget: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum GoalStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialSupervisor {
    mode: SupervisorMode,
    #[serde(default)]
    instructions: String,
    model_selection: ModelSelection,
    interval_seconds: u64,
    #[serde(default, rename = "modelConfig")]
    model_config: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SupervisorMode {
    Suggest,
    Auto,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct AdditionalContextEntry {
    kind: AdditionalContextKind,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AdditionalContextKind {
    Application,
    Untrusted,
}

pub(crate) fn validate_runtime_task_create_v2(payload: &Value) -> Result<(), String> {
    let request: RuntimeTaskCreateV2 =
        serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
    if request.schema_version != 2 {
        return Err("runtime task create V2 must use schemaVersion 2".to_owned());
    }
    if request.message.trim().is_empty() {
        return Err("runtime task create message is required".to_owned());
    }
    if request.extra.contains_key("modelConfig") || request.extra.contains_key("model_config") {
        return Err("RuntimeTaskCreateRequest V2 cannot carry materialized modelConfig".to_owned());
    }
    validate_model_selection(request.model_selection.as_ref())?;
    if let Some(goal) = &request.initial_goal {
        if goal.objective.trim().is_empty() {
            return Err("initialGoal objective is required".to_owned());
        }
        if goal.token_budget == Some(0) {
            return Err("initialGoal tokenBudget must be positive".to_owned());
        }
    }
    if let Some(supervisor) = &request.initial_supervisor {
        validate_model_selection(Some(&supervisor.model_selection))?;
        if !matches!(supervisor.interval_seconds, 10 | 30 | 60 | 300) {
            return Err("initialSupervisor intervalSeconds is unsupported".to_owned());
        }
    }
    for (name, context) in &request.additional_context {
        if name.trim().is_empty() || context.value.is_empty() {
            return Err("additionalContext entries require a name and value".to_owned());
        }
    }
    Ok(())
}

fn validate_model_selection(selection: Option<&ModelSelection>) -> Result<(), String> {
    if selection.is_some_and(|value| value.model_name.trim().is_empty()) {
        return Err("modelSelection modelName is required".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::validate_runtime_task_create_v2;

    #[test]
    fn accepts_shared_runtime_task_create_v2_golden_contract() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../shared/protocol/runtime_task_create_request_v2.golden.json"
        ))
        .unwrap();
        for request in fixtures.as_object().unwrap().values() {
            validate_runtime_task_create_v2(request).unwrap();
        }
    }

    #[test]
    fn rejects_materialized_model_config_in_v2_intent() {
        let request = serde_json::json!({
            "schemaVersion": 2,
            "runtime": "codex",
            "message": "run",
            "modelConfig": {"api_key": "secret"}
        });

        assert!(validate_runtime_task_create_v2(&request)
            .unwrap_err()
            .contains("modelConfig"));
    }
}
