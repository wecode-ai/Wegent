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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectCreate {
    pub name: String,
    pub project_key: Option<String>,
    #[serde(default)]
    pub description: String,
    pub task_provider: TaskProviderKind,
    #[serde(default = "default_provider_config")]
    pub provider_config: Value,
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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskReorder {
    pub parent_id: Option<String>,
    pub status: String,
    pub item_ids: Vec<String>,
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

fn default_provider_config() -> Value {
    Value::Object(Default::default())
}
