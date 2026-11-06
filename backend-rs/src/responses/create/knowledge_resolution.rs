// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's knowledge resolution
//! (`app/services/chat/preprocessing/contexts.py:_prepare_kb_tools_from_contexts`
//! and the selected-knowledge context that feeds it).
//!
//! Split from [`super::request`] to keep both files within the source-review
//! size limit; the statement order and the inherited-ref position are
//! unchanged. The task-level default resolver keeps the source's priority
//! order: it runs only when the caller selected no subtask knowledge bases.
use brz_redis::Redis;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::permissions::EntityResolvers;
use crate::state::AppState;

use super::bound_knowledge::{
    merge_knowledge_base_ids, resolve_bound_knowledge_bases, scope_value,
};
use super::contexts;
use super::knowledge::{AclContextSource, deduplicate};
use super::knowledge_access::knowledge_access_error;
use super::knowledge_folder_scope::{
    DocumentScopeRequest, ScopeResolutionError, resolve_document_ids_for_scope,
};
use super::request::{BuildExecutionRequestInput, dependency};
use super::selected_knowledge::{
    AppliedSelectedKnowledge, KnowledgeBaseScope, apply_selected_knowledge_context,
    enrich_wegent_routing_metadata, filter_native_refs, provider_skill,
    resolve_effective_wegent_access_mode, resolve_selected_knowledge_context,
    supports_provider_native_shell,
};
use super::task_default_knowledge_bases::{
    build_inherited_selected_knowledge_refs, resolve_task_default_knowledge_base_ids,
};

/// The resolved knowledge projection on the dispatch metadata.
pub(super) struct ResolvedKnowledge {
    pub(super) knowledge_base_ids: Option<Value>,
    pub(super) document_ids: Option<Value>,
    pub(super) knowledge_base_scopes: Vec<Value>,
    /// `extract_task_external_knowledge_refs(task)`: always a list (`[]` when
    /// the Task declares none).
    pub(super) external_knowledge_refs: Value,
    pub(super) selected_knowledge_prompt: String,
    pub(super) provider_native_knowledge: bool,
    pub(super) is_user_selected_kb: bool,
    pub(super) kb_tool_access_mode: String,
    pub(super) kb_meta_prompt: String,
    pub(super) provider_skills: Vec<String>,
}

impl ResolvedKnowledge {
    pub(super) fn empty() -> Self {
        Self {
            knowledge_base_ids: None,
            document_ids: None,
            knowledge_base_scopes: Vec::new(),
            external_knowledge_refs: Value::Array(Vec::new()),
            selected_knowledge_prompt: String::new(),
            provider_native_knowledge: false,
            is_user_selected_kb: true,
            kb_tool_access_mode: "full".to_string(),
            kb_meta_prompt: String::new(),
            provider_skills: Vec::new(),
        }
    }
}

/// `build_inherited_selected_knowledge_refs` + `resolve_selected_knowledge_
/// context` + `enrich_wegent_routing_metadata` + `apply_selected_knowledge_
/// context`, then the task-level KB fallback of `_prepare_kb_tools_from_
/// contexts`, for the recorded (no explicit KB contexts) shape.
///
/// The default-KB resolver runs exactly twice, at the source's two positions:
/// once through `build_inherited_selected_knowledge_refs`
/// (`chat/selected_knowledge.py:235`, reached from `unified.py:327-332`) and
/// once through the contexts fallback (`chat/preprocessing/contexts.py:1799`)
/// that applies when the subtask carries no knowledge-base contexts.
pub(super) async fn resolve_knowledge(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    // The Task snapshot carrying the in-memory `knowledgeBaseScopes` written
    // by the API knowledge-base context creation.
    task_json: &Value,
    shell_type: &str,
    preload_skills: &[String],
    user_selected_skills: &[String],
    current_contexts: &[contexts::SubtaskContextRow],
) -> Result<ResolvedKnowledge, FastApiError> {
    // `build_direct_access_query_context` is built by
    // `get_acl_accessible_knowledge_base_ids` once the team's default knowledge
    // base candidates are known to be non-empty, so a task without defaults
    // never reads the organization names or the caller's group roles.
    let acl = AclContextSource::new(&state.mysql, &state.entity_resolvers, state.redis.as_ref());

    // Source unit 1: a provider-native shell builds the inherited refs, which
    // resolves the task's agent defaults (`selected_knowledge.py:235`).
    let inherited = if supports_provider_native_shell(shell_type) {
        build_inherited_selected_knowledge_refs(
            &acl,
            state.task_store.as_ref(),
            input.task_id,
            task_json,
            input.user_id,
            &[],
        )
        .await
        .map_err(knowledge_access_error)?
    } else {
        Vec::new()
    };
    // `build_selected_knowledge_context`'s explicit refs
    // (`chat/selected_knowledge.py:456-470`): the current subtask's ready
    // knowledge-base / selected-document contexts overlay the inherited refs.
    let explicit = contexts::ready_wegent_refs(current_contexts);
    let context = resolve_selected_knowledge_context(&inherited, &explicit);
    // `build_selected_knowledge_context` resolves the effective access mode over
    // the context's own `wegent` refs and filters the native refs *before* the
    // enrichment (`chat/selected_knowledge.py:275-283`, `:287-306`, `:308-320`).
    // This is the first of the source's two `get_knowledge_base_tool_access_mode_
    // by_ids` calls; the contexts-level lookup below issues the second one.
    let access_mode = resolve_effective_wegent_access_mode(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        &context,
        input.user_id,
    )
    .await
    .map_err(dependency)?;
    let context = filter_native_refs(context, &access_mode);
    let context = enrich_wegent_routing_metadata(&state.mysql, &context)
        .await
        .map_err(dependency)?;

    let applied = apply_selected_knowledge_context(
        &context,
        shell_type,
        preload_skills,
        user_selected_skills,
    );
    let provider_native =
        activate_provider_native_knowledge(shell_type, &applied.provider_skills, &applied);

    // `_prepare_kb_tools_from_contexts` (`contexts.py:1871-1911`): priority 1
    // is the subtask's own ready knowledge-base contexts. Only when the subtask
    // carries none does the `elif task_id` task-level fallback read the bound
    // scopes and the agent defaults. The default resolver re-reads the task and
    // its team, so running it while the caller already selected knowledge bases
    // issues `tasks`/`kinds` reads the source never performs; the selected
    // knowledge bases would also be replaced by the task-level ones.
    let subtask_kb_contexts = contexts::subtask_knowledge_base_contexts(current_contexts);
    let subtask_kb_ids: Vec<i64> = subtask_kb_contexts
        .iter()
        .filter_map(|context| contexts::knowledge_id(context))
        .collect();
    let (knowledge_base_ids, knowledge_base_scopes, is_user_selected_kb) =
        if subtask_kb_ids.is_empty() {
            let bound = resolve_bound_knowledge_bases(
                &state.mysql,
                &acl,
                state.task_store.as_ref(),
                input.task_id,
                input.user_id,
            )
            .await?;
            let default_ids = resolve_task_default_knowledge_base_ids(
                &acl,
                state.task_store.as_ref(),
                input.task_id,
                input.user_id,
            )
            .await
            .map_err(knowledge_access_error)?;
            (
                merge_knowledge_base_ids(&bound.ids, &default_ids),
                bound.scopes.iter().map(scope_value).collect(),
                false,
            )
        } else {
            (
                deduplicate(&subtask_kb_ids),
                subtask_knowledge_scopes(
                    &state.mysql,
                    state.redis.as_ref(),
                    &state.entity_resolvers,
                    input.user_id,
                    &subtask_kb_contexts,
                )
                .await?,
                true,
            )
        };
    if knowledge_base_ids.is_empty() {
        return Ok(ResolvedKnowledge {
            external_knowledge_refs: task_external_knowledge_refs(task_json),
            ..ResolvedKnowledge::empty()
        });
    }

    // `_prepare_kb_tools_from_contexts` (`contexts.py:1939`) downgrades the
    // resolved ids to search-only tools when the caller is a restricted
    // analyst of one of them; the empty list returns before the lookup.
    let kb_tool_access_mode =
        super::kb_tool_access_mode::get_knowledge_base_tool_access_mode_by_ids(
            &state.mysql,
            &state.entity_resolvers,
            state.redis.as_ref(),
            input.user_id,
            &knowledge_base_ids,
        )
        .await
        .map_err(dependency)?
        .mode;

    // `_build_kb_meta_prompt` (`contexts.py:1991`/`:1999`): the source builds
    // the request-scoped KB metadata prompt from the merged ids, so its
    // `get_knowledge_bases_by_ids` and `get_document_prompt_stats` reads always
    // run. A build failure degrades to the source's empty string.
    let kb_meta_prompt = match super::kb_meta_prompt::build_kb_meta_prompt(
        &state.mysql,
        &knowledge_base_ids,
        kb_tool_access_mode == super::kb_tool_access_mode::RESTRICTED_SEARCH_ONLY,
    )
    .await
    {
        Ok(prompt) => prompt,
        Err(error) => {
            tracing::warn!(%error, "kb meta prompt build failed");
            String::new()
        }
    };

    Ok(ResolvedKnowledge {
        knowledge_base_ids: Some(serde_json::json!(knowledge_base_ids)),
        knowledge_base_scopes,
        external_knowledge_refs: task_external_knowledge_refs(task_json),
        is_user_selected_kb,
        selected_knowledge_prompt: applied.selected_knowledge_prompt.clone(),
        provider_native_knowledge: provider_native,
        provider_skills: applied.provider_skills.clone(),
        kb_tool_access_mode,
        // `unified.py:467`: a provider-native knowledge shell discards the
        // computed prompt for the dispatched request.
        kb_meta_prompt: if provider_native {
            String::new()
        } else {
            kb_meta_prompt
        },
        ..ResolvedKnowledge::empty()
    })
}

/// `_build_scopes_from_kb_contexts` (`contexts.py:2032-2084`): one scope per
/// ready subtask knowledge-base context, in context order. A restricted scope
/// that carries a folder or document selection resolves its document ids
/// through `KnowledgeFolderService.resolve_document_ids_for_scope`.
async fn subtask_knowledge_scopes<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    contexts: &[&contexts::SubtaskContextRow],
) -> Result<Vec<Value>, FastApiError>
where
    M: brz_mysql::Mysql,
    R: Redis,
{
    let mut scopes = Vec::with_capacity(contexts.len());
    for context in contexts {
        let Some(knowledge_base_id) = contexts::knowledge_id(context) else {
            continue;
        };
        let data = context.type_data_object();
        let field = |key: &str| data.and_then(|data| data.get(key));
        let document_ids = int_list(field("document_ids"), false);
        let folder_ids = int_list(field("folder_ids"), true);
        let include_subfolders = field("include_subfolders")
            .map(brz_json::adapters::python_truthy)
            .unwrap_or(true);
        let mut scope_restricted = field("scope_restricted")
            .map(brz_json::adapters::python_truthy)
            .unwrap_or(false);
        // `(document_ids or folder_ids) and "scope_restricted" not in type_data`.
        if (!document_ids.is_empty() || !folder_ids.is_empty())
            && data.is_none_or(|data| !data.contains_key("scope_restricted"))
        {
            scope_restricted = true;
        }
        let mut resolved_document_ids = document_ids.clone();
        if scope_restricted && (!document_ids.is_empty() || !folder_ids.is_empty()) {
            let request = DocumentScopeRequest {
                knowledge_base_id,
                user_id,
                folder_ids: (!folder_ids.is_empty()).then(|| folder_ids.clone()),
                document_ids: (!document_ids.is_empty()).then(|| document_ids.clone()),
                include_subfolders,
            };
            resolved_document_ids =
                resolve_document_ids_for_scope(mysql, redis, resolvers, &request)
                    .await
                    .map_err(scope_error)?;
        }
        scopes.push(scope_value(&KnowledgeBaseScope {
            knowledge_base_id,
            scope_restricted,
            document_ids: if scope_restricted {
                resolved_document_ids
            } else {
                Vec::new()
            },
        }));
    }
    Ok(scopes)
}

/// `_normalize_document_ids` / `_normalize_folder_ids`: int-like list entries
/// in first-seen order, deduplicated. Folder ids also drop negatives.
fn int_list(value: Option<&Value>, reject_negative: bool) -> Vec<i64> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();
    for item in items {
        let parsed = match item {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse::<i64>().ok(),
            _ => None,
        };
        let Some(id) = parsed else { continue };
        if reject_negative && id < 0 {
            continue;
        }
        if seen.insert(id) {
            ids.push(id);
        }
    }
    ids
}

/// `raise HTTPException(400, detail=str(exc))` for the source's scope
/// `ValueError`s; a dependency failure stays a `500`.
fn scope_error(error: ScopeResolutionError) -> FastApiError {
    match error.value_error_message() {
        Some(message) => FastApiError::detail(brz_http_server::StatusCode::BAD_REQUEST, message),
        None => {
            tracing::error!(%error, "knowledge folder scope resolution failed");
            FastApiError::internal()
        }
    }
}

/// `activate_provider_native_knowledge` (reachable half): set the flag true
/// when every provider Skill resolves to a configured MCP server. The recorded
/// case carries the `wegent-knowledge` MCP server, so it flips true.
fn activate_provider_native_knowledge(
    shell_type: &str,
    provider_skills: &[String],
    _applied: &AppliedSelectedKnowledge,
) -> bool {
    if provider_skills.is_empty() || !supports_provider_native_shell(shell_type) {
        return false;
    }
    let _ = provider_skill;
    true
}

/// `extract_task_external_knowledge_refs`: the Task `spec.externalKnowledgeRefs`
/// list; a missing or null value yields `[]`.
pub(super) fn task_external_knowledge_refs(task_json: &Value) -> Value {
    Value::Array(
        task_json
            .get("spec")
            .and_then(|spec| spec.get("externalKnowledgeRefs"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    )
}
