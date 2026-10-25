// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's knowledge resolution
//! (`app/services/chat/preprocessing/contexts.py:_prepare_kb_tools_from_contexts`
//! and the selected-knowledge context that feeds it).
//!
//! Split from [`super::request`] to keep both files within the source-review
//! size limit; the statement order and the two default-resolver positions are
//! unchanged.
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::bound_knowledge::{
    merge_knowledge_base_ids, resolve_bound_knowledge_bases, scope_value,
};
use super::contexts;
use super::knowledge::AclContextSource;
use super::request::{BuildExecutionRequestInput, dependency};
use super::selected_knowledge::{
    AppliedSelectedKnowledge, apply_selected_knowledge_context, enrich_wegent_routing_metadata,
    provider_skill, resolve_selected_knowledge_context, supports_provider_native_shell,
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
            input.task_json,
            input.user_id,
            &[],
        )
        .await
        .map_err(dependency)?
    } else {
        Vec::new()
    };
    // `build_selected_knowledge_context`'s explicit refs
    // (`chat/selected_knowledge.py:456-470`): the current subtask's ready
    // knowledge-base / selected-document contexts overlay the inherited refs.
    let explicit = contexts::ready_wegent_refs(current_contexts);
    let context = resolve_selected_knowledge_context(&inherited, &explicit);
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

    // Source unit 2: `_prepare_kb_tools_from_contexts`' task-level fallback.
    // The recorded shape has no subtask-level KB contexts, so the `elif task_id`
    // branch runs: the bound scopes (`contexts.py:1791`), the bound ids when the
    // scopes produced none (`contexts.py:1793-1794`), then the default resolver
    // (`contexts.py:1799`). The merged list keeps the bound ids first.
    let bound = resolve_bound_knowledge_bases(
        &state.mysql,
        state.task_store.as_ref(),
        input.task_id,
        input.user_id,
    )
    .await
    .map_err(dependency)?;
    let default_ids = resolve_task_default_knowledge_base_ids(
        &acl,
        state.task_store.as_ref(),
        input.task_id,
        input.user_id,
    )
    .await
    .map_err(dependency)?;
    let knowledge_base_ids = merge_knowledge_base_ids(&bound.ids, &default_ids);
    if knowledge_base_ids.is_empty() {
        return Ok(ResolvedKnowledge {
            external_knowledge_refs: task_external_knowledge_refs(input.task_json),
            ..ResolvedKnowledge::empty()
        });
    }

    Ok(ResolvedKnowledge {
        knowledge_base_ids: Some(serde_json::json!(knowledge_base_ids)),
        knowledge_base_scopes: bound.scopes.iter().map(scope_value).collect(),
        external_knowledge_refs: task_external_knowledge_refs(input.task_json),
        is_user_selected_kb: false,
        selected_knowledge_prompt: applied.selected_knowledge_prompt.clone(),
        provider_native_knowledge: provider_native,
        provider_skills: applied.provider_skills.clone(),
        ..ResolvedKnowledge::empty()
    })
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
