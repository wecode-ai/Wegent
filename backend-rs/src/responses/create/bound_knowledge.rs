// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's task-level bound knowledge bases
//! (`app/services/chat/preprocessing/contexts.py:1788-1800`).
//!
//! `_prepare_kb_tools_from_contexts` resolves the task-level knowledge bases in
//! three steps when the request carries no subtask-level KB context:
//!
//! 1. `_get_bound_knowledge_base_scopes` reads the task with the
//!    regular-active predicate and resolves its `spec.knowledgeBaseScopes`
//!    against the caller's accessible knowledge bases.
//! 2. Only when those scopes produced no ids, `_get_bound_knowledge_base_ids`
//!    reads the task a second time, checks task membership through the task
//!    access store, and resolves `spec.knowledgeBaseRefs`.
//! 3. The default resolver runs afterwards, and the merged id list keeps the
//!    bound ids ahead of the defaults (`dict.fromkeys(bound + default)`).
//!
//! The membership check (`task_access_store.is_member`) reads the accessible
//! task row (`id + kind = 'Task' + is_active IN (1, 2)`), returns early for
//! that row's owner, and only otherwise probes `resource_members`.
//!
//! Known gap: the two branches that resolve persisted refs
//! (`KnowledgeBaseNameResolver.resolve` for `knowledgeBaseScopes` and
//! `resolve_kb_refs_batch` for `knowledgeBaseRefs`) need the accessible-KB
//! grouping and folder-scope subsystems, which this flow does not host yet.
//! A task without persisted KB refs — every recorded create case — never
//! reaches them.
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow};
use serde_json::Value;

use super::selected_knowledge::KnowledgeBaseScope;
use crate::internal_callback::completion::task_column;
use crate::task_store_traits::TaskStore;

/// The task-level bound knowledge bases of one request.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BoundKnowledgeBases {
    /// `knowledge_base_scopes` (`KnowledgeBaseScope` per resolved scope ref).
    pub scopes: Vec<KnowledgeBaseScope>,
    /// `bound_knowledge_base_ids`: the scope ids, or the bound refs' ids.
    pub ids: Vec<i64>,
}

/// `_prepare_kb_tools_from_contexts`' priority-2 KB resolution.
pub async fn resolve_bound_knowledge_bases<M: Mysql>(
    mysql: &M,
    store: &dyn TaskStore,
    task_id: i64,
    user_id: i64,
) -> MysqlResult<BoundKnowledgeBases> {
    let scopes = bound_knowledge_base_scopes(store, task_id).await?;
    // `bound_knowledge_base_ids = [scope ids] or _get_bound_knowledge_base_ids`:
    // the ids chain runs only when the scopes produced no ids.
    let ids = if scopes.is_empty() {
        bound_knowledge_base_ids(mysql, store, task_id, user_id).await?
    } else {
        scopes.iter().map(|scope| scope.knowledge_base_id).collect()
    };
    Ok(BoundKnowledgeBases { scopes, ids })
}

/// `_get_bound_knowledge_base_scopes`: the regular-active task read, then the
/// persisted scope refs resolved against the caller's accessible KBs.
async fn bound_knowledge_base_scopes(
    store: &dyn TaskStore,
    task_id: i64,
) -> MysqlResult<Vec<KnowledgeBaseScope>> {
    let Some(task) = store.get_regular_active_task(task_id).await? else {
        return Ok(Vec::new());
    };
    let task_json = task_json(&task);
    let refs = task_knowledge_base_scope_refs(&task_json);
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    // GAP: `KnowledgeBaseNameResolver.resolve` (accessible-KB grouping plus
    // folder/document scope resolution) is not part of this flow yet.
    tracing::warn!(
        task_id,
        refs = refs.len(),
        "bound knowledge-base scopes are not resolved in the create flow yet"
    );
    Ok(Vec::new())
}

/// `_get_bound_knowledge_base_ids`: the second regular-active task read, the
/// task access store's membership check, then the persisted KB refs.
async fn bound_knowledge_base_ids<M: Mysql>(
    mysql: &M,
    store: &dyn TaskStore,
    task_id: i64,
    user_id: i64,
) -> MysqlResult<Vec<i64>> {
    let Some(task) = store.get_regular_active_task(task_id).await? else {
        return Ok(Vec::new());
    };
    if !task_member(mysql, store, task_id, user_id).await? {
        return Ok(Vec::new());
    }
    let task_json = task_json(&task);
    let refs = task_knowledge_base_refs(&task_json);
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    // GAP: `resolve_kb_refs_batch` (the id/name batch lookup and its legacy
    // ref migration) is not part of this flow yet.
    tracing::warn!(
        task_id,
        refs = refs.len(),
        "bound knowledge-base refs are not resolved in the create flow yet"
    );
    Ok(Vec::new())
}

/// `task_access_store.is_member`: the accessible-task read, the owner
/// short-circuit, then the approved membership probe.
pub async fn task_member<M: Mysql>(
    mysql: &M,
    store: &dyn TaskStore,
    task_id: i64,
    user_id: i64,
) -> MysqlResult<bool> {
    let Some(task) = store.get_accessible_task(task_id).await? else {
        return Ok(false);
    };
    if task_column::<i64>(&task, "user_id") == Some(user_id) {
        return Ok(true);
    }
    let member: Option<MysqlRow> = mysql
        .fetch_optional(
            approved_membership_statement(),
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(member.is_some())
}

/// `_approved_membership_query(...).first()`: the approved membership row of
/// one user on one task.
pub fn approved_membership_statement() -> String {
    [
        "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n",
        "WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? ",
        "AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? ",
        "AND resource_members.status = 'approved' AND resource_members.copied_resource_id = 0 ",
        "\n LIMIT 1",
    ]
    .concat()
}

/// One normalized `spec.knowledgeBaseScopes` entry
/// (`get_task_knowledge_base_scope_refs`, `openapi/kb_context.py:231`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScopeRef {
    pub id: Option<i64>,
    pub namespace: String,
    pub name: String,
    pub folder_ids: Option<Vec<i64>>,
    pub document_ids: Option<Vec<i64>>,
    pub include_subfolders: bool,
    pub scope_specified: bool,
}

/// `get_task_knowledge_base_scope_refs(task)`: the task's persisted API scope
/// refs, normalized to the resolver's input shape.
pub fn task_knowledge_base_scope_refs(task_json: &Value) -> Vec<ScopeRef> {
    let Some(items) = task_json
        .get("spec")
        .and_then(|spec| spec.get("knowledgeBaseScopes"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            let id = item.get("id").and_then(int_value);
            if name.is_empty() && id.is_none() {
                return None;
            }
            Some(ScopeRef {
                id,
                namespace: item
                    .get("namespace")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string(),
                name: name.to_string(),
                folder_ids: int_list(item.get("folderIds")),
                document_ids: int_list(item.get("explicitDocumentIds")),
                include_subfolders: bool_value(item.get("includeSubfolders"), true),
                scope_specified: bool_value(item.get("scopeRestricted"), false),
            })
        })
        .collect()
}

/// `spec.knowledgeBaseRefs` as the raw ref list (`or []`).
pub fn task_knowledge_base_refs(task_json: &Value) -> Vec<Value> {
    match task_json
        .get("spec")
        .and_then(|spec| spec.get("knowledgeBaseRefs"))
    {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `list(dict.fromkeys(bound_ids + default_ids))`.
pub fn merge_knowledge_base_ids(bound: &[i64], defaults: &[i64]) -> Vec<i64> {
    let mut merged: Vec<i64> = Vec::with_capacity(bound.len() + defaults.len());
    for id in bound.iter().chain(defaults.iter()) {
        if !merged.contains(id) {
            merged.push(*id);
        }
    }
    merged
}

/// The request `knowledge_base_scopes` entry of one resolution.
pub fn scope_value(scope: &KnowledgeBaseScope) -> Value {
    serde_json::json!({
        "knowledge_base_id": scope.knowledge_base_id,
        "scope_restricted": scope.scope_restricted,
        "document_ids": scope.document_ids,
    })
}

/// The task row's JSON payload (`task.json` when it is a dict, else `{}`).
fn task_json(task: &MysqlRow) -> Value {
    match task_column::<Json<Value>>(task, "json") {
        Some(Json(Value::Object(map))) => Value::Object(map),
        _ => Value::Object(serde_json::Map::new()),
    }
}

/// `int(raw)` for a JSON number or a numeric string.
fn int_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// `raw.get(key)`: `None` when the key is absent or null, the parsed integer
/// list otherwise (empty lists are preserved).
fn int_list(value: Option<&Value>) -> Option<Vec<i64>> {
    match value? {
        Value::Null => None,
        Value::Array(items) => Some(items.iter().filter_map(int_value).collect()),
        _ => None,
    }
}

/// `bool(raw.get(key, default))`.
fn bool_value(value: Option<&Value>, default: bool) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Null) | None => default,
        Some(Value::Number(number)) => number.as_i64().is_some_and(|value| value != 0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scope_refs_match_the_normalized_source_shape() {
        let task_json = json!({
            "spec": {
                "knowledgeBaseScopes": [
                    {
                        "id": 239607,
                        "namespace": "team-a",
                        "name": "kb-1",
                        "folderIds": [0, 12],
                        "explicitDocumentIds": [7],
                        "includeSubfolders": false,
                        "scopeRestricted": true
                    },
                    {"name": "kb-2"},
                    {"namespace": "team-a"},
                    "not-an-object"
                ]
            }
        });
        let refs = task_knowledge_base_scope_refs(&task_json);
        assert_eq!(refs.len(), 2, "a ref without a name or id is skipped");
        assert_eq!(
            refs[0],
            ScopeRef {
                id: Some(239607),
                namespace: "team-a".to_string(),
                name: "kb-1".to_string(),
                folder_ids: Some(vec![0, 12]),
                document_ids: Some(vec![7]),
                include_subfolders: false,
                scope_specified: true,
            }
        );
        assert_eq!(refs[1].namespace, "default");
        assert!(!refs[1].scope_specified);
        assert!(refs[1].include_subfolders);
        assert_eq!(refs[1].folder_ids, None);
    }

    #[test]
    fn missing_or_null_scope_lists_read_as_empty() {
        for task_json in [
            json!(null),
            json!({}),
            json!({"spec": {}}),
            json!({"spec": {"knowledgeBaseScopes": null}}),
            json!({"spec": {"knowledgeBaseScopes": "oops"}}),
        ] {
            assert!(task_knowledge_base_scope_refs(&task_json).is_empty());
        }
    }

    #[test]
    fn knowledge_base_refs_read_the_spec_list() {
        let task_json = json!({"spec": {"knowledgeBaseRefs": [{"id": 5}, {"name": "kb"}]}});
        assert_eq!(task_knowledge_base_refs(&task_json).len(), 2);
        assert!(task_knowledge_base_refs(&json!({"spec": {"knowledgeBaseRefs": null}})).is_empty());
        assert!(task_knowledge_base_refs(&json!({"spec": {}})).is_empty());
    }

    #[test]
    fn the_merged_ids_keep_the_bound_ids_first() {
        assert_eq!(merge_knowledge_base_ids(&[3, 1], &[1, 2]), vec![3, 1, 2]);
        assert_eq!(merge_knowledge_base_ids(&[], &[2, 1]), vec![2, 1]);
        assert_eq!(merge_knowledge_base_ids(&[5], &[]), vec![5]);
        assert!(merge_knowledge_base_ids(&[], &[]).is_empty());
    }

    #[test]
    fn the_scope_value_matches_the_request_schema() {
        let scope = KnowledgeBaseScope {
            knowledge_base_id: 239607,
            scope_restricted: true,
            document_ids: vec![1, 2],
        };
        assert_eq!(
            scope_value(&scope),
            json!({
                "knowledge_base_id": 239607,
                "scope_restricted": true,
                "document_ids": [1, 2],
            })
        );
    }

    #[test]
    fn the_membership_probe_matches_the_access_store_query() {
        let sql = approved_membership_statement();
        assert!(sql.starts_with(
            "SELECT resource_members.id AS resource_members_id \nFROM resource_members"
        ));
        assert!(sql.contains("resource_members.resource_type = 'Task'"));
        assert!(sql.contains("resource_members.entity_type = 'user'"));
        assert!(sql.contains("resource_members.entity_id = ?"));
        assert!(sql.contains("resource_members.status = 'approved'"));
        assert!(sql.contains("resource_members.copied_resource_id = 0"));
        assert!(sql.ends_with("\n LIMIT 1"));
    }
}
