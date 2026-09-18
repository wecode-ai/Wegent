// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Fixed response shapes. Fields read verbatim from legacy CRDs retain
//! opaque JSON so null, empty strings and historical types stay intact.
use crate::resource_refs::RequestedSkillRef;
use crate::task_detail_api::views::CachedUserResponse;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubtaskBotResponse {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub shell_type: String,
    pub agent_config: Box<RawValue>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct SubtaskAgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_model_type: Option<&'static str>,
}

#[derive(Serialize)]
pub(crate) struct TaskDetailResponse {
    pub id: i64,
    pub title: Box<RawValue>,
    pub git_url: String,
    pub git_repo: String,
    pub git_repo_id: Box<RawValue>,
    pub git_domain: String,
    pub branch_name: String,
    pub prompt: Box<RawValue>,
    pub status: String,
    pub task_type: String,
    pub project_id: i64,
    pub client_origin: String,
    pub progress: Box<RawValue>,
    pub result: Box<RawValue>,
    pub error_message: Box<RawValue>,
    pub created_at: Box<RawValue>,
    pub updated_at: Box<RawValue>,
    pub completed_at: Box<RawValue>,
    pub user: Option<CachedUserResponse>,
    pub team: Option<TeamResponse>,
    pub subtasks: Vec<SubtaskResponse>,
    pub model_id: Box<RawValue>,
    pub force_override_bot_model_type: Box<RawValue>,
    pub model_options: Option<std::collections::HashMap<String, String>>,
    pub is_group_chat: bool,
    pub is_group_owner: bool,
    pub member_count: Option<usize>,
    pub app: Box<RawValue>,
    pub device_id: Box<RawValue>,
    pub execution_workspace_source: Option<String>,
    pub execution_workspace_path: Option<String>,
    pub preserve_executor: bool,
    pub requested_skills: Option<Vec<RequestedSkillRef>>,
    pub external_knowledge_refs: Vec<Box<RawValue>>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamBotResponse {
    pub bot_id: i64,
    pub bot_prompt: String,
    pub role: String,
    #[serde(rename = "requireConfirmation")]
    pub require_confirmation: bool,
    #[serde(rename = "contextPassing")]
    pub context_passing: String,
    pub bot: BotSummaryResponse,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamResponse {
    pub quick_phrases: Vec<String>,
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: Box<RawValue>,
    pub description: Box<RawValue>,
    pub bots: Vec<TeamBotResponse>,
    pub workflow: TeamWorkflowResponse,
    pub bind_mode: Box<RawValue>,
    pub mode_spec: Box<RawValue>,
    pub is_active: bool,
    pub icon: Box<RawValue>,
    pub display_config: Box<RawValue>,
    #[serde(rename = "inputPlaceholder")]
    pub input_placeholder: Option<TeamInputPlaceholder>,
    pub requires_workspace: Box<RawValue>,
    pub id: i64,
    pub user_id: i64,
    pub namespace: String,
    pub created_at: String,
    pub updated_at: String,
    pub user: Box<RawValue>,
    pub share_status: i32,
    pub agent_type: Box<RawValue>,
    pub recommended_mode: String,
    pub publication_status: Box<RawValue>,
}

/// `LocalizedInputPlaceholder`: one locale pair. Both keys always serialize,
/// so an unset locale is an explicit null.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct LocalizedInputPlaceholder {
    pub en: Option<String>,
    pub zh: Option<String>,
}

/// `TeamInputPlaceholder`: localized input placeholder text with
/// device-specific overrides. The task-detailed team is rendered through the
/// source response model (`TeamInDB`), which re-serializes every field, so an
/// unset locale or device override is an explicit null rather than an absent
/// key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TeamInputPlaceholder {
    pub en: Option<String>,
    pub zh: Option<String>,
    pub mobile: Option<LocalizedInputPlaceholder>,
    pub desktop: Option<LocalizedInputPlaceholder>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamWorkflowResponse {
    pub mode: Box<RawValue>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct BotSummaryResponse {
    pub agent_config: Box<RawValue>,
    pub agent_name: Option<String>,
    pub shell_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubtaskResponse {
    pub id: i64,
    pub task_id: i64,
    pub inherited: bool,
    pub origin_task_id: i64,
    pub origin_subtask_id: i64,
    pub team_id: Option<i64>,
    pub title: Option<String>,
    pub bot_ids: Box<RawValue>,
    pub role: String,
    pub prompt: Option<String>,
    pub executor_namespace: Option<String>,
    pub executor_name: Option<String>,
    pub message_id: i64,
    pub parent_id: Option<i64>,
    pub status: String,
    pub progress: i64,
    pub result: Box<RawValue>,
    pub error_message: Option<String>,
    pub user_id: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub completed_at: Option<String>,
    pub bots: Vec<SubtaskBotResponse>,
    pub contexts: Vec<ContextBriefResponse>,
    pub attachments: Vec<Box<RawValue>>,
    pub sender_type: Option<String>,
    pub sender_user_id: Option<i64>,
    pub sender_user_name: Option<String>,
    pub reply_to_subtask_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ContextBriefResponse {
    pub id: i64,
    pub context_type: String,
    pub name: Option<String>,
    pub status: Option<String>,
    pub file_extension: Box<RawValue>,
    pub file_size: Box<RawValue>,
    pub mime_type: Box<RawValue>,
    pub knowledge_id: Box<RawValue>,
    pub document_count: Box<RawValue>,
    pub document_ids: Box<RawValue>,
    pub folder_ids: Box<RawValue>,
    pub folder_names: Box<RawValue>,
    pub include_subfolders: Box<RawValue>,
    pub scope_restricted: Box<RawValue>,
    // The retired `table` context type's `document_id`/`source_config`
    // fields are absent from `SubtaskContextBrief` and from
    // `build_context_display_fields`, so no context type serializes them.
    pub external_provider: Box<RawValue>,
    pub external_mode: Box<RawValue>,
    pub external_id: Box<RawValue>,
    pub external_scope: Box<RawValue>,
    pub external_target_type: Box<RawValue>,
    pub external_node_id: Box<RawValue>,
    pub external_document_id: Box<RawValue>,
    pub external_parent_id: Box<RawValue>,
    pub external_media_type: Box<RawValue>,
    pub text_count: Box<RawValue>,
    pub video_count: Box<RawValue>,
    pub image_count: Box<RawValue>,
    pub comment_count: Box<RawValue>,
    pub fetched_comment_count: Box<RawValue>,
    pub site: Box<RawValue>,
    pub source_url: Box<RawValue>,
    pub cover_url: Box<RawValue>,
}
