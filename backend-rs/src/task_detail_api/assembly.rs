// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response assembly for `GET /api/tasks/{task_id}`.
//!
//! Mirrors `convert_to_task_dict` (adapters/task_kinds/converters.py),
//! `get_task_detail` (queries.py), `_convert_to_task_dict` and
//! `_get_bot_summary` (team_kinds.py), and `convert_subtasks_to_dict`,
//! `get_bots_for_subtasks`, `add_group_chat_info_to_task`
//! (task_detail_helpers.py).
use crate::crd::{CrdDocument, reference_parts};
use crate::json_compat::OptionalOpaqueJsonExt;
use crate::json_compat::{JsonProjection, OpaqueJson, raw_json, raw_null};
#[cfg(test)]
use serde_json::json;
use serde_json::{Value, value::RawValue};

use super::models::{
    SubtaskAgentConfig, SubtaskBotResponse, SubtaskResponse, TaskDetailResponse, TeamResponse,
};
use super::repository::SubtaskRow;
use super::repository::{
    TaskRow, count_approved_members, get_accessible_task_owner, get_active_non_deleted_task,
    get_task_by_id_with_owner, get_workspace_by_ref, is_approved_member, list_contexts,
    list_subtasks_by_task, owner_matches_task_id,
};
use super::views::{CachedUserResponse, build_team_response, cached_user, subtask_responses};
use crate::remote_workspace_tree::kinds::KindStore;
use crate::resource_refs::{EmptyNamespace, RequestedSkillRef, parse_requested_skill_refs};
use crate::state::AppState;

/// Sentinel for the source 404 `Task not found` mapping.
#[derive(Debug)]
pub(crate) struct TaskNotFound;

impl std::fmt::Display for TaskNotFound {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Task not found")
    }
}

impl std::error::Error for TaskNotFound {}

/// The full detail response document (`TaskDetail` schema).
pub(crate) struct TaskDetailOutcome {
    pub body: TaskDetailResponse,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PromptBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum ModelOptionInput {
    String(String),
    Null(()),
    Other(OpaqueJson),
}

impl ModelOptionInput {
    fn into_string(self) -> Option<String> {
        match self {
            Self::String(value) => Some(value),
            Self::Null(()) => None,
            Self::Other(value) => serde_json::to_string(&value).ok(),
        }
    }
}

/// `parse_prompt_blocks` (shared/prompts/constants.py): plain text passes
/// through; JSON block lists keep only the user-visible text.
pub(crate) fn extract_display_prompt(prompt: Option<&str>) -> Option<String> {
    let prompt = prompt?;
    if let Ok(JsonProjection {
        value: Some(blocks),
    }) = serde_json::from_str::<JsonProjection<Vec<Option<PromptBlock>>>>(prompt)
    {
        return Some(parse_block_list(&blocks, prompt));
    }
    if prompt.contains("[User Question]:") {
        return Some(extract_user_question(prompt).to_owned());
    }
    Some(prompt.to_owned())
}

fn parse_block_list(blocks: &[Option<PromptBlock>], raw_prompt: &str) -> String {
    let mut user_text: Option<String> = None;
    for block in blocks.iter().filter_map(|block| block.as_ref()) {
        let block_type = block.kind.as_deref().unwrap_or("");
        if block_type != "text" && block_type != "input_text" {
            continue;
        }
        let text = block.text.as_deref().unwrap_or("");
        let stripped = text.trim_start();
        if stripped.starts_with("<system-reminder>") {
            continue;
        }
        if stripped.starts_with("[User Question]:") && user_text.is_none() {
            user_text = Some(extract_user_question(stripped).to_owned());
            continue;
        }
        if stripped.starts_with("<attachment>") || stripped.starts_with("<selected_documents>") {
            continue;
        }
        if user_text.is_none() {
            user_text = Some(text.to_owned());
        }
    }
    user_text.unwrap_or_else(|| raw_prompt.to_owned())
}

fn extract_user_question(text: &str) -> &str {
    if let Some((_, after)) = text.split_once("[User Question]:") {
        after.trim_start_matches('\n').trim()
    } else {
        text.trim()
    }
}

/// Python `datetime.isoformat()`: `T`-separated, microseconds omitted when
/// zero. MySQL `DATETIME` columns carry second precision.
pub(crate) fn iso_timestamp(timestamp: chrono::NaiveDateTime) -> String {
    timestamp.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// `sanitize_client_payload`: drop private workflow URL keys recursively.
pub(crate) fn sanitize_client_payload(payload: Value) -> Value {
    match payload {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| {
                    !matches!(key.as_str(), "polling_url" | "query_url" | "task_url")
                })
                .map(|(key, value)| (key, sanitize_client_payload(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(sanitize_client_payload)
                .collect::<Vec<_>>(),
        ),
        other => other,
    }
}

/// `ShellSpec.shellType`: accepts `spec.runtime` as the backward-compatible
/// validation alias (`AliasChoices("shellType", "runtime")`).
pub(crate) fn shell_type_of(
    shell: &crate::remote_workspace_tree::kinds::KindRecord,
) -> Option<&str> {
    let spec = shell.json.0.get("spec")?;
    spec.get("shellType")
        .or_else(|| spec.get("runtime"))
        .and_then(|value| value.as_str())
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct WorkspaceDocumentInput {
    spec: Option<WorkspaceSpecInput>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct WorkspaceSpecInput {
    repository: Option<WorkspaceRepositoryInput>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct WorkspaceRepositoryInput {
    #[serde(rename = "gitUrl")]
    git_url: Option<String>,
    #[serde(rename = "gitRepo")]
    git_repo: Option<String>,
    #[serde(rename = "gitRepoId")]
    git_repo_id: Option<OpaqueJson>,
    #[serde(rename = "gitDomain")]
    git_domain: Option<String>,
    #[serde(rename = "branchName")]
    branch_name: Option<String>,
}

/// The `get_task_detail` chain: dependency sequence plus response assembly.
pub(crate) async fn build_task_detail(
    state: &AppState,
    task_id: i64,
    user_id: i64,
    client_origin: Option<&str>,
) -> anyhow::Result<TaskDetailOutcome> {
    let mysql = &state.mysql;
    let kinds = KindStore {
        mysql,
        redis: state.redis.as_ref(),
    };

    // `get_task_by_id`: active non-deleted task, `is_member`'s accessible
    // check, then the member-row check for non-owners.
    let Some(task) =
        get_active_non_deleted_task(mysql, state.task_policy, task_id, client_origin).await?
    else {
        anyhow::bail!(TaskNotFound);
    };
    if get_accessible_task_owner(mysql, task_id).await?.is_none() {
        anyhow::bail!(TaskNotFound);
    }
    if task.user_id != user_id && !is_approved_member(mysql, task_id, user_id).await? {
        anyhow::bail!(TaskNotFound);
    }

    // `convert_to_task_dict`: workspace-by-ref, teamRef resolution, then
    // `userReader.get_by_id` through the public direct SQL reader.
    let task_json = &task.json;
    let task_crd = CrdDocument::project(task_json);
    let typed_spec = task_crd.spec.as_ref();
    let mut git_url = String::new();
    let mut git_repo = String::new();
    let mut git_repo_id = serde_json::value::to_raw_value(&0).unwrap();
    let mut git_domain = String::new();
    let mut branch_name = String::new();
    if let Some((name, namespace)) =
        typed_spec.and_then(|spec| reference_parts(&spec.workspace_ref))
    {
        let workspace = get_workspace_by_ref(mysql, task.user_id, &name, &namespace).await?;
        if let Some(repository) = workspace
            .as_ref()
            .and_then(|row| JsonProjection::<WorkspaceDocumentInput>::from_json(&row.json).value)
            .and_then(|document| document.spec)
            .and_then(|spec| spec.repository)
        {
            git_url = repository.git_url.unwrap_or_default();
            git_repo = repository.git_repo.unwrap_or_default();
            git_repo_id = repository.git_repo_id.raw_or(0);
            git_domain = repository.git_domain.unwrap_or_default();
            branch_name = repository.branch_name.unwrap_or_default();
        }
    }

    // `resolve_task_ref_team`: the CRD's teamRef with `user_id` set queries
    // the kinds table directly; otherwise the public reader resolves it.
    let mut resolved_team = None;
    if let Some(reference) = typed_spec.and_then(|spec| spec.team_ref.as_ref())
        && let Some((name, namespace)) = reference.nonempty_parts()
    {
        let owner = &reference.user_id;
        resolved_team =
            if owner.is_none() || owner.as_ref().is_some_and(crate::crd::NumericId::is_null) {
                kinds
                    .get_by_name_and_namespace(user_id, "Team", &namespace, &name)
                    .await
                    .map_err(|error| anyhow::anyhow!("{error:?}"))?
            } else {
                kinds
                    .get_team_by_owner(
                        owner
                            .as_ref()
                            .and_then(crate::crd::NumericId::json_integer)
                            .unwrap_or(0),
                        &namespace,
                        &name,
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!("{error:?}"))?
            };
    }

    // `userReader.get_by_id` (task owner) inside `convert_to_task_dict` and
    // again inside `get_task_detail` (requesting user); both use the public
    // direct SQL reader.
    let task_user = cached_user(state, task.user_id).await;
    let detail_user = cached_user(state, user_id).await;

    // Requested skills: raw task load with the owner filter, then label
    // parsing (`requestedSkillRefs`).
    let skills_task =
        get_task_by_id_with_owner(mysql, state.task_policy, task_id, task.user_id).await?;
    let requested_skills = requested_skills_from_labels(skills_task.as_ref());

    // Team detail: `kindReader.get_by_id`, `get_task_owner_id`, then
    // `_convert_to_team_dict`.
    let task_owner_id = get_accessible_task_owner(mysql, task_id).await?;
    let team_value = match (&resolved_team, task_owner_id) {
        (Some(team_record), Some(owner_id)) => {
            let team_detail = kinds
                .get_by_id("Team", team_record.id)
                .await
                .map_err(|error| anyhow::anyhow!("{error:?}"))?;
            match team_detail {
                Some(team) => Some(
                    build_team_response(state, &kinds, &team, owner_id)
                        .await
                        .map_err(|error| anyhow::anyhow!("{error:?}"))?,
                ),
                None => None,
            }
        }
        _ => None,
    };

    // Fork lineage: depth-0 `_lineage_task` (owner-filtered get_by_id),
    // then the owner-match guard and `list_by_task_ordered` + contexts.
    // Fork parents are followed only while the task JSON carries a `fork`
    // spec (the source walks `fork.sourceTaskId` chains).
    let mut lineage_task_ids = vec![task_id];
    for _ in 0..crate::task_routing::MAX_FORK_DEPTH {
        // `_lineage_task` for the current chain node: depth 0 resolves the
        // task itself, deeper nodes resolve the fork source task.
        let lineage_task = get_task_by_id_with_owner(
            mysql,
            state.task_policy,
            *lineage_task_ids.last().expect("nonempty"),
            task.user_id,
        )
        .await?;
        let Some(lineage_json) = lineage_task.map(|row| row.json) else {
            break;
        };
        let lineage = CrdDocument::project(&lineage_json);
        let Some(source_task_id) = lineage
            .spec
            .and_then(|spec| spec.fork)
            .and_then(|fork| fork.source_task_id)
        else {
            break;
        };
        lineage_task_ids.push(source_task_id);
    }

    let mut subtasks: Vec<SubtaskRow> = Vec::new();
    let mut inherited_task_ids: Vec<i64> = Vec::new();
    for (index, lineage_task_id) in lineage_task_ids.iter().enumerate() {
        // `list_by_task_ordered`'s `_owner_matches_task_id` guard applies
        // only to new-format ids; legacy ids fall straight through to the
        // model lookup inside `list_subtasks_by_task`.
        let guarded = (state.task_policy.is_scoped_id)(lineage_task_id.unsigned_abs())
            && owner_matches_task_id(mysql, *lineage_task_id, task.user_id).await?;
        if guarded || !(state.task_policy.is_scoped_id)(lineage_task_id.unsigned_abs()) {
            let rows =
                list_subtasks_by_task(mysql, state.task_policy, *lineage_task_id, task.user_id)
                    .await?;
            if index > 0 {
                inherited_task_ids.push(*lineage_task_id);
            }
            subtasks.extend(rows);
        }
    }

    // `_attach_contexts` runs inside each `list_by_task_ordered` call, on
    // every subtask of the lineage task — before `resolve_for_task` sorts
    // and keeps the last `limit` items. Loading before the slice preserves
    // that query shape.
    let contexts = list_contexts(
        mysql,
        &subtasks.iter().map(|row| row.id).collect::<Vec<_>>(),
    )
    .await?;

    // `resolve_for_task` sorts by (message_id, created_at, id) and keeps the
    // last `limit` items.
    subtasks.sort_by(|a, b| {
        a.message_id
            .cmp(&b.message_id)
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
    if subtasks.len() > 100 {
        subtasks.drain(..subtasks.len() - 100);
    }

    // `get_bots_for_subtasks`: bot ids through the public reader, then each
    // bot's model/shell refs (resolved with the bot owner's user id).
    // `all_bot_ids` is a Python `set`; small-int sets iterate in hash order
    // (`hash(int) == int`, table slot `id % table_size`), so the probe order
    // is the ascending id order for the small id sets this endpoint sees
    // (verified against the recorded `kind:v2:data:Bot:{id}` probe order).
    let mut bot_ids: Vec<i64> = Vec::new();
    for subtask in &subtasks {
        if let Some(ids) = subtask.bot_ids.project::<Vec<Option<i64>>>() {
            for id in ids.into_iter().flatten() {
                if !bot_ids.contains(&id) {
                    bot_ids.push(id);
                }
            }
        }
    }
    bot_ids.sort_unstable();
    let bots = kinds
        .get_by_ids("Bot", &bot_ids)
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let mut bot_summaries = Vec::new();
    // `model_cache` / `shell_type_cache`: per-call memoization keyed by
    // `(bot.user_id, namespace, name)`; a repeated ref resolves once.
    let mut model_cache: std::collections::HashMap<(i64, String, String), i64> =
        std::collections::HashMap::new();
    let mut shell_type_cache: std::collections::HashMap<(i64, String, String), String> =
        std::collections::HashMap::new();
    for bot in &bots {
        let bot_crd = CrdDocument::project(&bot.json.0);
        let bot_spec = bot_crd.spec.as_ref();
        // `get_bots_for_subtasks` (task_detail_helpers): the model lookup
        // only decides `bind_model_type` (public when the model row is
        // user_id 0); `agent_config` is always the bind_model pair, even
        // for custom-config models. Both refs resolve with the bot owner's
        // user id.
        let mut agent_config = SubtaskAgentConfig::default();
        if let Some((name, namespace)) = bot_spec
            .and_then(|spec| spec.model_ref.as_ref())
            .and_then(|reference| reference.nonempty_parts())
        {
            let key = (bot.user_id, namespace.clone(), name.clone());
            let model_user_id = match model_cache.get(&key) {
                Some(owner) => *owner,
                None => {
                    let model = kinds
                        .get_by_name_and_namespace(bot.user_id, "Model", &namespace, &name)
                        .await
                        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
                    let owner = model.as_ref().map_or(0, |model| model.user_id);
                    model_cache.insert(key, owner);
                    owner
                }
            };
            agent_config.bind_model = Some(name);
            agent_config.bind_model_type = Some(if model_user_id == 0 { "public" } else { "user" });
        }
        let mut shell_type = String::new();
        if let Some((name, namespace)) = bot_spec
            .and_then(|spec| spec.shell_ref.as_ref())
            .and_then(|reference| reference.nonempty_parts())
        {
            let key = (bot.user_id, namespace.clone(), name.clone());
            if let Some(cached) = shell_type_cache.get(&key) {
                shell_type = cached.clone();
            } else {
                let shell = kinds
                    .get_by_name_and_namespace(bot.user_id, "Shell", &namespace, &name)
                    .await
                    .map_err(|error| anyhow::anyhow!("{error:?}"))?;
                let resolved = shell
                    .as_ref()
                    .and_then(shell_type_of)
                    .unwrap_or_default()
                    .to_owned();
                shell_type_cache.insert(key, resolved.clone());
                shell_type = resolved;
            }
        }
        bot_summaries.push(SubtaskBotResponse {
            id: bot.id,
            user_id: bot.user_id,
            name: bot.name.clone(),
            shell_type,
            agent_config: serde_json::value::to_raw_value(&agent_config)
                .expect("agent config serializes"),
            is_active: bot.is_active != 0,
            created_at: iso_timestamp(bot.created_at),
            updated_at: iso_timestamp(bot.updated_at),
        });
    }

    let subtasks_value =
        subtask_responses(&subtasks, &contexts, &bot_summaries, &inherited_task_ids);

    // `add_group_chat_info_to_task`.
    let member_count = count_approved_members(mysql, task_id).await?;
    let mut is_group_chat = typed_spec
        .and_then(|spec| spec.is_group_chat)
        .unwrap_or(false);
    if !is_group_chat {
        is_group_chat = member_count > 0;
    }

    let _ = task_user;
    let mut outcome = task_detail_response(
        &task,
        user_id,
        TaskDetailParts {
            git_url,
            git_repo,
            git_repo_id,
            git_domain,
            branch_name,
            detail_user: detail_user.ok().flatten(),
            team_value,
            subtasks_value,
            requested_skills,
            member_count,
            is_group_chat,
        },
    );
    refresh_result_urls(state, &mut outcome.body).await?;
    Ok(outcome)
}

/// `refresh_extended_video_result_urls`: the registered video integration
/// rewrites the temporary playback URLs of the task-level result and of every
/// subtask result, in that order, before the response is serialized. Signing
/// failures leave the payloads unchanged (the source logs them); an error from
/// the integration is the source's uncaught refresh failure and fails the
/// request.
async fn refresh_result_urls(
    state: &AppState,
    body: &mut TaskDetailResponse,
) -> anyhow::Result<()> {
    let mut results: Vec<&mut Box<RawValue>> = Vec::with_capacity(body.subtasks.len() + 1);
    results.push(&mut body.result);
    for subtask in body.subtasks.iter_mut() {
        results.push(&mut subtask.result);
    }
    state
        .video_result_urls
        .refresh_result_urls(&state.attachment_http, &mut results)
        .await
}

struct TaskDetailParts {
    git_url: String,
    git_repo: String,
    git_repo_id: Box<RawValue>,
    git_domain: String,
    branch_name: String,
    detail_user: Option<CachedUserResponse>,
    team_value: Option<TeamResponse>,
    subtasks_value: Vec<SubtaskResponse>,
    requested_skills: Option<Vec<RequestedSkillRef>>,
    member_count: usize,
    is_group_chat: bool,
}

fn task_detail_response(task: &TaskRow, user_id: i64, parts: TaskDetailParts) -> TaskDetailOutcome {
    let TaskDetailParts {
        git_url,
        git_repo,
        git_repo_id,
        git_domain,
        branch_name,
        detail_user,
        team_value,
        subtasks_value,
        requested_skills,
        member_count,
        is_group_chat,
    } = parts;
    let task_json = &task.json;
    let task_crd = CrdDocument::project(task_json);
    let spec = task_crd.spec.as_ref();
    let status = task_crd.status.as_ref();
    let task_labels = task_crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref());

    TaskDetailOutcome {
        body: TaskDetailResponse {
            id: task.id,
            title: spec
                .map(|spec| spec.title.raw_or(()))
                .unwrap_or_else(raw_null),
            git_url,
            git_repo,
            git_repo_id,
            git_domain,
            branch_name,
            prompt: spec
                .map(|spec| spec.prompt.raw_or(()))
                .unwrap_or_else(raw_null),
            status: status
                .and_then(|status| status.status.as_deref())
                .unwrap_or("PENDING")
                .to_owned(),
            task_type: task_labels
                .and_then(|labels| labels.task_type.as_deref())
                .unwrap_or("chat")
                .to_owned(),
            project_id: task.project_id.unwrap_or(0),
            client_origin: task
                .client_origin
                .clone()
                .unwrap_or_else(|| "frontend".into()),
            progress: status
                .map(|status| status.progress.raw_or(0))
                .unwrap_or_else(|| serde_json::value::to_raw_value(&0).unwrap()),
            result: status
                .and_then(|status| status.result.as_ref())
                .map(|result| raw_json(&sanitize_client_payload(result.to_value())))
                .unwrap_or_else(raw_null),
            error_message: status
                .map(|status| status.error_message.raw_or(""))
                .unwrap_or_else(|| serde_json::value::to_raw_value("").unwrap()),
            created_at: status
                .map(|status| status.created_at.raw_or(()))
                .unwrap_or_else(raw_null),
            updated_at: status
                .map(|status| status.updated_at.raw_or(()))
                .unwrap_or_else(raw_null),
            completed_at: status
                .map(|status| status.completed_at.raw_or(()))
                .unwrap_or_else(raw_null),
            user: detail_user,
            team: team_value,
            subtasks: subtasks_value,
            model_id: task_labels
                .map(|labels| labels.model_id.raw_or(()))
                .unwrap_or_else(raw_null),
            force_override_bot_model_type: task_labels
                .map(|labels| labels.force_override_bot_model_type.raw_or(()))
                .unwrap_or_else(raw_null),
            model_options: task_labels
                .and_then(|labels| parse_model_options(&labels.model_options)),
            is_group_chat,
            is_group_owner: task.user_id == user_id,
            member_count: is_group_chat.then_some(member_count),
            app: status
                .map(|status| status.app.raw_or(()))
                .unwrap_or_else(raw_null),
            device_id: spec
                .map(|spec| spec.device_id.raw_or(()))
                .unwrap_or_else(raw_null),
            execution_workspace_source: execution_workspace_field(spec, true),
            execution_workspace_path: execution_workspace_field(spec, false),
            preserve_executor: task_labels
                .and_then(|labels| labels.preserve_executor.as_deref())
                .is_some_and(|value| value == "true"),
            requested_skills,
            external_knowledge_refs: {
                let values: Vec<serde_json::Map<String, serde_json::Value>> = task_json
                    .get("spec")
                    .and_then(|spec| spec.get("externalKnowledgeRefs"))
                    .and_then(Value::as_array)
                    .map(|refs| {
                        refs.iter()
                            .map(|reference| {
                                let mut object = reference.as_object().cloned().unwrap_or_default();
                                object.retain(|_, value| !value.is_null());
                                object
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                values
                    .iter()
                    .map(|object| raw_json(&serde_json::Value::Object(object.clone())))
                    .collect()
            },
        },
    }
}

/// `_get_model_selection_labels.model_options`.
fn parse_model_options(
    raw: &Option<OpaqueJson>,
) -> Option<std::collections::HashMap<String, String>> {
    let raw = raw.as_ref()?.project::<String>()?;
    let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, ModelOptionInput>>(&raw)
    else {
        return None;
    };
    let parsed: std::collections::HashMap<String, String> = map
        .into_iter()
        .filter_map(|(key, value)| value.into_string().map(|value| (key, value)))
        .collect();
    (!parsed.is_empty()).then_some(parsed)
}

/// `get_task_execution_workspace_source` / `_path`.
fn execution_workspace_field(spec: Option<&crate::crd::CrdSpec>, source: bool) -> Option<String> {
    let workspace = spec?.execution.as_ref()?.workspace.as_ref()?;
    let value = if source {
        &workspace.source
    } else {
        &workspace.path
    };
    value
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `get_requested_skills_from_task`: the `requestedSkillRefs` label parsed
/// and normalized to `{name, namespace, is_public}` objects.
fn requested_skills_from_labels(task: Option<&TaskRow>) -> Option<Vec<RequestedSkillRef>> {
    let task = CrdDocument::project(&task?.json);
    let raw = task
        .metadata
        .as_ref()?
        .labels
        .as_ref()?
        .requested_skill_refs
        .as_deref()?
        .to_owned();
    let refs = parse_requested_skill_refs(&raw, EmptyNamespace::Preserve);
    (!refs.is_empty()).then_some(refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_prompt_passes_through() {
        assert_eq!(
            extract_display_prompt(Some("hello")),
            Some("hello".to_owned())
        );
        assert_eq!(extract_display_prompt(None), None);
    }

    #[test]
    fn json_block_prompt_keeps_user_text() {
        let prompt = r#"[{"type":"text","text":"user message"},{"type":"text","text":"<system-reminder>now</system-reminder>"}]"#;
        assert_eq!(
            extract_display_prompt(Some(prompt)),
            Some("user message".to_owned())
        );
    }

    #[test]
    fn user_question_marker_extracts_question() {
        let prompt = "<attachment>x</attachment>\n\n[User Question]:\nreal question";
        assert_eq!(
            extract_display_prompt(Some(prompt)),
            Some("real question".to_owned())
        );
    }

    #[test]
    fn iso_timestamp_uses_t_separator_without_micros() {
        let ts = chrono::NaiveDateTime::parse_from_str("2026-09-06 20:58:06", "%Y-%m-%d %H:%M:%S")
            .unwrap();
        assert_eq!(iso_timestamp(ts), "2026-09-06T20:58:06");
    }

    #[test]
    fn sanitize_removes_private_url_keys() {
        let payload = json!({"polling_url": "http://x", "keep": 1, "nested": {"task_url": "y"}});
        assert_eq!(
            sanitize_client_payload(payload),
            json!({"keep": 1, "nested": {}})
        );
    }

    #[test]
    fn model_options_parses_object() {
        let raw =
            serde_json::from_value::<Option<OpaqueJson>>(Value::String(r#"{"a": "b"}"#.to_owned()))
                .unwrap();
        assert_eq!(
            serde_json::to_value(parse_model_options(&raw)).unwrap(),
            json!({"a": "b"})
        );
        assert_eq!(parse_model_options(&None), None);
    }

    #[test]
    fn shell_type_accepts_runtime_alias() {
        fn shell_with(spec: Value) -> Option<String> {
            let record = crate::remote_workspace_tree::kinds::KindRecord {
                id: 1,
                user_id: 0,
                kind: "Shell".to_owned(),
                name: "s".to_owned(),
                namespace: "default".to_owned(),
                json: brz_mysql::Json(spec),
                is_active: 1,
                created_at: chrono::NaiveDateTime::default(),
                updated_at: chrono::NaiveDateTime::default(),
            };
            shell_type_of(&record).map(str::to_owned)
        }
        assert_eq!(
            shell_with(json!({"spec": {"runtime": "ClaudeCode"}})),
            Some("ClaudeCode".to_owned())
        );
        assert_eq!(
            shell_with(json!({"spec": {"shellType": "Chat"}})),
            Some("Chat".to_owned())
        );
        assert_eq!(shell_with(json!({"spec": {}})), None);
    }
}
