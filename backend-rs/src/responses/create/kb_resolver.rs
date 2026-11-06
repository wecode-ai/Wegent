// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `KnowledgeBaseNameResolver.resolve` for the create flow's task-level scope
//! refs (`backend/app/services/openapi/kb_resolver.py:120`).
//!
//! The resolver checks every ref against the caller's *directly accessible*
//! knowledge bases — the direct-access filter of
//! `knowledge_visibility_query.filter_directly_accessible_knowledge_bases`
//! (`knowledge_visibility_query.py:146`), which is the same predicate the
//! default-KB path already applies through
//! [`get_acl_accessible_knowledge_base_ids`] — and then carries
//! `scope_specified` through as `scope_restricted`.
//!
//! Rejections keep the Source's split: a ref that cannot be formed at all is
//! `404 "Knowledge base(s) not found: <ns#name>"`; a well-formed ref the caller
//! cannot reach is `403 "Access denied to knowledge base(s): <ns#name>"`.
use std::collections::HashMap;

use brz_http_server::StatusCode;
use brz_redis::Redis;

use crate::http_compat::FastApiError;

use super::bound_knowledge::ScopeRef;
use super::knowledge::{AclContextSource, get_acl_accessible_knowledge_base_ids};
use super::knowledge_access::knowledge_access_error;
use super::knowledge_folder_scope::{
    DocumentScopeRequest, ScopeResolutionError, resolve_document_ids_for_scope,
};

/// One `ResolvedKnowledgeBase` (`kb_resolver.py:26`): the ref's resolved id and
/// identity, plus the scope the ref asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedKnowledgeBase {
    pub kb_id: i64,
    pub namespace: String,
    pub name: String,
    pub scope_restricted: bool,
    pub folder_ids: Option<Vec<i64>>,
    pub explicit_document_ids: Option<Vec<i64>>,
    pub include_subfolders: bool,
    /// `resolve_document_ids_for_scope`'s result for a restricted scope.
    /// Resolved by the folder-scope step; empty until a restricted ref carries
    /// a document scope.
    pub resolved_document_ids: Vec<i64>,
}

/// `_get_bound_knowledge_base_scopes`' resolver call
/// (`contexts.py:2197-2206`): resolve every persisted scope ref against the
/// caller's accessible knowledge bases.
pub async fn resolve_scope_refs<R: Redis>(
    acl: &AclContextSource<'_, R>,
    user_id: i64,
    refs: &[ScopeRef],
) -> Result<Vec<ResolvedKnowledgeBase>, FastApiError> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }

    // Malformed refs (`not_found`) and the ids the accessibility check runs on.
    let mut not_found: Vec<String> = Vec::new();
    let mut candidate_ids: Vec<i64> = Vec::new();
    for reference in refs {
        match reference.id {
            Some(id) => candidate_ids.push(id),
            None if reference.name.is_empty() => not_found.push(reference_label(reference)),
            None => {}
        }
    }
    // A name ref resolves through the KB row's own `(namespace, name)`, the
    // identity the accessible lookup is keyed by.
    let mut name_ids: HashMap<(String, String), i64> = HashMap::new();
    if refs.iter().any(|reference| reference.id.is_none()) {
        name_ids = knowledge_base_ids_by_name(acl, refs).await?;
    }
    for reference in refs {
        if reference.id.is_none()
            && !reference.name.is_empty()
            && let Some(id) = name_ids.get(&(reference.namespace.clone(), reference.name.clone()))
        {
            candidate_ids.push(*id);
        }
    }
    candidate_ids.sort_unstable();
    candidate_ids.dedup();

    let accessible: Vec<i64> = get_acl_accessible_knowledge_base_ids(acl, user_id, &candidate_ids)
        .await
        .map_err(knowledge_access_error)?;
    let identities = knowledge_base_identities(acl, &accessible).await?;
    let mut resolved = decide(refs, not_found, &name_ids, &accessible, &identities)?;
    // `_build_resolved_ref` (`kb_resolver.py:250-258`): only a restricted
    // scope resolves its folder / document ids, and a `ValueError` there is the
    // Source's `400`.
    resolve_restricted_documents(
        acl.mysql(),
        acl.redis(),
        acl.resolvers(),
        user_id,
        &mut resolved,
    )
    .await?;
    Ok(resolved)
}

/// The restricted-scope half of `_build_resolved_ref`: resolve each
/// `scope_specified` ref's document ids through
/// `KnowledgeFolderService.resolve_document_ids_for_scope`.
pub(super) async fn resolve_restricted_documents<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
    resolved: &mut [ResolvedKnowledgeBase],
) -> Result<(), FastApiError>
where
    M: brz_mysql::Mysql,
    R: Redis,
{
    for reference in resolved.iter_mut() {
        if !reference.scope_restricted {
            continue;
        }
        let request = scope_request(reference, user_id);
        reference.resolved_document_ids =
            resolve_document_ids_for_scope(mysql, redis, resolvers, &request)
                .await
                .map_err(scope_error)?;
    }
    Ok(())
}

/// `resolve_document_ids_for_scope(db=…, knowledge_base_id=…, user_id=…,
/// folder_ids=folder_ids or None, document_ids=explicit_document_ids or None,
/// include_subfolders=…)`: an empty list is `None`, which skips that half.
pub(super) fn scope_request(
    reference: &ResolvedKnowledgeBase,
    user_id: i64,
) -> DocumentScopeRequest {
    let non_empty = |values: Option<Vec<i64>>| values.filter(|ids| !ids.is_empty());
    DocumentScopeRequest {
        knowledge_base_id: reference.kb_id,
        user_id,
        folder_ids: non_empty(reference.folder_ids.clone()),
        document_ids: non_empty(reference.explicit_document_ids.clone()),
        include_subfolders: reference.include_subfolders,
    }
}

/// `raise HTTPException(400, detail=str(exc))` for the Source's `ValueError`s;
/// a dependency failure stays a 500.
fn scope_error(error: ScopeResolutionError) -> FastApiError {
    match error.value_error_message() {
        Some(message) => FastApiError::detail(StatusCode::BAD_REQUEST, message),
        None => {
            tracing::error!(%error, "knowledge folder scope resolution failed");
            FastApiError::internal()
        }
    }
}

/// The resolver's decision, separated from its reads: which refs are admitted,
/// and the Source's `404` / `403` when any are not.
pub(super) fn decide(
    refs: &[ScopeRef],
    not_found: Vec<String>,
    name_ids: &HashMap<(String, String), i64>,
    accessible_ids: &[i64],
    identities: &HashMap<i64, (String, String)>,
) -> Result<Vec<ResolvedKnowledgeBase>, FastApiError> {
    let mut resolved: Vec<ResolvedKnowledgeBase> = Vec::with_capacity(refs.len());
    let mut no_access: Vec<String> = Vec::new();
    for reference in refs {
        let kb_id = match reference.id {
            Some(id) => id,
            None if reference.name.is_empty() => continue,
            None => match name_ids.get(&(reference.namespace.clone(), reference.name.clone())) {
                Some(id) => *id,
                None => {
                    no_access.push(reference_label(reference));
                    continue;
                }
            },
        };
        let Some((namespace, name)) = identities.get(&kb_id) else {
            no_access.push(reference_label(reference));
            continue;
        };
        if !accessible_ids.contains(&kb_id) {
            no_access.push(reference_label(reference));
            continue;
        }
        resolved.push(ResolvedKnowledgeBase {
            kb_id,
            namespace: namespace.clone(),
            name: if reference.name.is_empty() {
                name.clone()
            } else {
                reference.name.clone()
            },
            // `_build_resolved_ref`: `scope_restricted = bool(scope_specified)`.
            scope_restricted: reference.scope_specified,
            folder_ids: reference.folder_ids.clone(),
            explicit_document_ids: reference.document_ids.clone(),
            include_subfolders: reference.include_subfolders,
            resolved_document_ids: Vec::new(),
        });
    }

    handle_errors(&not_found, &no_access)?;
    Ok(resolved)
}

/// `_handle_errors` (`kb_resolver.py:283`): 404 for refs that cannot be formed,
/// 403 for refs the caller cannot reach.
fn handle_errors(not_found: &[String], no_access: &[String]) -> Result<(), FastApiError> {
    if !not_found.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            format!("Knowledge base(s) not found: {}", not_found.join(", ")),
        ));
    }
    if !no_access.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            format!(
                "Access denied to knowledge base(s): {}",
                no_access.join(", ")
            ),
        ));
    }
    Ok(())
}

/// The ref's Source label (`f"{namespace}#{name}"`).
fn reference_label(reference: &ScopeRef) -> String {
    format!("{}#{}", reference.namespace, reference.name)
}

/// The KB ids of the refs' `(namespace, name)` identities.
async fn knowledge_base_ids_by_name<R: Redis>(
    acl: &AclContextSource<'_, R>,
    refs: &[ScopeRef],
) -> Result<HashMap<(String, String), i64>, FastApiError> {
    let mut wanted: Vec<(String, String)> = refs
        .iter()
        .filter(|reference| reference.id.is_none() && !reference.name.is_empty())
        .map(|reference| (reference.namespace.clone(), reference.name.clone()))
        .collect();
    wanted.sort();
    wanted.dedup();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }
    let mut ids = HashMap::new();
    for (namespace, name) in wanted {
        let row: Option<brz_mysql::MysqlRow> = acl
            .mysql()
            .fetch_optional(
                &knowledge_base_by_name_statement(),
                (namespace.as_str(), name.as_str()),
            )
            .await
            .map_err(super::request::dependency)?;
        let Some(row) = row else {
            continue;
        };
        let id: i64 = row
            .get_required("kinds_id")
            .map_err(super::request::dependency)?;
        ids.insert((namespace, name), id);
    }
    Ok(ids)
}

/// The `(namespace, name)` identity of every accessible KB id.
async fn knowledge_base_identities<R: Redis>(
    acl: &AclContextSource<'_, R>,
    ids: &[i64],
) -> Result<HashMap<i64, (String, String)>, FastApiError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut identities = HashMap::with_capacity(ids.len());
    for id in ids {
        let row: Option<brz_mysql::MysqlRow> = acl
            .mysql()
            .fetch_optional(&knowledge_base_identity_statement(), (*id,))
            .await
            .map_err(super::request::dependency)?;
        let Some(row) = row else {
            continue;
        };
        identities.insert(
            *id,
            (
                row.get_required("kinds_namespace")
                    .map_err(super::request::dependency)?,
                row.get_required("kinds_name")
                    .map_err(super::request::dependency)?,
            ),
        );
    }
    Ok(identities)
}

/// `db.query(Kind).filter(kind='KnowledgeBase', is_active, namespace, name).first()`.
fn knowledge_base_by_name_statement() -> String {
    "SELECT kinds.id AS kinds_id \nFROM kinds \nWHERE kinds.kind = 'KnowledgeBase' \
     AND kinds.is_active IS true \nAND kinds.namespace = ? AND kinds.name = ? \n LIMIT 1"
        .to_string()
}

/// The identity read behind the accessible lookup's `id_lookup`.
fn knowledge_base_identity_statement() -> String {
    "SELECT kinds.id AS kinds_id, kinds.namespace AS kinds_namespace, \
     kinds.name AS kinds_name \nFROM kinds \nWHERE kinds.id = ? \n LIMIT 1"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope_ref(id: Option<i64>, namespace: &str, name: &str, restricted: bool) -> ScopeRef {
        ScopeRef {
            id,
            namespace: namespace.to_string(),
            name: name.to_string(),
            folder_ids: None,
            document_ids: None,
            include_subfolders: true,
            scope_specified: restricted,
        }
    }

    fn identities(id: i64, namespace: &str, name: &str) -> HashMap<i64, (String, String)> {
        let mut map = HashMap::new();
        map.insert(id, (namespace.to_string(), name.to_string()));
        map
    }

    /// A ref carrying an accessible id resolves, and `scope_specified` becomes
    /// `scope_restricted`.
    #[test]
    fn an_accessible_id_is_admitted_and_keeps_its_scope() {
        let reference = scope_ref(Some(263078), "default", "", true);
        let resolved = decide(
            std::slice::from_ref(&reference),
            Vec::new(),
            &HashMap::new(),
            &[263078],
            &identities(263078, "VeritasID", "转发+评论 日志风控分析助手-kb"),
        )
        .expect("admitted");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].kb_id, 263078);
        assert_eq!(resolved[0].namespace, "VeritasID");
        assert_eq!(resolved[0].name, "转发+评论 日志风控分析助手-kb");
        assert!(resolved[0].scope_restricted);
    }

    /// A name ref resolves through the `(namespace, name)` lookup.
    #[test]
    fn an_accessible_name_is_admitted() {
        let reference = scope_ref(None, "VeritasID", "audit-kb", false);
        let mut names = HashMap::new();
        names.insert(("VeritasID".to_string(), "audit-kb".to_string()), 263078i64);
        let resolved = decide(
            std::slice::from_ref(&reference),
            Vec::new(),
            &names,
            &[263078],
            &identities(263078, "VeritasID", "audit-kb"),
        )
        .expect("admitted");
        assert_eq!(resolved[0].kb_id, 263078);
        assert!(!resolved[0].scope_restricted);
    }

    /// A ref that cannot be formed is the Source's 404.
    #[test]
    fn a_malformed_ref_is_not_found() {
        let reference = scope_ref(None, "VeritasID", "", false);
        let error = decide(
            std::slice::from_ref(&reference),
            vec!["VeritasID#".to_string()],
            &HashMap::new(),
            &[],
            &HashMap::new(),
        )
        .expect_err("not found");
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            error.detail_message(),
            Some("Knowledge base(s) not found: VeritasID#")
        );
    }

    /// A name the caller cannot reach is the Source's 403.
    #[test]
    fn an_unknown_name_is_denied() {
        let reference = scope_ref(None, "VeritasID", "audit-kb", false);
        let error = decide(
            std::slice::from_ref(&reference),
            Vec::new(),
            &HashMap::new(),
            &[],
            &HashMap::new(),
        )
        .expect_err("denied");
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            error.detail_message(),
            Some("Access denied to knowledge base(s): VeritasID#audit-kb")
        );
    }

    /// The missing-membership path: the KB exists but the caller is not in its
    /// accessible set, so the ref is denied rather than resolved.
    #[test]
    fn an_inaccessible_id_is_denied() {
        let reference = scope_ref(Some(263078), "default", "", true);
        let error = decide(
            std::slice::from_ref(&reference),
            Vec::new(),
            &HashMap::new(),
            &[999999],
            &identities(263078, "VeritasID", "audit-kb"),
        )
        .expect_err("denied");
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            error.detail_message(),
            Some("Access denied to knowledge base(s): default#")
        );
    }

    /// An id the accessible set never returned (no row at all) is denied too.
    #[test]
    fn an_unknown_id_is_denied() {
        let reference = scope_ref(Some(424242), "default", "", false);
        let error = decide(
            std::slice::from_ref(&reference),
            Vec::new(),
            &HashMap::new(),
            &[],
            &HashMap::new(),
        )
        .expect_err("denied");
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
    }
}

#[cfg(test)]
mod folder_wiring_tests {
    use super::*;

    fn restricted_reference() -> ResolvedKnowledgeBase {
        ResolvedKnowledgeBase {
            kb_id: 263078,
            namespace: "VeritasID".to_string(),
            name: "audit-kb".to_string(),
            scope_restricted: true,
            folder_ids: Some(vec![0]),
            explicit_document_ids: None,
            include_subfolders: true,
            resolved_document_ids: Vec::new(),
        }
    }

    fn resolvers() -> crate::permissions::EntityResolvers {
        crate::permissions::EntityResolvers::public(
            brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test")
                .expect("lazy pool"),
        )
    }

    /// A `scope_specified` ref is handed to the folder resolver: the resolver
    /// reads the KB row first (`_check_kb_access`), so the fake records that
    /// read and the denial is the folder resolver's own `ValueError`, surfaced
    /// as the Source's 400.
    #[tokio::test]
    async fn a_restricted_ref_goes_through_the_folder_resolver() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let mut resolved = vec![restricted_reference()];
        let error = resolve_restricted_documents(
            &mysql,
            None::<&brz_redis::RedisService>,
            &resolvers(),
            5831,
            &mut resolved,
        )
        .await
        .expect_err("the fake returns no KB row");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error.detail_message(),
            Some("Knowledge base not found or access denied")
        );
        let calls = mysql.queries();
        assert!(
            calls
                .iter()
                .any(|call| call.sql.contains("FROM kinds") || call.sql.contains("knowledge")),
            "the folder resolver ran: {calls:?}"
        );
        assert!(resolved[0].resolved_document_ids.is_empty());
    }

    /// A non-restricted scope never reaches the folder resolver.
    #[tokio::test]
    async fn an_unrestricted_ref_skips_the_folder_resolver() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let mut reference = restricted_reference();
        reference.scope_restricted = false;
        let mut resolved = vec![reference];
        resolve_restricted_documents(
            &mysql,
            None::<&brz_redis::RedisService>,
            &resolvers(),
            5831,
            &mut resolved,
        )
        .await
        .expect("no restriction");
        assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
        assert!(resolved[0].resolved_document_ids.is_empty());
    }

    /// `folder_ids or None` / `document_ids or None`: an empty list becomes
    /// `None`, which skips that half of the scope.
    #[test]
    fn empty_scope_lists_become_none() {
        let mut reference = restricted_reference();
        reference.folder_ids = Some(Vec::new());
        reference.explicit_document_ids = Some(Vec::new());
        let request = scope_request(&reference, 5831);
        assert_eq!(request.folder_ids, None);
        assert_eq!(request.document_ids, None);
        assert!(request.include_subfolders);
    }
}
