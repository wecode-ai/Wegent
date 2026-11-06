// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `build_execution_request`'s API-request knowledge-base contexts
//! (`app/services/chat/trigger/unified.py:266-306`,
//! `app/services/openapi/kb_context.py:80-159`).
//!
//! The OpenAPI request's `knowledge_base` tools are resolved against the
//! caller's accessible knowledge bases, then one ready `knowledge_base`
//! `subtask_contexts` row per resolved knowledge base is inserted for the user
//! subtask before `current_contexts` is loaded. The source resolves through
//! `KnowledgeService.get_all_knowledge_bases_grouped`, adds every context in
//! the request order, and commits that batch (`kb_context.py:93-109`).
use std::collections::HashMap;

use brz_mysql::{Json, MysqlTransaction};
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::knowledge_bases_all_grouped::all_grouped;
use crate::state::AppState;

use super::knowledge_folder_scope::{
    DocumentScopeRequest, ScopeResolutionError, resolve_document_ids_for_scope,
};
use super::schema::KbToolRef;

/// `_create_kb_context`'s `SubtaskContext` insert (`kb_context.py:132-159`,
/// recorded as one `COM_QUERY` per resolved knowledge base). The variable
/// values stay bound; the source's literals keep their recorded shape.
pub(super) const INSERT_CONTEXT: &str = "INSERT INTO subtask_contexts \
    (subtask_id, user_id, context_type, name, status, error_message, binary_data, \
     image_base64, extracted_text, text_length, type_data, created_at, updated_at) \
    VALUES (?, ?, 'knowledge_base', ?, 'ready', '', X'', '', '', 0, ?, now(), now())";

/// `db.refresh(ctx)` (`kb_context.py:102`): the unlabeled row re-read by id.
pub(super) const REFRESH_CONTEXT: &str = "SELECT subtask_contexts.id, \
    subtask_contexts.subtask_id, subtask_contexts.user_id, \
    subtask_contexts.context_type, subtask_contexts.name, subtask_contexts.status, \
    subtask_contexts.error_message, subtask_contexts.binary_data, \
    subtask_contexts.image_base64, subtask_contexts.extracted_text, \
    subtask_contexts.text_length, subtask_contexts.type_data, \
    subtask_contexts.created_at, subtask_contexts.updated_at \nFROM subtask_contexts \n\
    WHERE subtask_contexts.id = ?";

/// One `ResolvedKnowledgeBase` (`openapi/kb_resolver.py:26-38`).
pub(super) struct ResolvedKb {
    pub(super) kb_id: i64,
    pub(super) namespace: String,
    pub(super) name: String,
    pub(super) scope_restricted: bool,
    pub(super) folder_ids: Option<Vec<i64>>,
    pub(super) explicit_document_ids: Option<Vec<i64>>,
    pub(super) include_subfolders: bool,
    pub(super) resolved_document_ids: Vec<i64>,
}

/// `build_execution_request`'s ref selection (`unified.py:277-279`):
/// `knowledge_base_refs`, else the legacy `knowledge_base_names`.
pub(super) fn normalized_refs<'a>(
    refs: &'a [KbToolRef],
    names: &'a [KbToolRef],
) -> &'a [KbToolRef] {
    if refs.is_empty() { names } else { refs }
}

/// `KnowledgeBaseContextCreator.create_contexts` (`kb_context.py:80-109`):
/// resolve the refs, insert the ready contexts in one committed transaction,
/// then refresh their ids. Returns the resolved refs so the caller can apply
/// Source's in-memory Task spec update.
pub(super) async fn create_api_kb_contexts(
    state: &AppState,
    subtask_id: i64,
    user_id: i64,
    refs: &[KbToolRef],
) -> Result<Vec<ResolvedKb>, FastApiError> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let resolved = resolve_refs(state, user_id, refs).await?;
    if resolved.is_empty() {
        return Ok(Vec::new());
    }
    // `db.add_all(contexts); db.commit()` (`kb_context.py:98-101`): the whole
    // batch is one transaction ending in COMMIT.
    let inserted_ids = state
        .mysql
        .with_transaction(async |transaction| {
            let mut ids = Vec::with_capacity(resolved.len());
            for knowledge_base in &resolved {
                let execution = transaction
                    .execute(
                        INSERT_CONTEXT,
                        (
                            subtask_id,
                            user_id,
                            knowledge_base.name.as_str(),
                            Json(type_data(knowledge_base)),
                        ),
                    )
                    .await?;
                ids.push(execution.last_insert_id as i64);
            }
            Ok(ids)
        })
        .await
        .map_err(super::request::dependency)?;
    // `for ctx in contexts: self.db.refresh(ctx)` (`kb_context.py:102-103`):
    // one by-id re-read per inserted row.
    for id in inserted_ids {
        let _: Option<brz_mysql::MysqlRow> = state
            .mysql
            .fetch_optional(REFRESH_CONTEXT, (id,))
            .await
            .map_err(super::request::dependency)?;
    }
    // `_sync_resolved_refs_to_task` (`kb_context.py:110-159`): each
    // unrestricted ref runs `sync_subtask_kb_to_task`'s access read path. The
    // recorded transactions carry no Task UPDATE — the builder session holds a
    // foreign-session Task object, so nothing flushes — so only the reads are
    // reproduced.
    for knowledge_base in &resolved {
        if knowledge_base.scope_restricted {
            continue;
        }
        sync_kb_access_reads(state, knowledge_base.kb_id, user_id).await;
    }
    Ok(resolved)
}

/// Source's `build_execution_request` hands the **same in-memory Task object**
/// to the later selected-knowledge construction: `_sync_resolved_refs_to_task`
/// -> `_replace_task_scope_refs` (`kb_context.py:194-228`) rewrites
/// `task.json.spec.knowledgeBaseScopes` in memory before
/// `build_inherited_selected_knowledge_refs` reads it
/// (`selected_knowledge.py:225-242`). The builder Session cannot flush the
/// caller's Task row, so the DB keeps the old value (`null`); the snapshot must
/// still carry the new scopes.
pub(super) fn apply_task_scope_refs(
    task_json: &mut Value,
    resolved: &[ResolvedKb],
    user_name: &str,
) {
    let bound_at = chrono::Utc::now().to_rfc3339();
    let scopes: Vec<Value> = resolved
        .iter()
        .map(|knowledge_base| {
            json!({
                "id": knowledge_base.kb_id,
                "namespace": knowledge_base.namespace,
                "name": knowledge_base.name,
                "scopeRestricted": knowledge_base.scope_restricted,
                "folderIds": knowledge_base.folder_ids,
                "explicitDocumentIds": knowledge_base.explicit_document_ids,
                "includeSubfolders": knowledge_base.include_subfolders,
                "boundBy": user_name,
                "boundAt": bound_at,
            })
        })
        .collect();
    if !task_json.is_object() {
        *task_json = Value::Object(serde_json::Map::new());
    }
    let spec = task_json
        .as_object_mut()
        .expect("object")
        .entry("spec")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !spec.is_object() {
        *spec = Value::Object(serde_json::Map::new());
    }
    spec.as_object_mut()
        .expect("object")
        .insert("knowledgeBaseScopes".to_string(), Value::Array(scopes));
}

/// `build_execution_request`'s context-creation step for one request: persist
/// the API knowledge-base contexts, then return the Task snapshot carrying the
/// in-memory scope refs the later selected-knowledge construction reads.
pub(super) async fn persist_request_kb_contexts(
    state: &AppState,
    input: &super::request::BuildExecutionRequestInput<'_>,
    refs: &[KbToolRef],
) -> Result<Value, FastApiError> {
    let mut task_json = input.task_json.clone();
    if refs.is_empty() {
        return Ok(task_json);
    }
    let subtask_id = if input.user_subtask_id > 0 {
        input.user_subtask_id
    } else {
        input.assistant_subtask_id
    };
    let resolved = create_api_kb_contexts(state, subtask_id, input.user_id, refs).await?;
    if !resolved.is_empty() {
        apply_task_scope_refs(&mut task_json, &resolved, input.user_name);
    }
    Ok(task_json)
}

/// `sync_subtask_kb_to_task`'s KB read, then
/// `knowledge_share_service._get_resource` (the share service re-reads the KB
/// before `resolve_knowledge_base_permission` and
/// `meets_direct_access_requirement`). The Source wraps the whole sync in a
/// `try/except` that logs and skips, so a failure never reaches the request.
async fn sync_kb_access_reads(state: &AppState, knowledge_base_id: i64, user_id: i64) {
    let record = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        knowledge_base_id,
    )
    .await;
    let Ok(Some(_record)) = record else {
        return;
    };
    let share = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        knowledge_base_id,
    )
    .await;
    let Ok(Some(share_kb)) = share else {
        return;
    };
    if let Err(error) = crate::knowledge_documents_content::access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &share_kb,
        user_id,
    )
    .await
    {
        tracing::warn!(
            detail = error.detail(),
            knowledge_base_id,
            "kb sync access read failed"
        );
    }
}

/// `_create_kb_context`'s `type_data` (`kb_context.py:132-159`): the knowledge
/// id, a null document count, and the scope flags.
fn type_data(knowledge_base: &ResolvedKb) -> Value {
    let mut data = serde_json::Map::new();
    data.insert("knowledge_id".to_string(), json!(knowledge_base.kb_id));
    data.insert("document_count".to_string(), Value::Null);
    data.insert(
        "scope_restricted".to_string(),
        json!(knowledge_base.scope_restricted),
    );
    if knowledge_base.scope_restricted {
        data.insert(
            "document_ids".to_string(),
            json!(knowledge_base.resolved_document_ids),
        );
        data.insert("folder_ids".to_string(), json!(knowledge_base.folder_ids));
        data.insert(
            "explicit_document_ids".to_string(),
            json!(knowledge_base.explicit_document_ids),
        );
        data.insert(
            "include_subfolders".to_string(),
            json!(knowledge_base.include_subfolders),
        );
    }
    Value::Object(data)
}

/// `KnowledgeBaseNameResolver.resolve` (`openapi/kb_resolver.py:120-233`): the
/// caller's accessible lookup, then a match per request ref, then the
/// restricted-scope document resolution.
async fn resolve_refs(
    state: &AppState,
    user_id: i64,
    refs: &[KbToolRef],
) -> Result<Vec<ResolvedKb>, FastApiError> {
    let grouped = all_grouped(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user_id,
        "",
    )
    .await
    .map_err(super::request::dependency)?;
    let mut lookup: HashMap<(String, String), i64> = HashMap::new();
    for (id, namespace, name) in grouped.accessible_knowledge_bases() {
        lookup.insert((namespace, name), id);
    }

    let mut resolved = Vec::with_capacity(refs.len());
    let mut no_access: Vec<String> = Vec::new();
    for reference in refs {
        let key = (reference.namespace.clone(), reference.name.clone());
        let Some(kb_id) = lookup.get(&key) else {
            no_access.push(format!("{}#{}", reference.namespace, reference.name));
            continue;
        };
        resolved.push(ResolvedKb {
            kb_id: *kb_id,
            namespace: reference.namespace.clone(),
            name: reference.name.clone(),
            scope_restricted: reference.scope_specified,
            folder_ids: reference.folder_ids.clone(),
            explicit_document_ids: reference.document_ids.clone(),
            include_subfolders: reference.include_subfolders,
            resolved_document_ids: Vec::new(),
        });
    }
    if !no_access.is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::FORBIDDEN,
            format!(
                "Access denied to knowledge base(s): {}",
                no_access.join(", ")
            ),
        ));
    }

    for knowledge_base in &mut resolved {
        if !knowledge_base.scope_restricted {
            continue;
        }
        let request = DocumentScopeRequest {
            knowledge_base_id: knowledge_base.kb_id,
            user_id,
            folder_ids: knowledge_base
                .folder_ids
                .clone()
                .filter(|ids| !ids.is_empty()),
            document_ids: knowledge_base
                .explicit_document_ids
                .clone()
                .filter(|ids| !ids.is_empty()),
            include_subfolders: knowledge_base.include_subfolders,
        };
        knowledge_base.resolved_document_ids = resolve_document_ids_for_scope(
            &state.mysql,
            state.redis.as_ref(),
            &state.entity_resolvers,
            &request,
        )
        .await
        .map_err(scope_error)?;
    }
    Ok(resolved)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn refs(namespace: &str, name: &str) -> KbToolRef {
        KbToolRef {
            namespace: namespace.to_string(),
            name: name.to_string(),
            folder_ids: None,
            document_ids: None,
            include_subfolders: true,
            scope_specified: false,
        }
    }

    /// `build_execution_request` prefers `knowledge_base_refs` and falls back
    /// to the legacy `knowledge_base_names` only when refs are empty.
    #[test]
    fn normalized_refs_use_the_name_fallback_only_without_refs() {
        let names = vec![refs("engineering/platform", "业务逻辑知识库")];
        assert_eq!(normalized_refs(&[], &names), names.as_slice());

        let explicit = vec![refs("engineering/platform", "预案知识库")];
        assert_eq!(normalized_refs(&explicit, &names), explicit.as_slice());
    }

    /// `_create_kb_context`'s insert carries the recorded columns and the
    /// variable values stay bound (`kb_context.py:132-159`).
    #[test]
    fn the_context_insert_matches_the_recorded_shape() {
        let sql = INSERT_CONTEXT
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(sql.contains(
            "INSERT INTO subtask_contexts (subtask_id, user_id, context_type, name, status, \
             error_message, binary_data, image_base64, extracted_text, text_length, type_data, \
             created_at, updated_at)"
        ));
        assert!(sql.contains(
            "VALUES (?, ?, 'knowledge_base', ?, 'ready', '', X'', '', '', 0, ?, now(), now())"
        ));
        assert!(!sql.contains("LIMIT"));

        // `db.refresh(ctx)`: the unlabeled row re-read by id.
        let refresh = REFRESH_CONTEXT
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(refresh.starts_with("SELECT subtask_contexts.id, subtask_contexts.subtask_id,"));
        assert!(refresh.ends_with("WHERE subtask_contexts.id = ?"));
        assert!(!refresh.contains("AS subtask_contexts_id"));
    }

    /// `type_data` is `{knowledge_id, document_count: null, scope_restricted}`
    /// and gains the scope fields only when restricted.
    #[test]
    fn type_data_follows_the_source_document() {
        let unrestricted = type_data(&ResolvedKb {
            kb_id: 157464,
            namespace: "default".to_string(),
            name: "业务逻辑知识库".to_string(),
            scope_restricted: false,
            folder_ids: None,
            explicit_document_ids: None,
            include_subfolders: true,
            resolved_document_ids: Vec::new(),
        });
        assert_eq!(
            unrestricted,
            json!({
                "knowledge_id": 157464,
                "document_count": null,
                "scope_restricted": false,
            })
        );

        let restricted = type_data(&ResolvedKb {
            kb_id: 7,
            namespace: "default".to_string(),
            name: "kb".to_string(),
            scope_restricted: true,
            folder_ids: Some(vec![3]),
            explicit_document_ids: Some(vec![9]),
            include_subfolders: false,
            resolved_document_ids: vec![9, 11],
        });
        assert_eq!(restricted["document_ids"], json!([9, 11]));
        assert_eq!(restricted["folder_ids"], json!([3]));
        assert_eq!(restricted["explicit_document_ids"], json!([9]));
        assert_eq!(restricted["include_subfolders"], json!(false));
    }
}

#[cfg(test)]
mod task_scope_tests {
    use super::*;
    use crate::responses::create::selected_knowledge::index_refs_by_integer_id;

    fn kb(kb_id: i64, name: &str) -> ResolvedKb {
        ResolvedKb {
            kb_id,
            namespace: "engineering/platform".to_string(),
            name: name.to_string(),
            scope_restricted: false,
            folder_ids: None,
            explicit_document_ids: None,
            include_subfolders: true,
            resolved_document_ids: Vec::new(),
        }
    }

    /// `_replace_task_scope_refs` (`kb_context.py:194-228`): the in-memory Task
    /// spec gains the API-selected scopes, and the selected-knowledge builder
    /// reads their ids back (`selected_knowledge.py:225-242`).
    #[test]
    fn api_scopes_flow_into_the_inherited_selected_ids() {
        let mut task_json = json!({"spec": {"teamRef": {"name": "team"}}});
        apply_task_scope_refs(
            &mut task_json,
            &[kb(157464, "业务逻辑知识库"), kb(161644, "预案知识库")],
            "alice",
        );
        let scopes = task_json["spec"]["knowledgeBaseScopes"].clone();
        let ids: Vec<i64> = index_refs_by_integer_id(&scopes).keys().copied().collect();
        assert_eq!(ids, vec![157464, 161644]);
        assert_eq!(scopes[0]["namespace"], json!("engineering/platform"));
        assert_eq!(scopes[0]["name"], json!("业务逻辑知识库"));
        assert_eq!(scopes[0]["scopeRestricted"], json!(false));
        assert_eq!(scopes[0]["folderIds"], json!(null));
        assert_eq!(scopes[0]["explicitDocumentIds"], json!(null));
        assert_eq!(scopes[0]["includeSubfolders"], json!(true));
        assert_eq!(scopes[0]["boundBy"], json!("alice"));
        assert!(scopes[0]["boundAt"].as_str().is_some_and(|v| !v.is_empty()));
        // The previous spec keys survive.
        assert_eq!(task_json["spec"]["teamRef"]["name"], json!("team"));
    }

    /// An existing `knowledgeBaseScopes` value is replaced, and a malformed
    /// spec object is repaired, so the builders never see a partial snapshot.
    #[test]
    fn scope_application_replaces_and_repairs() {
        let mut task_json = json!({"spec": {"knowledgeBaseScopes": [{"id": 1}]}});
        apply_task_scope_refs(&mut task_json, &[kb(9, "kb")], "bob");
        let ids: Vec<i64> = index_refs_by_integer_id(&task_json["spec"]["knowledgeBaseScopes"])
            .keys()
            .copied()
            .collect();
        assert_eq!(ids, vec![9]);

        let mut primitive = json!("not-an-object");
        apply_task_scope_refs(&mut primitive, &[kb(3, "kb")], "bob");
        assert_eq!(primitive["spec"]["knowledgeBaseScopes"][0]["id"], json!(3));
    }
}
