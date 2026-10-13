// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `ProjectWorkflowDefinition` rendering for `CloudProjectResponse`.
//!
//! `CloudProjectResponse.workflow_definition` is a
//! `app.schemas.issue_workflow.ProjectWorkflowDefinition`. Its `nodes` are
//! `WorkflowNodeDefinition` models, so the source re-materializes every schema
//! default while validating the stored metadata: a legacy stored node that
//! omits the optional fields still renders them (empty lists, `null`, `false`,
//! and the literal defaults), and a node that carries `automation_rule_id` but
//! no explicit `execution_mode` is inferred as `robot`. `id` and `name` remain
//! required, exactly as the source model declares them; a stored value that is
//! not a `WorkflowNodeDefinition` object is echoed unchanged rather than
//! rejected.

use brz_json::OpaqueJson;
use brz_json::RawJson;
use serde_json::json;

/// `ProjectWorkflowDefinition` input: the stored workflow object read back with
/// the container-level schema defaults.
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

/// `app.schemas.issue_workflow.WorkflowNodeDefinition`. Every optional field
/// carries the schema default; `id` and `name` stay required.
#[derive(serde::Deserialize)]
struct WorkflowNodeInput {
    id: String,
    name: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    kind: Option<OpaqueJson>,
    #[serde(default = "default_node_type")]
    node_type: String,
    #[serde(default)]
    role: Option<OpaqueJson>,
    #[serde(default)]
    start_config: Option<OpaqueJson>,
    #[serde(default)]
    loop_id: Option<String>,
    #[serde(default)]
    body_node_ids: Vec<OpaqueJson>,
    #[serde(default)]
    loop_config: Option<OpaqueJson>,
    #[serde(default)]
    branch_conditions: Vec<OpaqueJson>,
    #[serde(default)]
    event_wait: Option<OpaqueJson>,
    #[serde(default)]
    execution_mode: Option<String>,
    #[serde(default)]
    depends_on: Vec<OpaqueJson>,
    #[serde(default = "default_dependency_context")]
    dependency_context: OpaqueJson,
    #[serde(default = "default_required")]
    required: bool,
    #[serde(default)]
    required_deliverables: Vec<OpaqueJson>,
    #[serde(default = "default_workspace_policy")]
    workspace_policy: String,
    #[serde(default)]
    automation_rule_id: Option<String>,
    #[serde(default)]
    required_assignee_type: Option<OpaqueJson>,
    #[serde(default)]
    required_assignee_id: Option<String>,
    #[serde(default)]
    execution_config: Option<OpaqueJson>,
    #[serde(default)]
    execution_config_override: bool,
}

/// Serialized `WorkflowNodeDefinition`, field order matching the source model.
#[derive(serde::Serialize)]
struct WorkflowNode {
    id: String,
    name: String,
    prompt: String,
    kind: Option<OpaqueJson>,
    node_type: String,
    role: Option<OpaqueJson>,
    start_config: Option<OpaqueJson>,
    loop_id: Option<String>,
    body_node_ids: Vec<OpaqueJson>,
    loop_config: Option<OpaqueJson>,
    branch_conditions: Vec<OpaqueJson>,
    event_wait: Option<OpaqueJson>,
    execution_mode: String,
    depends_on: Vec<OpaqueJson>,
    dependency_context: OpaqueJson,
    required: bool,
    required_deliverables: Vec<OpaqueJson>,
    workspace_policy: String,
    automation_rule_id: Option<String>,
    required_assignee_type: Option<OpaqueJson>,
    required_assignee_id: Option<String>,
    execution_config: Option<OpaqueJson>,
    execution_config_override: bool,
}

fn default_node_type() -> String {
    "task".to_string()
}
fn default_workspace_policy() -> String {
    "composer".to_string()
}
fn default_required() -> bool {
    true
}
fn default_dependency_context() -> OpaqueJson {
    OpaqueJson::from(json!({}))
}

/// `WorkflowNodeDefinition.infer_legacy_execution_mode`: an absent
/// `execution_mode` defaults to `human`, or `robot` when the node owns an
/// automation rule. An explicit value always wins.
fn execution_mode_value(input: &mut WorkflowNodeInput) -> String {
    match input.execution_mode.take() {
        Some(mode) => mode,
        None if input
            .automation_rule_id
            .as_deref()
            .is_some_and(|rule| !rule.is_empty()) =>
        {
            "robot".to_string()
        }
        None => "human".to_string(),
    }
}

/// Materialize one stored node into a serialized `WorkflowNodeDefinition`. A
/// value that does not satisfy the required `id`/`name` shape is echoed as
/// stored.
fn workflow_node_value(node: OpaqueJson) -> RawJson {
    let Some(mut input) = node.project::<WorkflowNodeInput>() else {
        return node.to_raw_value();
    };
    let execution_mode = execution_mode_value(&mut input);
    let output = WorkflowNode {
        id: input.id,
        name: input.name,
        prompt: input.prompt,
        kind: input.kind,
        node_type: input.node_type,
        role: input.role,
        start_config: input.start_config,
        loop_id: input.loop_id,
        body_node_ids: input.body_node_ids,
        loop_config: input.loop_config,
        branch_conditions: input.branch_conditions,
        event_wait: input.event_wait,
        execution_mode,
        depends_on: input.depends_on,
        dependency_context: input.dependency_context,
        required: input.required,
        required_deliverables: input.required_deliverables,
        workspace_policy: input.workspace_policy,
        automation_rule_id: input.automation_rule_id,
        required_assignee_type: input.required_assignee_type,
        required_assignee_id: input.required_assignee_id,
        execution_config: input.execution_config,
        execution_config_override: input.execution_config_override,
    };
    brz_json::to_raw_value(&output).expect("workflow node serializes")
}

/// `ProjectWorkflowDefinition` response shape.
#[derive(Debug, serde::Serialize)]
pub(crate) struct WorkflowDefinition {
    version: i64,
    stage_mode: String,
    advancement_policy: String,
    coordinator_prompt: String,
    approval_policy: String,
    ai_automation_rule_id: Option<RawJson>,
    execution_config: Option<RawJson>,
    nodes: Vec<RawJson>,
}

/// `ProjectWorkflowDefinition` with schema defaults, including the
/// `infer_legacy_stage_mode` branch and the materialized node defaults.
pub(crate) fn workflow_definition_value(config: Option<&OpaqueJson>) -> WorkflowDefinition {
    let input = config
        .and_then(OpaqueJson::project::<WorkflowInput>)
        .unwrap_or_default();
    let opaque =
        |value: OpaqueJson| brz_json::to_raw_value(&value).expect("workflow value serializes");
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
            .map(workflow_node_value)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn render(metadata: Value) -> Value {
        crate::json_contract_tests::serialized(workflow_definition_value(Some(&OpaqueJson::from(
            metadata,
        ))))
        .unwrap()
    }

    #[test]
    fn materializes_legacy_node_defaults() {
        let value = render(json!({
            "nodes": [
                {"id": "stage-1", "name": "开发", "prompt": "p", "kind": null,
                 "required": true, "depends_on": [],
                 "workspace_policy": "composer",
                 "automation_rule_id": "4140012799994987955",
                 "dependency_context": {}, "required_deliverables": []},
                {"id": "stage-2", "name": "测试", "prompt": "t", "kind": null,
                 "required": true, "depends_on": ["stage-1"],
                 "workspace_policy": "inherit", "automation_rule_id": null,
                 "dependency_context": {"stage-1": ["final_result"]},
                 "required_deliverables": []},
            ],
        }));
        let first = &value["nodes"][0];
        assert_eq!(first["node_type"], json!("task"));
        assert_eq!(first["execution_mode"], json!("robot"));
        assert_eq!(first["body_node_ids"], json!([]));
        assert_eq!(first["branch_conditions"], json!([]));
        assert_eq!(first["execution_config_override"], json!(false));
        assert_eq!(first["required_assignee_type"], Value::Null);
        assert_eq!(first["required_assignee_id"], Value::Null);
        // Explicit null keys are present, not omitted.
        assert!(first.get("start_config").is_some());
        assert_eq!(first["event_wait"], Value::Null);
        assert_eq!(first["execution_config"], Value::Null);
        let second = &value["nodes"][1];
        assert_eq!(second["execution_mode"], json!("human"));
        assert_eq!(
            second["dependency_context"],
            json!({"stage-1": ["final_result"]})
        );
    }

    #[test]
    fn echoes_nodes_without_required_identity() {
        let value = render(json!({"nodes": [{"x": null}, {"id": "only-id"}]}));
        assert_eq!(value["nodes"], json!([{"x": null}, {"id": "only-id"}]));
    }
}
