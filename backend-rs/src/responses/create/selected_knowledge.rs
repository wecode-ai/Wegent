// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `shared/selected_knowledge.py` (`resolve_selected_knowledge_context`) and
//! the pure enrichment cores of `app/services/chat/selected_knowledge.py`
//! (`_merge_refs` / `_overlay_explicit_ref`, `_routing_summary`,
//! `_routing_topics`), plus `sanitize_prompt_text`
//! (`app/services/chat/preprocessing/kb_meta.py`) and
//! `derive_retrieval_capabilities`
//! (`app/services/knowledge/retrieval_capabilities.py`).
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use crate::sql_support::DecimalCount;

use super::knowledge_prompt::{
    SelectedKnowledgeContext, SelectedKnowledgeRef, SelectedKnowledgeResource,
};

/// `ROUTING_SUMMARY_MAX_LENGTH`.
pub const ROUTING_SUMMARY_MAX_LENGTH: usize = 200;
/// `ROUTING_TOPIC_MAX_LENGTH`.
pub const ROUTING_TOPIC_MAX_LENGTH: usize = 48;
/// `MAX_ROUTING_TOPICS`.
pub const MAX_ROUTING_TOPICS: usize = 5;

/// `db.query(Kind)`'s labeled full-entity projection, in SQLAlchemy column
/// order. Both `_build_wegent_refs_for_ids` and
/// `task_knowledge_base_service.get_knowledge_bases_by_ids` read the complete
/// mapped entity, so the dependency carries every direct output column.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `(provider, knowledge_base_id)`.
fn ref_key(reference: &SelectedKnowledgeRef) -> (String, String) {
    (
        reference.provider.clone(),
        reference.knowledge_base_id.clone(),
    )
}

/// `_merge_topics`: ordered dedup across the topic groups.
fn merge_topics(groups: &[&[String]]) -> Vec<String> {
    let mut seen = Vec::new();
    for group in groups {
        for topic in *group {
            if !seen.contains(topic) {
                seen.push(topic.clone());
            }
        }
    }
    seen
}

/// `_merge_resources`: ordered dedup by `(scope_type, resource_id)`.
fn merge_resources(
    groups: &[&[super::knowledge_prompt::SelectedKnowledgeResource]],
) -> Vec<super::knowledge_prompt::SelectedKnowledgeResource> {
    let mut keys: Vec<(String, Option<String>)> = Vec::new();
    let mut resources = Vec::new();
    for group in groups {
        for resource in *group {
            let key = (resource.scope_type.clone(), resource.resource_id.clone());
            if keys.contains(&key) {
                continue;
            }
            keys.push(key);
            resources.push(resource.clone());
        }
    }
    resources
}

/// `current or other` for the retrieval-capability dicts.
fn non_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(|map| !map.is_empty())
}

/// `_merge_refs`: keyed by `(provider, knowledge_base_id)`, first-seen order,
/// merging the resource lists and preferring the first non-empty metadata.
fn merge_refs(refs: &[SelectedKnowledgeRef]) -> Vec<SelectedKnowledgeRef> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut merged: HashMap<(String, String), SelectedKnowledgeRef> = HashMap::new();
    for reference in refs {
        let key = ref_key(reference);
        let Some(current) = merged.get(&key) else {
            order.push(key.clone());
            merged.insert(key, reference.clone());
            continue;
        };
        if current.resources.is_empty() {
            continue;
        }
        if reference.resources.is_empty() {
            merged.insert(key, reference.clone());
            continue;
        }
        let combined = SelectedKnowledgeRef {
            provider: current.provider.clone(),
            knowledge_base_id: current.knowledge_base_id.clone(),
            knowledge_base_name: current.knowledge_base_name.clone(),
            resources: merge_resources(&[&current.resources, &reference.resources]),
            routing_summary: current
                .routing_summary
                .clone()
                .or_else(|| reference.routing_summary.clone()),
            routing_topics: merge_topics(&[&current.routing_topics, &reference.routing_topics]),
            retrieval_capabilities: if non_empty_object(&current.retrieval_capabilities) {
                current.retrieval_capabilities.clone()
            } else {
                reference.retrieval_capabilities.clone()
            },
        };
        merged.insert(key, combined);
    }
    order
        .into_iter()
        .filter_map(|key| merged.remove(&key))
        .collect()
}

/// `_overlay_explicit_ref`: keep the task metadata while the explicit ref owns
/// the effective scope.
fn overlay_explicit_ref(
    task_ref: &SelectedKnowledgeRef,
    explicit_ref: &SelectedKnowledgeRef,
) -> SelectedKnowledgeRef {
    SelectedKnowledgeRef {
        provider: explicit_ref.provider.clone(),
        knowledge_base_id: explicit_ref.knowledge_base_id.clone(),
        knowledge_base_name: if explicit_ref.knowledge_base_name.is_empty() {
            task_ref.knowledge_base_name.clone()
        } else {
            explicit_ref.knowledge_base_name.clone()
        },
        resources: explicit_ref.resources.clone(),
        routing_summary: explicit_ref
            .routing_summary
            .clone()
            .or_else(|| task_ref.routing_summary.clone()),
        routing_topics: merge_topics(&[&explicit_ref.routing_topics, &task_ref.routing_topics]),
        retrieval_capabilities: if non_empty_object(&explicit_ref.retrieval_capabilities) {
            explicit_ref.retrieval_capabilities.clone()
        } else {
            task_ref.retrieval_capabilities.clone()
        },
    }
}

/// `resolve_selected_knowledge_context`: merge the task refs, letting this
/// turn's explicit refs override the same source.
pub fn resolve_selected_knowledge_context(
    task_refs: &[SelectedKnowledgeRef],
    explicit_refs: &[SelectedKnowledgeRef],
) -> SelectedKnowledgeContext {
    let mut merged = merge_refs(task_refs);
    let mut indexes: HashMap<(String, String), usize> = HashMap::new();
    for (index, reference) in merged.iter().enumerate() {
        indexes.insert(ref_key(reference), index);
    }
    let normalized_explicit = merge_refs(explicit_refs);
    for explicit_ref in &normalized_explicit {
        let key = ref_key(explicit_ref);
        match indexes.get(&key).copied() {
            None => {
                indexes.insert(key, merged.len());
                merged.push(explicit_ref.clone());
            }
            Some(index) => {
                merged[index] = overlay_explicit_ref(&merged[index], explicit_ref);
            }
        }
    }
    SelectedKnowledgeContext {
        evidence_required: !normalized_explicit.is_empty(),
        refs: merged,
    }
}

/// `sanitize_prompt_text`: replace the unsafe identifier characters, collapse
/// control/whitespace runs, then truncate to `max_len` characters and trim the
/// tail. An empty result falls back to `fallback`.
pub fn sanitize_prompt_text(value: &str, fallback: &str, max_len: usize) -> String {
    let translated: String = value
        .chars()
        .map(|character| {
            if "{}[]<>`%".contains(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cleaned: String = translated
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '\r' | '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return fallback.to_string();
    }
    collapsed
        .chars()
        .take(max_len)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// `derive_retrieval_capabilities`: the safe capability summary for a
/// `retrievalConfig`.
pub fn derive_retrieval_capabilities(retrieval_config: &Value) -> Value {
    let mode = retrieval_config
        .get("retrieval_mode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "vector" | "keyword" | "hybrid"));
    match mode {
        Some(mode) => serde_json::json!({
            "retrieval_mode": mode,
            "semantic_query": mode == "hybrid",
            "keywords": mode == "keyword" || mode == "hybrid",
            "phrases": mode == "keyword" || mode == "hybrid",
        }),
        None => serde_json::json!({
            "retrieval_mode": Value::Null,
            "semantic_query": false,
            "keywords": false,
            "phrases": false,
        }),
    }
}

/// `str(value)` for a JSON value (`Value::to_string` would re-quote a string).
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `if manual_summary:` — JSON truthiness.
fn truthy_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(false) => None,
        Value::String(text) if text.is_empty() => None,
        other => Some(text_of(other)),
    }
}

/// `_routing_summary`: the manual long summary, else the completed short
/// summary, else empty.
pub fn routing_summary(spec: &Value, summary: &Value) -> String {
    if let Some(manual) = summary.get("manual_long_summary").and_then(truthy_text) {
        return manual;
    }
    if spec.get("summaryEnabled") != Some(&Value::Bool(true))
        || summary.get("status").and_then(Value::as_str) != Some("completed")
    {
        return String::new();
    }
    summary
        .get("short_summary")
        .map(text_of)
        .unwrap_or_default()
}

/// `_routing_topics`: the summary topics, only when the summary is usable.
pub fn routing_topics(spec: &Value, summary: &Value) -> Vec<Value> {
    let manual = summary
        .get("manual_long_summary")
        .and_then(truthy_text)
        .is_some();
    let completed = spec.get("summaryEnabled") == Some(&Value::Bool(true))
        && summary.get("status").and_then(Value::as_str) == Some("completed");
    if !manual && !completed {
        return Vec::new();
    }
    summary
        .get("topics")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `_int_values`: positive ints from a list, ignoring booleans and unparseable
/// entries, deduplicated in first-seen order.
pub fn int_values(values: &Value) -> Vec<i64> {
    let Some(items) = values.as_array() else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for item in items {
        if item.is_boolean() {
            continue;
        }
        let normalized = match item {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse::<i64>().ok(),
            _ => None,
        };
        let Some(normalized) = normalized else {
            continue;
        };
        if normalized <= 0 || result.contains(&normalized) {
            continue;
        }
        result.push(normalized);
    }
    result
}

/// `_positive_int`.
pub fn positive_int(value: &Value) -> Option<i64> {
    int_values(&Value::Array(vec![value.clone()]))
        .first()
        .copied()
}

/// `_index_refs_by_integer_id`: `{id: ref}` for the ref dicts that carry a
/// positive integer `id`.
pub fn index_refs_by_integer_id(values: &Value) -> BTreeMap<i64, Value> {
    let mut result = BTreeMap::new();
    let Some(items) = values.as_array() else {
        return result;
    };
    for item in items {
        if !item.is_object() {
            continue;
        }
        let ids = int_values(&Value::Array(vec![
            item.get("id").cloned().unwrap_or(Value::Null),
        ]));
        if let Some(id) = ids.first() {
            result.insert(*id, item.clone());
        }
    }
    result
}

/// `KnowledgeBaseScope` (the request's `knowledge_base_scopes` entry).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnowledgeBaseScope {
    pub knowledge_base_id: i64,
    pub scope_restricted: bool,
    pub document_ids: Vec<i64>,
}

/// The request's `knowledge_base_scopes`, parsed from the raw JSON list.
pub fn parse_knowledge_base_scopes(values: &Value) -> Vec<KnowledgeBaseScope> {
    values
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = positive_int(&item.get("knowledge_base_id").cloned()?)?;
                    Some(KnowledgeBaseScope {
                        knowledge_base_id: id,
                        scope_restricted: item.get("scope_restricted") == Some(&Value::Bool(true)),
                        document_ids: int_values(
                            &item.get("document_ids").cloned().unwrap_or(Value::Null),
                        ),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `_resolve_wegent_scope`: `(scope_restricted, folder_ids, document_ids)`.
pub fn resolve_wegent_scope(
    kb_id: i64,
    persisted_scope: &Value,
    request_scopes: &[KnowledgeBaseScope],
    prefer_request_scope: bool,
) -> (bool, Vec<i64>, Vec<i64>) {
    if prefer_request_scope {
        for scope in request_scopes {
            if scope.knowledge_base_id != kb_id {
                continue;
            }
            return (
                scope.scope_restricted,
                Vec::new(),
                scope.document_ids.clone(),
            );
        }
    }
    (
        persisted_scope.get("scopeRestricted") == Some(&Value::Bool(true)),
        int_values(
            &persisted_scope
                .get("folderIds")
                .cloned()
                .unwrap_or(Value::Null),
        ),
        int_values(
            &persisted_scope
                .get("explicitDocumentIds")
                .cloned()
                .unwrap_or(Value::Null),
        ),
    )
}

/// `_build_wegent_refs_for_ids`: the `wegent` refs for `selected_ids`, with the
/// per-knowledge-base retrieval capabilities and (when restricted) the loaded
/// folder/document resources.
pub async fn build_wegent_refs_for_ids<M: brz_mysql::Mysql>(
    mysql: &M,
    task_json: &Value,
    selected_ids: &[i64],
    request_scopes: &[KnowledgeBaseScope],
    prefer_request_scope: bool,
) -> brz_mysql::MysqlResult<Vec<SelectedKnowledgeRef>> {
    let mut selected: Vec<i64> = Vec::new();
    for id in selected_ids {
        if *id > 0 && !selected.contains(id) {
            selected.push(*id);
        }
    }
    if selected.is_empty() {
        return Ok(Vec::new());
    }

    let specs = knowledge_base_specs_by_ids(mysql, &selected).await?;
    let spec = task_json.get("spec").cloned().unwrap_or(Value::Null);
    let kb_refs = index_refs_by_integer_id(
        &spec
            .get("knowledgeBaseRefs")
            .cloned()
            .unwrap_or(Value::Null),
    );
    let scope_refs = index_refs_by_integer_id(
        &spec
            .get("knowledgeBaseScopes")
            .cloned()
            .unwrap_or(Value::Null),
    );

    selected.sort();
    let mut result = Vec::new();
    for kb_id in selected {
        let scope = scope_refs.get(&kb_id).cloned().unwrap_or(Value::Null);
        let kb_name = scope
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                kb_refs
                    .get(&kb_id)
                    .and_then(|reference| reference.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
            .unwrap_or_else(|| kb_id.to_string());
        let (scope_restricted, folder_ids, document_ids) =
            resolve_wegent_scope(kb_id, &scope, request_scopes, prefer_request_scope);
        let retrieval_config = specs
            .get(&kb_id)
            .and_then(|spec| spec.get("retrievalConfig"))
            .cloned()
            .unwrap_or(Value::Null);
        let capabilities = derive_retrieval_capabilities(&retrieval_config);
        if !scope_restricted {
            result.push(SelectedKnowledgeRef {
                provider: "wegent".to_string(),
                knowledge_base_id: kb_id.to_string(),
                knowledge_base_name: kb_name,
                retrieval_capabilities: capabilities,
                ..Default::default()
            });
            continue;
        }
        if folder_ids.is_empty() && document_ids.is_empty() {
            continue;
        }
        let resources = load_wegent_resources(mysql, kb_id, &folder_ids, &document_ids).await?;
        result.push(SelectedKnowledgeRef {
            provider: "wegent".to_string(),
            knowledge_base_id: kb_id.to_string(),
            knowledge_base_name: kb_name,
            resources,
            retrieval_capabilities: capabilities,
            ..Default::default()
        });
    }
    Ok(result)
}

/// `db.query(Kind).filter(Kind.id.in_(ids))` → `{id: spec}`. The Source builds
/// the capabilities from the full mapped entity, so the recorded read is
/// `SELECT <Kind entity> FROM kinds WHERE kinds.id IN (263078)` with no
/// kind/is_active filter and integer-bound ids.
async fn knowledge_base_specs_by_ids<M: brz_mysql::Mysql>(
    mysql: &M,
    ids: &[i64],
) -> brz_mysql::MysqlResult<BTreeMap<i64, Value>> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        kinds_id: i64,
        kinds_json: brz_mysql::Json<Value>,
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id IN ({placeholders})"
            ),
            ids.to_vec(),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let spec = row.kinds_json.0.get("spec").cloned().unwrap_or(Value::Null);
            (row.kinds_id, spec)
        })
        .collect())
}

/// `_load_wegent_resources`: the selected folders then documents, each with its
/// resolved name (falling back to the id).
///
/// No recorded create case restricts a scope, so this path is unexercised; the
/// source's folder/document reads are ported for completeness.
async fn load_wegent_resources<M: brz_mysql::Mysql>(
    mysql: &M,
    kb_id: i64,
    folder_ids: &[i64],
    document_ids: &[i64],
) -> brz_mysql::MysqlResult<Vec<SelectedKnowledgeResource>> {
    let folders = resource_names(mysql, "knowledge_folders", kb_id, folder_ids).await?;
    let documents = resource_names(mysql, "knowledge_documents", kb_id, document_ids).await?;
    let mut resources = Vec::new();
    for folder_id in folder_ids {
        resources.push(SelectedKnowledgeResource {
            scope_type: "folder".to_string(),
            resource_id: Some(folder_id.to_string()),
            resource_name: Some(
                folders
                    .get(folder_id)
                    .cloned()
                    .unwrap_or_else(|| folder_id.to_string()),
            ),
            ..Default::default()
        });
    }
    for document_id in document_ids {
        resources.push(SelectedKnowledgeResource {
            scope_type: "document".to_string(),
            resource_id: Some(document_id.to_string()),
            resource_name: Some(
                documents
                    .get(document_id)
                    .cloned()
                    .unwrap_or_else(|| document_id.to_string()),
            ),
            ..Default::default()
        });
    }
    Ok(resources)
}

/// `{table}.id -> {table}.name` for the ids of one knowledge base.
async fn resource_names<M: brz_mysql::Mysql>(
    mysql: &M,
    table: &str,
    kb_id: i64,
    ids: &[i64],
) -> brz_mysql::MysqlResult<BTreeMap<i64, String>> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        id: i64,
        name: String,
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT {table}.id AS id, {table}.name AS name \nFROM {table} \n\
                 WHERE {table}.kind_id = ? AND {table}.id IN ({placeholders})"
            ),
            {
                let mut args = vec![kb_id.to_string()];
                args.extend(ids.iter().map(i64::to_string));
                args
            },
        )
        .await?;
    Ok(rows.into_iter().map(|row| (row.id, row.name)).collect())
}

/// `PROVIDER_SKILLS`: the provider → Skill mapping. Deployment registrations
/// (`register_provider_skill`) are a startup extension point the create flow
/// does not reach; the checked-in defaults are pinned here.
pub fn provider_skill(provider_id: &str) -> Option<&'static str> {
    match provider_id.trim().to_ascii_lowercase().as_str() {
        "wegent" => Some("wegent-knowledge"),
        "dingtalk" => Some("dingtalk-docs"),
        _ => None,
    }
}

/// `SUPPORTED_PROVIDER_NATIVE_SHELLS`.
pub fn supports_provider_native_shell(shell_type: &str) -> bool {
    matches!(shell_type, "Chat" | "Codex" | "ClaudeCode")
}

/// `_append_unique`.
pub fn append_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

/// The `apply_selected_knowledge_context` outcome: the prompt and the selected
/// provider Skills to activate.
#[derive(Debug, Default, Clone)]
pub struct AppliedSelectedKnowledge {
    pub selected_knowledge_prompt: String,
    pub provider_native_knowledge: bool,
    pub provider_skills: Vec<String>,
    /// `preload_skills` / `user_selected_skills` after the Skill appends.
    pub preload_skills: Vec<String>,
    pub user_selected_skills: Vec<String>,
}

/// `apply_selected_knowledge_context` (the reachable half): render the prompt,
/// append the provider Skills to `preload_skills`/`user_selected_skills`, and
/// leave `provider_native_knowledge` false — the flag only turns true inside
/// `activate_provider_native_knowledge` after the MCP-server validation passes.
///
/// Documented gaps (no recorded create case reaches them): the 503 capability
/// errors for a missing Skill or provider, and the `Codex`/`ClaudeCode`
/// MCP-name cross-check in `activate_provider_native_knowledge`; the recorded
/// case passes that check and flips the flag to `true` in
/// [`activate_provider_native_knowledge`].
pub fn apply_selected_knowledge_context(
    context: &SelectedKnowledgeContext,
    shell_type: &str,
    preload_skills: &[String],
    user_selected_skills: &[String],
) -> AppliedSelectedKnowledge {
    let mut applied = AppliedSelectedKnowledge {
        preload_skills: preload_skills.to_vec(),
        user_selected_skills: user_selected_skills.to_vec(),
        ..Default::default()
    };
    if context.refs.is_empty() || !supports_provider_native_shell(shell_type) {
        return applied;
    }
    let prompt = super::knowledge_prompt::render_selected_knowledge_prompt(context);
    if prompt.is_empty() {
        return applied;
    }
    applied.selected_knowledge_prompt = prompt;
    for reference in &context.refs {
        let Some(skill_name) = provider_skill(&reference.provider) else {
            continue;
        };
        if applied.provider_skills.iter().any(|s| s == skill_name) {
            continue;
        }
        applied.provider_skills.push(skill_name.to_string());
        append_unique(&mut applied.preload_skills, skill_name);
        append_unique(&mut applied.user_selected_skills, skill_name);
    }
    applied
}

/// The recorded `knowledge_documents` prompt-stat row (`get_document_prompt_stats`).
///
/// `count(...)` is `BIGINT`, but each `sum(CASE ...)` is `DECIMAL`
/// (`NEWDECIMAL` on the wire), so those two columns decode through
/// [`DecimalCount`]. They are `Option` fields because a `sum()` can be SQL
/// NULL; the derive reads them with `MysqlRow::get`, and
/// [`KbPromptStats::counts`] applies the source's `int(value or 0)`.
#[derive(Debug, Clone, Default, PartialEq, Eq, brz_mysql::FromMysqlRow)]
pub struct KbPromptStats {
    #[mysql(rename = "knowledge_documents_kind_id")]
    pub kind_id: i64,
    #[mysql(rename = "total_count")]
    pub total: Option<i64>,
    #[mysql(rename = "searchable_count")]
    pub searchable: Option<DecimalCount>,
    #[mysql(rename = "spreadsheet_count")]
    pub spreadsheet: Option<DecimalCount>,
}

impl KbPromptStats {
    /// `int(total_count or 0)` and friends.
    pub fn counts(&self) -> (i64, i64, i64) {
        (
            self.total.unwrap_or(0),
            DecimalCount::or_zero(self.searchable),
            DecimalCount::or_zero(self.spreadsheet),
        )
    }
}

/// `get_document_prompt_stats`: the per-KB document counts, keyed by `kind_id`.
/// The recorded statement is rendered verbatim for the queued cases.
pub async fn document_prompt_stats<M: brz_mysql::Mysql>(
    mysql: &M,
    knowledge_base_ids: &[i64],
) -> brz_mysql::MysqlResult<BTreeMap<i64, KbPromptStats>> {
    if knowledge_base_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let placeholders = vec!["?"; knowledge_base_ids.len()].join(", ");
    let rows: Vec<KbPromptStats> = mysql
        .fetch_all(
            &format!(
                "SELECT knowledge_documents.kind_id AS knowledge_documents_kind_id, \
                 count(knowledge_documents.id) AS total_count, \
                 sum(CASE WHEN (knowledge_documents.is_active = true) THEN 1 ELSE 0 END) \
                 AS searchable_count, \
                 sum(CASE WHEN (knowledge_documents.is_active = true AND \
                 lower(knowledge_documents.file_extension) IN ('csv', 'xls', 'xlsx')) \
                 THEN 1 ELSE 0 END) AS spreadsheet_count \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.kind_id IN ({placeholders}) \
                 GROUP BY knowledge_documents.kind_id"
            ),
            // `get_document_prompt_stats` takes `list[int]`: the Source binds
            // each id as an integer, so the target must not stringify them.
            knowledge_base_ids.to_vec(),
        )
        .await?;
    Ok(rows.into_iter().map(|row| (row.kind_id, row)).collect())
}

/// The source's inline `wegent` id comprehension, shared by
/// `_resolve_effective_wegent_access_mode` and `_enrich_wegent_routing_metadata`:
/// the context's positive `wegent` knowledge-base ids in ref order. It does not
/// deduplicate, because neither source list does.
pub fn wegent_knowledge_base_ids(context: &SelectedKnowledgeContext) -> Vec<i64> {
    context
        .refs
        .iter()
        .filter_map(|reference| {
            (reference.provider == "wegent")
                .then(|| positive_int(&Value::String(reference.knowledge_base_id.clone())))
                .flatten()
        })
        .collect()
}

/// `_resolve_effective_wegent_access_mode`: resolve tool exposure against every
/// effective internal source of the selected-knowledge context.
///
/// This is one of the create flow's two calls to
/// `get_knowledge_base_tool_access_mode_by_ids`; the other one is
/// `_prepare_kb_tools_from_contexts`' lookup over the task-level ids, and it
/// runs later. An empty `wegent` id list returns `full` before any read.
pub async fn resolve_effective_wegent_access_mode<R: brz_redis::Redis>(
    mysql: &brz_mysql::MysqlService,
    resolvers: &crate::permissions::EntityResolvers<R>,
    redis: Option<&R>,
    context: &SelectedKnowledgeContext,
    user_id: i64,
) -> brz_mysql::MysqlResult<String> {
    let knowledge_base_ids = wegent_knowledge_base_ids(context);
    Ok(
        super::kb_tool_access_mode::get_knowledge_base_tool_access_mode_by_ids(
            mysql,
            resolvers,
            redis,
            user_id,
            &knowledge_base_ids,
        )
        .await?
        .mode,
    )
}

/// `_filter_native_refs`: a restricted analyst keeps no `wegent` source, so
/// every `wegent` ref is dropped from the final context and only the
/// `evidence_required` flag survives.
pub fn filter_native_refs(
    context: SelectedKnowledgeContext,
    access_mode: &str,
) -> SelectedKnowledgeContext {
    if access_mode != super::kb_tool_access_mode::RESTRICTED_SEARCH_ONLY {
        return context;
    }
    SelectedKnowledgeContext {
        refs: context
            .refs
            .into_iter()
            .filter(|reference| reference.provider != "wegent")
            .collect(),
        evidence_required: context.evidence_required,
    }
}

/// `_enrich_wegent_routing_metadata`: the final `knowledge_base_name` /
/// `routing_summary` / `routing_topics` fill for the `wegent` refs, after the
/// effective range is resolved. The recorded case (`2834ba9c`) fills
/// `knowledge_base_name = "ns-a-Group"` (the KB spec's `name`), the short
/// summary (the recorded summary carries `manual_long_summary` absent +
/// `status = "completed"`), and the five recorded topics.
pub async fn enrich_wegent_routing_metadata<M: brz_mysql::Mysql>(
    mysql: &M,
    context: &SelectedKnowledgeContext,
) -> brz_mysql::MysqlResult<SelectedKnowledgeContext> {
    let wegent_ids = wegent_knowledge_base_ids(context);
    if wegent_ids.is_empty() {
        return Ok(context.clone());
    }

    // `task_knowledge_base_service.get_knowledge_bases_by_ids`.
    #[derive(brz_mysql::FromMysqlRow)]
    struct KbRow {
        kinds_id: i64,
        kinds_name: String,
        kinds_json: brz_mysql::Json<Value>,
    }
    let placeholders = vec!["?"; wegent_ids.len()].join(", ");
    let rows: Vec<KbRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id IN ({placeholders}) AND kinds.kind = 'KnowledgeBase' \
                 AND kinds.is_active = true"
            ),
            wegent_ids.clone(),
        )
        .await?;
    let knowledge_bases: BTreeMap<i64, (String, Value)> = rows
        .into_iter()
        .map(|row| {
            let spec = row.kinds_json.0.get("spec").cloned().unwrap_or(Value::Null);
            (row.kinds_id, (row.kinds_name, spec))
        })
        .collect();

    let mut enriched: Vec<SelectedKnowledgeRef> = Vec::with_capacity(context.refs.len());
    for reference in &context.refs {
        let Some(kb_id) = positive_int(&Value::String(reference.knowledge_base_id.clone())) else {
            enriched.push(reference.clone());
            continue;
        };
        let Some((kind_name, spec)) = knowledge_bases.get(&kb_id) else {
            enriched.push(reference.clone());
            continue;
        };
        if reference.provider != "wegent" {
            enriched.push(reference.clone());
            continue;
        }
        let summary = spec
            .get("summary")
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new()));
        let summary_text = routing_summary(spec, &summary);
        let summary_topics = routing_topics(spec, &summary);
        let mut routing_topic_values = Vec::new();
        for topic in summary_topics.iter().take(MAX_ROUTING_TOPICS) {
            let topic = match topic {
                Value::String(text) => sanitize_prompt_text(text, "", ROUTING_TOPIC_MAX_LENGTH),
                other => sanitize_prompt_text(&text_of(other), "", ROUTING_TOPIC_MAX_LENGTH),
            };
            if !topic.is_empty() {
                routing_topic_values.push(topic);
            }
        }
        let knowledge_base_name = match spec.get("name").and_then(Value::as_str) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => {
                if !kind_name.is_empty() {
                    kind_name.clone()
                } else {
                    reference.knowledge_base_name.clone()
                }
            }
        };
        let sanitized_summary = sanitize_prompt_text(&summary_text, "", ROUTING_SUMMARY_MAX_LENGTH);
        enriched.push(SelectedKnowledgeRef {
            knowledge_base_name,
            routing_summary: (!sanitized_summary.is_empty()).then_some(sanitized_summary),
            routing_topics: routing_topic_values,
            ..reference.clone()
        });
    }
    Ok(SelectedKnowledgeContext {
        refs: enriched,
        evidence_required: context.evidence_required,
    })
}

#[cfg(test)]
#[path = "selected_knowledge_tests.rs"]
mod tests;
