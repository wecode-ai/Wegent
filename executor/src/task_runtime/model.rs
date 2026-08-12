// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStoreKind {
    Local,
    Backend,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskProviderKind {
    Local,
    Backend,
    Github,
    Gitlab,
    DingtalkAitable,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectCreate {
    pub name: String,
    pub project_key: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_task_provider")]
    pub task_provider: TaskProviderKind,
    #[serde(default = "default_provider_config")]
    pub provider_config: Value,
}

fn default_task_provider() -> TaskProviderKind {
    TaskProviderKind::Local
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectDescriptor {
    pub id: String,
    pub public_id: Option<String>,
    pub project_key: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub project_store: ProjectStoreKind,
    pub task_provider: TaskProviderKind,
    #[serde(default = "default_provider_config")]
    pub provider_config: Value,
    #[serde(default = "default_version")]
    pub version: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ProjectUpdate {
    pub version: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub provider_config: Option<Value>,
    pub board_config: Option<Value>,
    pub card_display: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskCreate {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TaskUpdate {
    pub version: i64,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub parent_id: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
    pub execution_payload: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatAgentCreate {
    pub name: String,
    #[serde(default = "default_harness")]
    pub harness: String,
    pub model: Option<String>,
    #[serde(default)]
    pub model_selection: Option<Value>,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub skill_refs: Vec<Value>,
    #[serde(default)]
    pub plugin_refs: Vec<Value>,
    #[serde(default)]
    pub mcp_server_refs: Vec<Value>,
    #[serde(default)]
    pub connector_refs: Vec<Value>,
    #[serde(default)]
    pub secret_refs: Vec<Value>,
    #[serde(default = "default_agent_concurrency")]
    pub concurrency: i64,
    #[serde(default = "default_agent_timeout_seconds")]
    pub timeout_seconds: i64,
    #[serde(default)]
    pub workspace_policy: Value,
    #[serde(default)]
    pub git_policy: Value,
    #[serde(default)]
    pub permission_policy: Value,
    #[serde(default)]
    pub approval_policy: Value,
    pub visibility: Option<String>,
    pub execution_environment: Option<String>,
    pub execution_mode: Option<String>,
    pub execution_device_id: Option<String>,
    #[serde(default)]
    pub local_project_id: Option<i64>,
    #[serde(default)]
    pub created_by_user_id: Option<i64>,
}

impl Default for ChatAgentCreate {
    fn default() -> Self {
        Self {
            name: String::new(),
            harness: default_harness(),
            model: None,
            model_selection: None,
            system_prompt: None,
            skill_refs: Vec::new(),
            plugin_refs: Vec::new(),
            mcp_server_refs: Vec::new(),
            connector_refs: Vec::new(),
            secret_refs: Vec::new(),
            concurrency: default_agent_concurrency(),
            timeout_seconds: default_agent_timeout_seconds(),
            workspace_policy: Value::Object(Default::default()),
            git_policy: Value::Object(Default::default()),
            permission_policy: Value::Object(Default::default()),
            approval_policy: Value::Object(Default::default()),
            visibility: None,
            execution_environment: None,
            execution_mode: None,
            execution_device_id: None,
            local_project_id: None,
            created_by_user_id: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ChatAgentUpdate {
    pub version: i64,
    pub name: Option<String>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub model_selection: Option<Value>,
    pub system_prompt: Option<String>,
    pub skill_refs: Option<Vec<Value>>,
    pub plugin_refs: Option<Vec<Value>>,
    pub mcp_server_refs: Option<Vec<Value>>,
    pub connector_refs: Option<Vec<Value>>,
    pub secret_refs: Option<Vec<Value>>,
    pub concurrency: Option<i64>,
    pub timeout_seconds: Option<i64>,
    pub workspace_policy: Option<Value>,
    pub git_policy: Option<Value>,
    pub permission_policy: Option<Value>,
    pub approval_policy: Option<Value>,
    pub status: Option<String>,
    pub visibility: Option<String>,
    pub execution_environment: Option<String>,
    pub execution_mode: Option<String>,
    pub execution_device_id: Option<String>,
    /// Explicit `null` clears the binding; a missing key keeps it unchanged.
    #[serde(default)]
    pub local_project_id: Option<Option<i64>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatAgent {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub runtime: String,
    pub harness: String,
    pub model: Option<String>,
    pub model_selection: Option<Value>,
    pub system_prompt: String,
    pub skill_refs: Vec<Value>,
    pub plugin_refs: Vec<Value>,
    pub mcp_server_refs: Vec<Value>,
    pub connector_refs: Vec<Value>,
    pub secret_refs: Vec<Value>,
    pub concurrency: i64,
    pub timeout_seconds: i64,
    pub workspace_policy: Value,
    pub git_policy: Value,
    pub permission_policy: Value,
    pub approval_policy: Value,
    pub status: String,
    pub visibility: String,
    pub execution_environment: String,
    pub execution_mode: String,
    pub execution_device_id: Option<String>,
    pub local_project_id: Option<i64>,
    pub created_by_user_id: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_harness() -> String {
    "codex".to_owned()
}

fn default_agent_concurrency() -> i64 {
    1
}

fn default_agent_timeout_seconds() -> i64 {
    3600
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalExecutionClaim {
    pub execution_device_id: Option<String>,
    pub device_capacity: u64,
    pub lease_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalExecution {
    pub id: i64,
    pub loop_item_id: String,
    pub cloud_project_id: String,
    pub task_title: String,
    pub task_status: Option<String>,
    pub task_priority: Option<String>,
    pub agent_id: String,
    pub assigner_user_id: i64,
    pub execution_environment: String,
    pub execution_device_id: Option<String>,
    pub status: String,
    pub priority_weight: i64,
    pub queued_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub lease_expires_at: Option<String>,
    pub heartbeat_at: Option<String>,
    pub retry_attempt: i64,
    pub error_message: String,
    pub execution_note: String,
    pub approval_status: Option<String>,
    pub approved_by_user_id: Option<i64>,
    pub rejected_reason: Option<String>,
    pub runtime_device_id: Option<String>,
    pub runtime_task_id: Option<String>,
    pub execution_payload: Option<Value>,
    pub max_retries: i64,
    pub agent_name: String,
    pub agent_system_prompt: String,
    pub agent_model: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalComment {
    pub id: i64,
    pub message_id: String,
    pub client_message_id: Option<String>,
    pub project_id: String,
    pub task_id: String,
    pub sender_type: String,
    pub sender_id: String,
    pub sender_name: String,
    pub message_type: String,
    pub content: String,
    pub metadata: Value,
    pub trigger_message_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub thread_root_message_id: Option<String>,
    pub status: String,
    pub sequence_number: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalCommentCreate {
    pub project_id: String,
    pub task_id: String,
    pub client_message_id: Option<String>,
    pub sender_type: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub metadata: Value,
    pub reply_to_message_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskReorder {
    pub parent_id: Option<String>,
    pub status: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TaskSearch {
    #[serde(default)]
    pub query: String,
    pub project_id: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub tag: Option<String>,
    pub creator_user_id: Option<i64>,
    pub parent_id: Option<String>,
    pub has_children: Option<bool>,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IssueComment {
    pub id: String,
    pub body: String,
    pub author: String,
    pub web_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimeTaskAddress {
    #[serde(alias = "deviceId")]
    pub device_id: String,
    #[serde(alias = "taskId")]
    pub task_id: String,
    #[serde(default, alias = "taskTitle")]
    pub task_title: Option<String>,
    #[serde(default, alias = "backendTaskId")]
    pub backend_task_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskBinding {
    pub id: String,
    pub cloud_project_id: String,
    pub loop_item_id: Option<String>,
    pub task_user_id: i64,
    pub device_id: String,
    pub task_id: String,
    pub task_title: Option<String>,
    pub backend_task_id: Option<i64>,
    pub linked_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BinaryInput {
    pub display_name: String,
    #[serde(default)]
    pub content_type: Option<String>,
    pub base64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectFile {
    pub id: String,
    pub cloud_project_id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub content_type: Option<String>,
    pub size_bytes: i64,
    pub sha256: Option<String>,
    pub description: String,
    pub created_by_user_id: i64,
    pub updated_by_user_id: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskAttachment {
    pub id: String,
    pub loop_item_id: String,
    pub display_name: String,
    pub content_type: Option<String>,
    pub size_bytes: i64,
    pub sha256: String,
    pub created_by_user_id: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeliveryAsset {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub relative_path: String,
    pub content_type: Option<String>,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Delivery {
    pub id: String,
    pub loop_item_id: String,
    pub created_by_user_id: i64,
    pub source_task_binding_id: Option<String>,
    pub source_task_snapshot: Option<Value>,
    pub status: String,
    pub created_at: String,
    pub delivered_at: Option<String>,
    pub assets: Vec<DeliveryAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeliveryDetail {
    #[serde(flatten)]
    pub delivery: Delivery,
    pub markdown: String,
    pub chat: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeliveryCreate {
    #[serde(default)]
    pub markdown: String,
    #[serde(default)]
    pub chat: Option<Value>,
    #[serde(default)]
    pub source_task: Option<RuntimeTaskAddress>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoopItem {
    pub id: String,
    pub resource_type: String,
    pub project_space: String,
    pub cloud_project_id: Option<String>,
    pub parent_id: Option<String>,
    pub public_id: Option<String>,
    pub project_key: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub description: String,
    #[serde(default)]
    pub created_by_user_id: i64,
    pub sequence_number: Option<i64>,
    pub next_item_number: Option<i64>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub sort_order: i64,
    pub current_delivery_id: Option<String>,
    pub metadata: Value,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<String>,
}

pub fn default_status() -> String {
    "inbox".to_owned()
}

pub fn default_priority() -> String {
    "none".to_owned()
}

fn default_version() -> i64 {
    1
}

fn default_search_limit() -> usize {
    50
}

fn default_provider_config() -> Value {
    Value::Object(Default::default())
}
