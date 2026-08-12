// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionActorRef {
    #[serde(rename = "type")]
    pub actor_type: String,
    pub id: Option<String>,
    pub team_id: Option<i64>,
    pub namespace: Option<String>,
    pub name: Option<String>,
    pub user_id: Option<i64>,
    pub version: Option<i64>,
}

impl ExecutionActorRef {
    pub fn stable_id(&self) -> Option<String> {
        if self.actor_type == "wegent_team" {
            self.team_id.map(|value| value.to_string())
        } else {
            self.id.clone()
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTargetRef {
    #[serde(rename = "type")]
    pub target_type: String,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadInput {
    pub name: String,
    pub leader_agent_id: String,
    pub member_agent_ids: Vec<String>,
    #[serde(default)]
    pub routing_instructions: String,
    #[serde(default = "default_one")]
    pub max_parallel_members: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadUpdate {
    pub version: i64,
    pub name: Option<String>,
    pub leader_agent_id: Option<String>,
    pub member_agent_ids: Option<Vec<String>>,
    pub routing_instructions: Option<String>,
    pub max_parallel_members: Option<i64>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Squad {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub leader_agent_id: String,
    pub member_agent_ids: Vec<String>,
    pub routing_instructions: String,
    pub max_parallel_members: i64,
    pub status: String,
    pub created_by_user_id: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInput {
    pub provider: String,
    pub repository_identity: String,
    pub repository_url: String,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    pub local_project_id: Option<i64>,
    pub default_execution_target: Option<ExecutionTargetRef>,
    pub credential_ref: Option<String>,
    #[serde(default)]
    pub workspace_policy: Value,
    #[serde(default)]
    pub git_policy: Value,
    #[serde(default)]
    pub provider_settings: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryUpdate {
    pub version: i64,
    pub repository_url: Option<String>,
    pub default_branch: Option<String>,
    pub local_project_id: Option<i64>,
    pub default_execution_target: Option<ExecutionTargetRef>,
    pub credential_ref: Option<String>,
    pub workspace_policy: Option<Value>,
    pub git_policy: Option<Value>,
    pub provider_settings: Option<Value>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub project_id: String,
    pub provider: String,
    pub repository_identity: String,
    pub repository_url: String,
    pub default_branch: String,
    pub local_project_id: Option<i64>,
    pub default_execution_target: Option<ExecutionTargetRef>,
    pub has_credential: bool,
    pub webhook_configured: bool,
    pub workspace_policy: Value,
    pub git_policy: Value,
    pub provider_settings: Value,
    pub status: String,
    pub created_by_user_id: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub key: String,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub actor: Option<ExecutionActorRef>,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub input_artifacts: Vec<String>,
    #[serde(default)]
    pub required_outputs: Vec<String>,
    pub workspace_mode: Option<String>,
    #[serde(default = "default_one")]
    pub max_retries: i64,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: i64,
    pub condition: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStageGroup {
    pub key: String,
    pub name: String,
    #[serde(default = "default_serial")]
    pub execution: String,
    #[serde(default = "default_all")]
    pub completion: String,
    pub nodes: Vec<WorkflowNode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_manual")]
    pub trigger_mode: String,
    pub repository_binding_id: Option<String>,
    pub stages: Vec<WorkflowStageGroup>,
    #[serde(default = "default_pause")]
    pub failure_policy: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowUpdate {
    pub version: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub trigger_mode: Option<String>,
    pub repository_binding_id: Option<String>,
    pub stages: Option<Vec<WorkflowStageGroup>>,
    pub failure_policy: Option<String>,
    pub is_default: Option<bool>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub trigger_mode: String,
    pub repository_binding_id: Option<String>,
    pub stages: Vec<WorkflowStageGroup>,
    pub failure_policy: String,
    pub is_default: bool,
    pub status: String,
    pub created_by_user_id: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBindingInput {
    pub version: Option<i64>,
    pub actor: Option<ExecutionActorRef>,
    pub workflow_id: Option<String>,
    pub repository_binding_id: Option<String>,
    pub execution_target: ExecutionTargetRef,
    #[serde(default = "default_workspace_mode")]
    pub workspace_mode: String,
    #[serde(default)]
    pub start_after_save: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBinding {
    pub id: i64,
    pub item_id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_snapshot: Value,
    pub repository_binding_id: Option<String>,
    pub execution_target: ExecutionTargetRef,
    pub workspace_mode: String,
    pub created_by_user_id: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub item_id: String,
    pub workflow_definition_id: Option<String>,
    pub status: String,
    pub current_group_key: Option<String>,
    pub repository_binding_id: Option<String>,
    pub execution_target: ExecutionTargetRef,
    pub execution_target_snapshot: Value,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
    pub trigger_message_id: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
    pub id: String,
    pub workflow_run_id: String,
    pub group_key: String,
    pub node_key: String,
    pub node_type: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub target_snapshot: Value,
    pub execution_target: ExecutionTargetRef,
    pub status: String,
    pub attempt: i64,
    pub loop_item_execution_id: Option<i64>,
    pub runtime_instance_id: Option<String>,
    pub runtime_task_id: Option<String>,
    pub workspace_id: Option<String>,
    pub input_snapshot: Value,
    pub output: Value,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub workflow_run_id: String,
    pub stage_run_id: String,
    pub artifact_type: String,
    pub schema_version: i64,
    pub content: Value,
    pub object_key: Option<String>,
    pub sha256: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDetail {
    #[serde(flatten)]
    pub run: WorkflowRun,
    pub stages: Vec<StageRun>,
    pub artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationValidation {
    pub valid: bool,
    pub issues: Vec<String>,
}

pub fn default_one() -> i64 {
    1
}

fn default_timeout() -> i64 {
    3600
}

fn default_branch() -> String {
    "main".to_owned()
}

fn default_serial() -> String {
    "serial".to_owned()
}

fn default_all() -> String {
    "all".to_owned()
}

fn default_manual() -> String {
    "manual".to_owned()
}

fn default_pause() -> String {
    "pause".to_owned()
}

fn default_workspace_mode() -> String {
    "git_worktree".to_owned()
}
