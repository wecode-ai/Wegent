// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Fixed response shapes. Fields read verbatim from legacy CRDs retain
//! opaque JSON so null, empty strings and historical types stay intact.
use crate::resource_refs::RequestedSkillRef;
use crate::task_detail_api::views::CachedUserResponse;
use brz_json::RawJson;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SubtaskBotResponse {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub shell_type: String,
    pub agent_config: RawJson,
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
    pub title: RawJson,
    pub git_url: String,
    pub git_repo: String,
    pub git_repo_id: RawJson,
    pub git_domain: String,
    pub branch_name: String,
    pub prompt: RawJson,
    pub status: String,
    pub task_type: String,
    pub project_id: i64,
    pub client_origin: String,
    pub progress: RawJson,
    pub result: RawJson,
    pub error_message: RawJson,
    pub created_at: RawJson,
    pub updated_at: RawJson,
    pub completed_at: RawJson,
    pub user: Option<CachedUserResponse>,
    pub team: Option<TeamResponse>,
    pub subtasks: Vec<SubtaskResponse>,
    pub model_id: RawJson,
    pub force_override_bot_model_type: RawJson,
    pub model_options: Option<std::collections::HashMap<String, String>>,
    pub is_group_chat: bool,
    pub is_group_owner: bool,
    pub member_count: Option<usize>,
    pub app: RawJson,
    pub device_id: RawJson,
    pub execution_workspace_source: Option<String>,
    pub execution_workspace_path: Option<String>,
    pub preserve_executor: bool,
    pub requested_skills: Option<Vec<RequestedSkillRef>>,
    pub external_knowledge_refs: Vec<RawJson>,
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

/// `TeamDisplayConfig` (app/schemas/kind.py). The source `dump_team_display_config`
/// compacts the stored config to its non-null keys, and the task-detail team is
/// then rendered through the response model (`TeamInDB`), which re-serializes
/// the schema model: `show_final_answer_only` is always present, and null when
/// the CRD leaves it unset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TeamDisplayConfig {
    pub show_final_answer_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TeamResponse {
    pub quick_phrases: Vec<String>,
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: RawJson,
    pub description: RawJson,
    pub bots: Vec<TeamBotResponse>,
    pub workflow: TeamWorkflowResponse,
    pub bind_mode: RawJson,
    pub mode_spec: RawJson,
    pub is_active: bool,
    pub icon: RawJson,
    pub display_config: TeamDisplayConfig,
    #[serde(rename = "inputPlaceholder")]
    pub input_placeholder: Option<TeamInputPlaceholder>,
    pub requires_workspace: RawJson,
    pub id: i64,
    pub user_id: i64,
    pub namespace: String,
    pub created_at: String,
    pub updated_at: String,
    pub user: RawJson,
    pub share_status: i32,
    pub agent_type: RawJson,
    pub recommended_mode: String,
    pub publication_status: RawJson,
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
    pub mode: RawJson,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct BotSummaryResponse {
    pub agent_config: RawJson,
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
    pub bot_ids: RawJson,
    pub role: String,
    pub prompt: Option<String>,
    pub executor_namespace: Option<String>,
    pub executor_name: Option<String>,
    pub message_id: i64,
    pub parent_id: Option<i64>,
    pub status: String,
    pub progress: i64,
    pub result: RawJson,
    pub error_message: Option<String>,
    pub user_id: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub completed_at: Option<String>,
    pub bots: Vec<SubtaskBotResponse>,
    pub contexts: Vec<ContextBriefResponse>,
    pub attachments: Vec<RawJson>,
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
    pub file_extension: RawJson,
    pub file_size: RawJson,
    pub mime_type: RawJson,
    pub remote_task_id: RawJson,
    pub remote_path: RawJson,
    pub modified_at: RawJson,
    pub sha256: RawJson,
    pub knowledge_id: RawJson,
    pub document_count: RawJson,
    pub document_ids: RawJson,
    pub folder_ids: RawJson,
    pub folder_names: RawJson,
    pub include_subfolders: RawJson,
    pub scope_restricted: RawJson,
    // The retired `table` context type's `document_id`/`source_config`
    // fields are absent from `SubtaskContextBrief` and from
    // `build_context_display_fields`, so no context type serializes them.
    pub external_provider: RawJson,
    pub external_mode: RawJson,
    pub external_id: RawJson,
    pub external_scope: RawJson,
    pub external_target_type: RawJson,
    pub external_node_id: RawJson,
    pub external_document_id: RawJson,
    pub external_parent_id: RawJson,
    pub external_media_type: RawJson,
    pub text_count: RawJson,
    pub video_count: RawJson,
    pub image_count: RawJson,
    pub comment_count: RawJson,
    pub fetched_comment_count: RawJson,
    pub site: RawJson,
    pub source_url: RawJson,
    pub cover_url: RawJson,
    // Conversation reference fields.
    pub task_id: RawJson,
    pub task_updated_at: RawJson,
}
