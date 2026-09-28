// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Secondary view conversions for the task-detail response: the public user
//! projection, the team/bot dictionaries, and the subtask/context
//! serialization.
use crate::json_compat::OptionalOpaqueJsonExt;
use crate::json_compat::{JsonProjection, OpaqueJson, raw_json, raw_null};
use serde::Deserialize;
#[cfg(test)]
use serde_json::Map;
use serde_json::{Value, json, value::RawValue};

use super::assembly::{
    extract_display_prompt, iso_timestamp, sanitize_client_payload, shell_type_of,
};
use super::models::{
    BotSummaryResponse, ContextBriefResponse, SubtaskBotResponse, SubtaskResponse, TeamBotResponse,
    TeamDisplayConfig, TeamInputPlaceholder, TeamResponse, TeamWorkflowResponse,
};
use super::repository::{ContextRow, SubtaskRow};
use crate::remote_workspace_tree::kinds::KindStore;
use crate::state::AppState;

/// The public user projection (`model_to_dict(User)` with datetimes rendered
/// ISO and the JSON columns kept as raw text).
#[derive(Debug, Deserialize)]
pub(crate) struct UserCacheDocument {
    pub(crate) id: i64,
    pub(crate) user_name: String,
    #[serde(rename = "password_hash", default)]
    pub(crate) _password_hash: String,
    #[serde(default)]
    pub(crate) email: Option<String>,
    /// `git_info` is stored as a JSON array of git account entries.
    #[serde(default)]
    pub(crate) git_info: Option<Vec<GitAccountEntry>>,
    #[serde(default)]
    pub(crate) is_active: bool,
    #[serde(default)]
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) auth_source: String,
    #[serde(default)]
    pub(crate) preferences: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
}

/// One `git_info` entry of the cached user document (the `GitInfo` model
/// shape: every field optional; unknown stored keys are not used by the
/// response projection).
#[derive(Debug, Deserialize, serde::Serialize)]
pub(crate) struct GitAccountEntry {
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(rename = "type", default)]
    pub(crate) account_type: Option<String>,
    #[serde(default)]
    pub(crate) git_id: Option<String>,
    #[serde(default)]
    pub(crate) auth_type: Option<String>,
    #[serde(default)]
    pub(crate) git_email: Option<String>,
    #[serde(default)]
    pub(crate) git_login: Option<String>,
    #[serde(default)]
    pub(crate) git_token: Option<String>,
    #[serde(default)]
    pub(crate) git_domain: Option<String>,
    #[serde(default)]
    pub(crate) user_name: Option<String>,
}

/// `CachedUserReader.get_by_id`: the `user:v2:data:{user_id}` document, the
/// public SQL reader on a miss, and the `SETEX` write-back that warms the
/// key. A document that no longer decodes into the projection is not found,
/// like the source's `_to_model`.
pub(crate) async fn cached_user(
    state: &AppState,
    user_id: i64,
) -> anyhow::Result<Option<CachedUserResponse>> {
    let Some(raw) = crate::remote_workspace_tree::user_cache::load_document(
        &state.mysql,
        state.redis.as_ref(),
        user_id,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{error:?}"))?
    else {
        return Ok(None);
    };
    let Ok(document) = serde_json::from_str::<UserCacheDocument>(&raw) else {
        return Ok(None);
    };
    let extra = state
        .user_profile
        .cached_user_ext(document.preferences.as_deref());
    Ok(Some(render_cached_user(document, extra)))
}

/// Typed public projection of a cached user document. The password hash is
/// omitted, preferences are parsed from their persisted JSON string, and
/// application fields are flattened at the two extension points.
#[derive(serde::Serialize)]
pub(crate) struct CachedUserResponse {
    id: i64,
    user_name: String,
    email: Option<String>,
    git_info: Option<Vec<GitAccountEntry>>,
    is_active: bool,
    role: String,
    auth_source: String,
    preferences: Option<CachedPreferencesResponse>,
    created_at: Option<String>,
    updated_at: Option<String>,
    #[serde(flatten)]
    extra: crate::user_profile::ErasedFields,
    admin_setup_completed: Option<bool>,
}

// `UserPreferences` keeps its known fields, drops unknown keys and applies
// the legacy defaults to missing and null fields.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct CachedPreferencesInput {
    employee_id: Option<OpaqueJson>,
    send_key: Option<OpaqueJson>,
    follow_up_behavior: Option<OpaqueJson>,
    search_key: Option<OpaqueJson>,
    memory_enabled: Option<OpaqueJson>,
    chat_status_items: Option<OpaqueJson>,
    tool_output_guard_enabled: Option<OpaqueJson>,
    mcp_provider_keys: Option<OpaqueJson>,
    quick_access: Option<OpaqueJson>,
    composer_quick_phrases: Option<OpaqueJson>,
    default_execution_target: Option<OpaqueJson>,
    wework_new_chat_model_selection: Option<OpaqueJson>,
    wework_project_execution_mode: Option<OpaqueJson>,
    wework_project_work_preferences: Option<OpaqueJson>,
    runtime_configs: Option<OpaqueJson>,
}

/// `QuickAccessPreference`: the source parses the persisted object with the
/// schema and re-serializes it, so `version` and `teams` always appear (with
/// their schema defaults) and unknown keys are dropped.
#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct QuickAccessView {
    version: Option<i64>,
    teams: Vec<i64>,
}

/// `ComposerQuickPhrase`: same re-serialization contract as
/// `QuickAccessView`; the six schema fields keep their stored values and
/// unknown keys are dropped.
#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct ComposerQuickPhraseView {
    id: Option<OpaqueJson>,
    title: Option<OpaqueJson>,
    content: Option<OpaqueJson>,
    mode: Option<OpaqueJson>,
    #[serde(rename = "attachmentPaths")]
    attachment_paths: Option<OpaqueJson>,
    #[serde(rename = "createdAt")]
    created_at: Option<OpaqueJson>,
}

/// `UserPreferences.quick_access`: absent or stored `null` stays `null`;
/// otherwise the object is re-rendered through `QuickAccessView`.
fn normalize_quick_access(field: Option<OpaqueJson>) -> Option<QuickAccessView> {
    let field = field?;
    if field.is_null() {
        return None;
    }
    field.project::<QuickAccessView>()
}

/// `UserPreferences.composer_quick_phrases`: absent or stored `null` stays
/// `null`; otherwise every phrase is re-rendered through
/// `ComposerQuickPhraseView`.
fn normalize_composer_quick_phrases(
    field: Option<OpaqueJson>,
) -> Option<Vec<ComposerQuickPhraseView>> {
    let field = field?;
    if field.is_null() {
        return None;
    }
    field.project::<Vec<ComposerQuickPhraseView>>()
}

/// The stored preferences document, read like the source's
/// `UserInDB.parse_preferences` (`backend/app/schemas/user.py:210-227`): a
/// stored value keeps its preferences only when it parses to a non-empty JSON
/// object. `null`, an empty string, the literal `"null"`, the empty object
/// `{}`, and every non-mapping document all render `null`.
#[derive(Deserialize)]
#[serde(untagged)]
enum CachedPreferencesDocument {
    /// `{}` — the source's `if not parsed: return None`. Declared ahead of
    /// [`Self::Object`] so an empty mapping is not read as a stored
    /// preference set.
    Empty(EmptyPreferences),
    /// A mapping with at least one key — `UserPreferences(**parsed)`.
    Object(Box<CachedPreferencesInput>),
}

/// Matches the empty document `{}` and nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyPreferences {}

#[derive(serde::Serialize)]
struct CachedPreferencesResponse {
    employee_id: Option<OpaqueJson>,
    send_key: Option<OpaqueJson>,
    follow_up_behavior: Option<OpaqueJson>,
    search_key: Option<OpaqueJson>,
    memory_enabled: Option<OpaqueJson>,
    chat_status_items: Option<OpaqueJson>,
    tool_output_guard_enabled: Option<OpaqueJson>,
    mcp_provider_keys: Option<OpaqueJson>,
    quick_access: Option<QuickAccessView>,
    composer_quick_phrases: Option<Vec<ComposerQuickPhraseView>>,
    default_execution_target: Option<OpaqueJson>,
    wework_new_chat_model_selection: Option<OpaqueJson>,
    wework_project_execution_mode: Option<OpaqueJson>,
    #[serde(flatten)]
    extra: crate::user_profile::ErasedFields,
    wework_project_work_preferences: Option<OpaqueJson>,
    runtime_configs: Option<OpaqueJson>,
}

pub(crate) fn render_cached_user(
    stored: UserCacheDocument,
    extra: crate::user_profile::UserViewExt,
) -> CachedUserResponse {
    let (top_level_extra, preference_extra) = extra.into_parts();
    CachedUserResponse {
        id: stored.id,
        user_name: stored.user_name,
        email: stored.email,
        git_info: stored.git_info,
        is_active: stored.is_active,
        role: stored.role,
        auth_source: stored.auth_source,
        preferences: cached_preferences(stored.preferences.as_deref(), preference_extra),
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        extra: top_level_extra,
        admin_setup_completed: None,
    }
}

fn cached_preferences(
    raw: Option<&str>,
    extra: crate::user_profile::ErasedFields,
) -> Option<CachedPreferencesResponse> {
    let raw = raw.filter(|raw| !raw.is_empty() && *raw != "null")?;
    let CachedPreferencesDocument::Object(mut input) =
        serde_json::from_str::<CachedPreferencesDocument>(raw).ok()?
    else {
        return None;
    };
    input.send_key.get_or_insert_with(|| json!("enter").into());
    input
        .follow_up_behavior
        .get_or_insert_with(|| json!("queue").into());
    input
        .search_key
        .get_or_insert_with(|| json!("cmd_k").into());
    input
        .memory_enabled
        .get_or_insert_with(|| json!(false).into());
    input
        .tool_output_guard_enabled
        .get_or_insert_with(|| json!(false).into());
    input
        .wework_project_execution_mode
        .get_or_insert_with(|| json!("current_workspace").into());
    input
        .wework_project_work_preferences
        .get_or_insert_with(|| json!({}).into());
    input
        .runtime_configs
        .get_or_insert_with(|| json!({}).into());
    Some(CachedPreferencesResponse {
        employee_id: input.employee_id,
        send_key: input.send_key,
        follow_up_behavior: input.follow_up_behavior,
        search_key: input.search_key,
        memory_enabled: input.memory_enabled,
        chat_status_items: input.chat_status_items,
        tool_output_guard_enabled: input.tool_output_guard_enabled,
        mcp_provider_keys: input.mcp_provider_keys,
        quick_access: normalize_quick_access(input.quick_access),
        composer_quick_phrases: normalize_composer_quick_phrases(input.composer_quick_phrases),
        default_execution_target: input.default_execution_target,
        wework_new_chat_model_selection: input.wework_new_chat_model_selection,
        wework_project_execution_mode: input.wework_project_execution_mode,
        extra,
        wework_project_work_preferences: input.wework_project_work_preferences,
        runtime_configs: input.runtime_configs,
    })
}

// Typed input for `_convert_to_team_dict`.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamViewSpec {
    members: Option<Vec<Option<TeamViewMember>>>,
    bind_mode: Option<OpaqueJson>,
    quick_phrases: Option<Vec<Option<String>>>,
    description: Option<OpaqueJson>,
    #[serde(rename = "collaborationModel")]
    collaboration_model: Option<OpaqueJson>,
    #[serde(rename = "modeSpec")]
    mode_spec: Option<OpaqueJson>,
    icon: Option<OpaqueJson>,
    #[serde(rename = "displayConfig")]
    display_config: Option<OpaqueJson>,
    #[serde(rename = "inputPlaceholder")]
    input_placeholder: Option<OpaqueJson>,
    #[serde(rename = "requiresWorkspace")]
    requires_workspace: Option<OpaqueJson>,
    capability: Option<TeamViewCapability>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamViewMember {
    #[serde(rename = "botRef")]
    bot_ref: Option<crate::crd::ResourceReference>,
    prompt: Option<String>,
    role: Option<String>,
    #[serde(rename = "requireConfirmation")]
    require_confirmation: Option<bool>,
    #[serde(rename = "contextPassing")]
    context_passing: Option<String>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamViewCapability {
    #[serde(rename = "publishStatus")]
    publish_status: Option<OpaqueJson>,
}

pub(crate) async fn build_team_response(
    state: &AppState,
    kinds: &KindStore<'_, brz_mysql::MysqlService, impl brz_redis::Redis>,
    team: &crate::remote_workspace_tree::kinds::KindRecord,
    user_id: i64,
) -> Result<TeamResponse, crate::remote_workspace_tree::error::ApiError> {
    let _ = state;
    let team_crd = crate::crd::CrdDocument::project(&team.json.0);
    let spec = team_crd
        .spec
        .as_ref()
        .and_then(|_| team.json.0.get("spec"))
        .and_then(|spec| JsonProjection::<TeamViewSpec>::from_json(spec).value)
        .unwrap_or_default();
    let is_group_resource = !team.namespace.is_empty() && team.namespace != "default";

    let mut bots = Vec::new();
    let mut shell_types: Vec<String> = Vec::new();
    let mut first_bot_id: Option<i64> = None;
    if let Some(members) = spec.members.as_ref() {
        for member in members.iter().filter_map(|member| member.as_ref()) {
            let Some(bot_ref) = member.bot_ref.as_ref() else {
                continue;
            };
            let Some((name, namespace)) = bot_ref.nonempty_parts() else {
                continue;
            };
            let bot = if is_group_resource {
                kinds.get_group("Bot", &namespace, &name).await?
            } else {
                kinds
                    .get_by_name_and_namespace(team.user_id, "Bot", &namespace, &name)
                    .await?
            };
            let Some(bot) = bot else {
                continue;
            };
            let summary_user_id = if is_group_resource {
                bot.user_id
            } else {
                user_id
            };
            let bot_summary = build_bot_summary(kinds, &bot, summary_user_id).await?;
            if first_bot_id.is_none() {
                first_bot_id = Some(bot.id);
            }
            if !bot_summary.shell_type.is_empty() && !shell_types.contains(&bot_summary.shell_type)
            {
                shell_types.push(bot_summary.shell_type.clone());
            }
            bots.push(TeamBotResponse {
                bot_id: bot.id,
                bot_prompt: member.prompt.clone().unwrap_or_default(),
                role: member.role.clone().unwrap_or_default(),
                require_confirmation: member.require_confirmation.unwrap_or(false),
                context_passing: normalize_context_passing(member.context_passing.as_deref())
                    .to_owned(),
                bot: bot_summary,
            });
        }
    }
    let _ = shell_types;

    // Agent type from the first bot's shell.
    let mut agent_type = raw_null();
    if let Some(first_bot_id) = first_bot_id
        && let Some(first_bot) = kinds.get_by_id("Bot", first_bot_id).await?
    {
        let bot_crd = crate::crd::CrdDocument::project(&first_bot.json.0);
        if let Some(shell_ref) = bot_crd
            .spec
            .as_ref()
            .and_then(|spec| spec.shell_ref.as_ref())
        {
            let shell_user_id = if is_group_resource {
                first_bot.user_id
            } else {
                user_id
            };
            let shell = kinds
                .get_by_name_and_namespace(
                    shell_user_id,
                    "Shell",
                    shell_ref.namespace(),
                    shell_ref.name(),
                )
                .await?;
            if let Some(shell_type) = shell.as_ref().and_then(shell_type_of) {
                agent_type = serde_json::value::to_raw_value(&match shell_type {
                    "Agno" => "agno".to_owned(),
                    "ClaudeCode" => "claude".to_owned(),
                    "Dify" => "dify".to_owned(),
                    other => other.to_lowercase(),
                })
                .unwrap();
            }
        }
    }

    Ok(team_response(team, &team_crd, &spec, bots, agent_type))
}

fn team_response(
    team: &crate::remote_workspace_tree::kinds::KindRecord,
    team_crd: &crate::crd::CrdDocument,
    spec: &TeamViewSpec,
    bots: Vec<TeamBotResponse>,
    agent_type: Box<RawValue>,
) -> TeamResponse {
    let bind_modes = spec
        .bind_mode
        .as_ref()
        .and_then(OpaqueJson::project::<Vec<Option<String>>>)
        .unwrap_or_default();
    let recommended_mode =
        if bind_mode_contains(&bind_modes, "code") && bind_mode_contains(&bind_modes, "chat") {
            "both"
        } else if bind_mode_contains(&bind_modes, "code") {
            "code"
        } else {
            "chat"
        };
    // `dump_team_display_config` compacts the stored `displayConfig` to its
    // non-null keys, and the response model re-serializes the result as
    // `TeamDisplayConfig`, so `show_final_answer_only` is always emitted
    // (null when unset, including a config that is missing or empty).
    let display_config = spec
        .display_config
        .as_ref()
        .and_then(OpaqueJson::project::<TeamDisplayConfig>)
        .unwrap_or_default();
    TeamResponse {
        quick_phrases: quick_phrases(spec),
        name: team.name.clone(),
        display_name: team_crd
            .metadata
            .as_ref()
            .map(|metadata| metadata.display_name.raw_or(()))
            .unwrap_or_else(raw_null),
        description: spec.description.raw_or(()),
        bots,
        workflow: TeamWorkflowResponse {
            mode: spec.collaboration_model.raw_or(()),
        },
        bind_mode: spec.bind_mode.raw_or(()),
        mode_spec: spec.mode_spec.raw_or(()),
        is_active: team.is_active != 0,
        icon: spec.icon.raw_or(()),
        display_config,
        input_placeholder: spec
            .input_placeholder
            .as_ref()
            .and_then(OpaqueJson::project::<TeamInputPlaceholder>),
        requires_workspace: spec.requires_workspace.raw_or(()),
        id: team.id,
        user_id: team.user_id,
        namespace: team.namespace.clone(),
        created_at: iso_timestamp(team.created_at),
        updated_at: iso_timestamp(team.updated_at),
        user: raw_null(),
        share_status: 0,
        agent_type,
        recommended_mode: recommended_mode.to_owned(),
        publication_status: spec
            .capability
            .as_ref()
            .map(|capability| capability.publish_status.raw_or(()))
            .unwrap_or_else(raw_null),
    }
}

fn bind_mode_contains(bind_mode: &[Option<String>], mode: &str) -> bool {
    bind_mode.iter().any(|value| value.as_deref() == Some(mode))
}

fn quick_phrases(spec: &TeamViewSpec) -> Vec<String> {
    spec.quick_phrases
        .as_ref()
        .map(|phrases| {
            phrases
                .iter()
                .filter_map(|phrase| phrase.as_deref())
                .map(str::trim)
                .filter(|phrase| !phrase.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_context_passing(value: Option<&str>) -> &str {
    match value {
        Some("none" | "original_user" | "previous_bot" | "original_and_previous") => value.unwrap(),
        _ => "none",
    }
}

/// `_get_bot_summary`.
pub(crate) async fn build_bot_summary(
    kinds: &KindStore<'_, brz_mysql::MysqlService, impl brz_redis::Redis>,
    bot: &crate::remote_workspace_tree::kinds::KindRecord,
    user_id: i64,
) -> Result<BotSummaryResponse, crate::remote_workspace_tree::error::ApiError> {
    let bot_crd = crate::crd::CrdDocument::project(&bot.json.0);
    let bot_spec = bot_crd.spec.as_ref();

    let shell_type = match bot_spec
        .and_then(|spec| spec.shell_ref.as_ref())
        .and_then(|reference| reference.nonempty_parts())
    {
        Some((name, namespace)) => {
            let shell = kinds
                .get_by_name_and_namespace(user_id, "Shell", &namespace, &name)
                .await?;
            shell
                .and_then(|shell| shell_type_of(&shell).map(str::to_owned))
                .unwrap_or_default()
        }
        None => String::new(),
    };

    let mut agent_config = serde_json::Map::new();
    if let Some((name, namespace)) = bot_spec
        .and_then(|spec| spec.model_ref.as_ref())
        .and_then(|reference| reference.nonempty_parts())
    {
        let model = kinds
            .get_by_name_and_namespace(user_id, "Model", &namespace, &name)
            .await?;
        if let Some(model) = model {
            let model_spec = model.json.0.get("spec").cloned().unwrap_or(Value::Null);
            let is_custom_config = model_spec
                .get("isCustomConfig")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_custom_config {
                if let Some(config) = model_spec.get("modelConfig").and_then(Value::as_object) {
                    agent_config = config.clone();
                }
                if let Some(protocol) = model_spec.get("protocol").and_then(Value::as_str) {
                    agent_config.insert("protocol".into(), json!(protocol));
                }
            } else {
                agent_config.insert("bind_model".into(), json!(name));
                agent_config.insert(
                    "bind_model_type".into(),
                    json!(if model.user_id == user_id {
                        "user"
                    } else {
                        "public"
                    }),
                );
            }
        }
    }

    Ok(BotSummaryResponse {
        agent_config: raw_json(&serde_json::Value::Object(agent_config)),
        agent_name: None,
        shell_type,
    })
}

/// Typed projection of `convert_subtasks_to_dict` with attached contexts.
pub(crate) fn subtask_responses(
    subtasks: &[SubtaskRow],
    contexts: &[ContextRow],
    bots: &[SubtaskBotResponse],
    inherited_task_ids: &[i64],
) -> Vec<SubtaskResponse> {
    subtasks
        .iter()
        .map(|subtask| {
            let inherited = inherited_task_ids.contains(&subtask.task_id);
            let subtask_bots: Vec<SubtaskBotResponse> = subtask
                .bot_ids
                .project::<Vec<Option<i64>>>()
                .map(|ids| {
                    ids.into_iter()
                        .flatten()
                        .filter_map(|bot_id| bots.iter().find(|bot| bot.id == bot_id).cloned())
                        .collect()
                })
                .unwrap_or_default();
            let contexts_list: Vec<ContextBriefResponse> = contexts
                .iter()
                .filter(|context| context.subtask_contexts_subtask_id == subtask.id)
                .map(context_brief)
                .collect();
            SubtaskResponse {
                id: subtask.id,
                task_id: subtask.task_id,
                inherited,
                origin_task_id: subtask.task_id,
                origin_subtask_id: subtask.id,
                team_id: subtask.team_id,
                title: subtask.title.clone(),
                bot_ids: subtask.bot_ids.to_raw_value(),
                role: subtask.role.clone(),
                prompt: extract_display_prompt(subtask.prompt.as_deref()),
                executor_namespace: subtask.executor_namespace.clone(),
                executor_name: subtask.executor_name.clone(),
                message_id: subtask.message_id,
                parent_id: subtask.parent_id,
                status: subtask.status.clone(),
                progress: subtask.progress,
                result: subtask
                    .result
                    .as_ref()
                    .map(|result| raw_json(&sanitize_client_payload(result.to_value())))
                    .unwrap_or_else(raw_null),
                error_message: subtask.error_message.clone(),
                user_id: subtask.user_id,
                created_at: subtask.created_at.map(iso_timestamp),
                updated_at: subtask.updated_at.map(iso_timestamp),
                completed_at: subtask.completed_at.map(iso_timestamp),
                bots: subtask_bots,
                contexts: contexts_list,
                attachments: {
                    let values: Vec<serde_json::Value> = Vec::new();
                    values.iter().map(raw_json).collect()
                },
                sender_type: subtask.sender_type.clone(),
                sender_user_id: subtask.sender_user_id,
                sender_user_name: None,
                reply_to_subtask_id: subtask.reply_to_subtask_id,
            }
        })
        .collect()
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ContextTypeData {
    file_extension: Option<OpaqueJson>,
    file_size: Option<OpaqueJson>,
    mime_type: Option<OpaqueJson>,
    knowledge_id: Option<OpaqueJson>,
    document_count: Option<OpaqueJson>,
    document_ids: Option<OpaqueJson>,
    folder_ids: Option<OpaqueJson>,
    folder_names: Option<OpaqueJson>,
    include_subfolders: Option<OpaqueJson>,
    scope_restricted: Option<OpaqueJson>,
    document_id: Option<OpaqueJson>,
    provider: Option<OpaqueJson>,
    mode: Option<OpaqueJson>,
    #[serde(rename = "id")]
    external_id: Option<OpaqueJson>,
    scope: Option<OpaqueJson>,
    target_type: Option<OpaqueJson>,
    node_id: Option<OpaqueJson>,
    parent_id: Option<OpaqueJson>,
}

fn context_field(field: &Option<OpaqueJson>, enabled: bool) -> Box<RawValue> {
    if enabled {
        field.raw_or(())
    } else {
        raw_null()
    }
}

/// `build_context_display_fields` for `selected_documents`:
/// `len(document_ids) if isinstance(document_ids, list) else 0`.
fn selected_document_count(document_ids: &Option<OpaqueJson>) -> i64 {
    document_ids
        .as_ref()
        .and_then(|value| value.project::<Vec<serde::de::IgnoredAny>>())
        .map_or(0, |ids| ids.len() as i64)
}

/// `SubtaskContextBrief.from_model` + `build_context_display_fields`.
pub(crate) fn context_brief(context: &ContextRow) -> ContextBriefResponse {
    let data = context
        .subtask_contexts_type_data
        .as_ref()
        .and_then(|value| value.0.project::<ContextTypeData>())
        .unwrap_or_default();
    let context_type = context.subtask_contexts_context_type.as_str();
    let attachment = context_type == "attachment";
    let knowledge = context_type == "knowledge_base";
    let external = context_type == "external_knowledge";
    // `build_context_display_fields` renders `selected_documents` as the
    // stored document-id count (`len(document_ids)` when it is a list, else
    // `0`), and leaves every other display field at its schema default.
    let selected_documents = context_type == "selected_documents";

    ContextBriefResponse {
        id: context.subtask_contexts_id,
        context_type: context_type.to_owned(),
        name: context.subtask_contexts_name.clone(),
        status: context.subtask_contexts_status.clone(),
        file_extension: context_field(&data.file_extension, attachment),
        file_size: context_field(&data.file_size, attachment),
        mime_type: context_field(&data.mime_type, attachment),
        knowledge_id: context_field(&data.knowledge_id, knowledge),
        document_count: if selected_documents {
            OpaqueJson::from_serializable(selected_document_count(&data.document_ids))
                .to_raw_value()
        } else {
            context_field(&data.document_count, knowledge)
        },
        document_ids: context_field(&data.document_ids, knowledge),
        folder_ids: context_field(&data.folder_ids, knowledge),
        folder_names: context_field(&data.folder_names, knowledge),
        include_subfolders: context_field(&data.include_subfolders, knowledge),
        scope_restricted: context_field(&data.scope_restricted, knowledge),
        external_provider: context_field(&data.provider, external),
        external_mode: context_field(&data.mode, external),
        external_id: context_field(&data.external_id, external),
        external_scope: context_field(&data.scope, external),
        external_target_type: context_field(&data.target_type, external),
        external_node_id: context_field(&data.node_id, external),
        external_document_id: context_field(&data.document_id, external),
        external_parent_id: context_field(&data.parent_id, external),
        external_media_type: raw_null(),
        text_count: raw_null(),
        video_count: raw_null(),
        image_count: raw_null(),
        comment_count: raw_null(),
        fetched_comment_count: raw_null(),
        site: raw_null(),
        source_url: raw_null(),
        cover_url: raw_null(),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod json_contract_tests {
    use super::*;
    #[test]
    fn context_json_baseline() {
        let mut output = Vec::new();
        for kind in [
            "attachment",
            "knowledge_base",
            "table",
            "external_knowledge",
            "other",
        ] {
            for value in [
                None,
                Some(json!(null)),
                Some(json!("")),
                Some(json!({})),
                Some(json!([])),
                Some(json!(0)),
            ] {
                let mut data = Map::new();
                if let Some(value) = &value {
                    for key in [
                        "file_extension",
                        "file_size",
                        "mime_type",
                        "knowledge_id",
                        "document_count",
                        "document_ids",
                        "folder_ids",
                        "folder_names",
                        "include_subfolders",
                        "scope_restricted",
                        "document_id",
                        "provider",
                        "mode",
                        "id",
                        "scope",
                        "target_type",
                        "node_id",
                        "parent_id",
                    ] {
                        data.insert(key.into(), value.clone());
                    }
                }
                let context = ContextRow {
                    subtask_contexts_id: 1,
                    subtask_contexts_subtask_id: 7,
                    subtask_contexts_context_type: kind.into(),
                    subtask_contexts_name: Some("".into()),
                    subtask_contexts_status: None,
                    subtask_contexts_type_data: Some(brz_mysql::Json(OpaqueJson::from(
                        Value::Object(data),
                    ))),
                };
                output
                    .push(crate::json_contract_tests::serialized(context_brief(&context)).unwrap());
            }
        }
        crate::json_contract_tests::assert_fixture("task_contexts", output);
    }
    #[test]
    fn subtask_json_baseline() {
        let mut output = Vec::new();
        for populated in [false, true] {
            let optional = populated.then(String::new);
            let subtask = SubtaskRow {
                id: 7,
                user_id: 1,
                task_id: 2,
                team_id: populated.then_some(0),
                title: optional.clone(),
                bot_ids: json!([3, 1, 3, "1", null]).into(),
                role: "ASSISTANT".into(),
                executor_namespace: optional.clone(),
                executor_name: optional.clone(),
                prompt: optional.clone(),
                message_id: 1,
                parent_id: populated.then_some(0),
                status: "COMPLETED".into(),
                progress: 0,
                result: populated.then(|| json!({"value":"","task_url":"private"}).into()),
                error_message: optional.clone(),
                created_at: None,
                updated_at: None,
                completed_at: None,
                sender_type: optional,
                sender_user_id: populated.then_some(0),
                reply_to_subtask_id: populated.then_some(0),
            };
            output.push(
                crate::json_contract_tests::serialized(subtask_responses(
                    &[subtask],
                    &[],
                    &[],
                    if populated { &[2] } else { &[] },
                ))
                .unwrap(),
            );
        }
        crate::json_contract_tests::assert_fixture("task_subtasks", output);
    }
}
