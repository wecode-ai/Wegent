// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/{knowledge_base_id}/folders`
//! (`app.api.endpoints.knowledge.get_folder_tree` ->
//! `KnowledgeFolderService.get_folder_tree`).
//!
//! Source pipeline for the caller's knowledge-base folders:
//!
//! 1. `security.get_current_user` — the session user (framework auth);
//! 2. `KnowledgeFolderService._check_kb_access` ->
//!    `KnowledgeService.get_knowledge_base` — the KB `Kind` record, then the
//!    full ACL chain of `resolve_knowledge_base_permission`; a missing or
//!    inaccessible KB raises the endpoint's mapped 404 value error
//!    "Knowledge base not found or access denied";
//! 3. the bulk folder query (`ORDER BY knowledge_folders.name`, optional
//!    `origin` filter) and the per-folder document-count aggregation
//!    (`GROUP BY knowledge_documents.folder_id`, optional `origin` filter);
//! 4. the in-memory tree build: roots are the `parent_id = 0` rows, children
//!    keep the folder query's name order, and each node's
//!    `total_document_count` rolls up its subtree. Folders whose parent is
//!    neither 0 nor another loaded folder are unreachable and dropped, like
//!    the source's `attach_children(0)` walk.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access::{
    knowledge_base_access, knowledge_base_record, quote_literal,
};
use crate::state::AppState;

/// `KnowledgeFolderResponse` (`app.schemas.knowledge`): field order follows
/// the pydantic model's declaration order.
#[derive(Debug, Serialize)]
struct FolderResponse {
    id: i64,
    kind_id: i64,
    parent_id: i64,
    name: String,
    origin: String,
    children: Vec<FolderResponse>,
    document_count: i64,
    direct_document_count: i64,
    total_document_count: i64,
    created_at: String,
    updated_at: String,
}

/// GET /api/knowledge-bases/:knowledge_base_id/folders: the folder-tree free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/:knowledge_base_id/folders")]
async fn get_folder_tree_route(
    #[inject(state)] state: &Arc<AppState>,
    knowledge_base_id: &str,
    origin: Option<String>,
    #[auth] user: crate::auth::SessionUser,
) -> Result<Vec<FolderResponse>, FastApiError> {
    // FastAPI validates the path integer and the `origin` query enum before
    // the endpoint body runs.
    let knowledge_base_id = knowledge_base_id
        .parse::<i64>()
        .map_err(|_| path_validation_error(knowledge_base_id))?;
    let origin = validated_origin(origin.as_deref())?;
    folder_tree(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        knowledge_base_id,
        i64::from(user.id),
        origin,
    )
    .await
}

/// FastAPI-style 422 for an unparsable `knowledge_base_id` path parameter.
fn path_validation_error(value: &str) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "int_parsing",
        "loc": ["path", "knowledge_base_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    }]))
}

/// `Optional[ContentOrigin]` (`app.models.knowledge`): `generated` or `user`;
/// any other value fails validation with 422.
fn validated_origin(raw: Option<&str>) -> Result<Option<&str>, FastApiError> {
    match raw {
        None => Ok(None),
        value @ (Some("generated") | Some("user")) => Ok(value),
        Some(other) => Err(FastApiError::validation(json!([{
            "type": "enum",
            "loc": ["query", "origin"],
            "msg": "Input should be 'generated' or 'user'",
            "input": other,
        }]))),
    }
}

/// A dependency failure reaches the application's `Exception` handler, which
/// renders the unhandled 500 body.
fn dependency_failure(error: &str) -> FastApiError {
    tracing::error!(error, "knowledge-bases folders dependency failure");
    FastApiError::unhandled()
}

/// Handler body for `GET /api/knowledge-bases/{knowledge_base_id}/folders`.
async fn folder_tree<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    knowledge_base_id: i64,
    user_id: i64,
    origin: Option<&str>,
) -> Result<Vec<FolderResponse>, FastApiError>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // `_check_kb_access`: the KB record plus the full ACL chain. A missing
    // record short-circuits before any ACL query runs.
    let kb = knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(|error| dependency_failure(&error.to_string()))?;
    let has_access = match kb {
        None => false,
        Some(kb) => knowledge_base_access(mysql, redis, resolvers, &kb, user_id)
            .await
            .map_err(|error| dependency_failure(error.detail()))?,
    };
    if !has_access {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Knowledge base not found or access denied",
        ));
    }

    let folders = load_folders(mysql, knowledge_base_id, origin)
        .await
        .map_err(|error| dependency_failure(&error.to_string()))?;
    let counts = load_document_counts(mysql, knowledge_base_id, origin)
        .await
        .map_err(|error| dependency_failure(&error.to_string()))?;
    Ok(build_tree(folders, &counts))
}

/// One `knowledge_folders` row of the bulk load (SQLAlchemy-labeled
/// projection).
#[derive(Debug, FromMysqlRow)]
struct FolderRow {
    knowledge_folders_id: i64,
    knowledge_folders_kind_id: i64,
    knowledge_folders_parent_id: i64,
    knowledge_folders_name: String,
    knowledge_folders_origin: String,
    knowledge_folders_created_at: chrono::NaiveDateTime,
    knowledge_folders_updated_at: chrono::NaiveDateTime,
}

/// One `(folder_id, count)` row of the document-count aggregation.
#[derive(Debug, FromMysqlRow)]
struct DocumentCountRow {
    knowledge_documents_folder_id: i64,
    count_1: i64,
}

/// The bulk folder query: every folder of the KB ordered by name, optionally
/// filtered by content origin.
async fn load_folders<M>(
    mysql: &M,
    knowledge_base_id: i64,
    origin: Option<&str>,
) -> MysqlResult<Vec<FolderRow>>
where
    M: Mysql,
{
    let origin_filter = origin
        .map(|origin| format!(" AND knowledge_folders.origin = {}", quote_literal(origin)))
        .unwrap_or_default();
    mysql
        .fetch_all(
            &format!(
                "SELECT knowledge_folders.id AS knowledge_folders_id, \
                 knowledge_folders.kind_id AS knowledge_folders_kind_id, \
                 knowledge_folders.parent_id AS knowledge_folders_parent_id, \
                 knowledge_folders.name AS knowledge_folders_name, \
                 knowledge_folders.origin AS knowledge_folders_origin, \
                 knowledge_folders.created_at AS knowledge_folders_created_at, \
                 knowledge_folders.updated_at AS knowledge_folders_updated_at \n\
                 FROM knowledge_folders \n\
                 WHERE knowledge_folders.kind_id = {knowledge_base_id}{origin_filter} \
                 ORDER BY knowledge_folders.name"
            ),
            (),
        )
        .await
}

/// The per-folder document counts: `count(knowledge_documents.id)` grouped by
/// `folder_id`, scoped to the KB and optionally to a content origin.
async fn load_document_counts<M>(
    mysql: &M,
    knowledge_base_id: i64,
    origin: Option<&str>,
) -> MysqlResult<Vec<(i64, i64)>>
where
    M: Mysql,
{
    let origin_filter = origin
        .map(|origin| {
            format!(
                " AND knowledge_documents.origin = {}",
                quote_literal(origin)
            )
        })
        .unwrap_or_default();
    let rows: Vec<DocumentCountRow> = mysql
        .fetch_all(
            &format!(
                "SELECT knowledge_documents.folder_id AS knowledge_documents_folder_id, \
                 count(knowledge_documents.id) AS count_1 \n\
                 FROM knowledge_documents \n\
                 WHERE knowledge_documents.kind_id = {knowledge_base_id}{origin_filter} \
                 GROUP BY knowledge_documents.folder_id"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.knowledge_documents_folder_id, row.count_1))
        .collect())
}

/// `attach_children`: build the response tree from the name-ordered folder
/// rows and the per-folder document counts. Roots are the `parent_id = 0`
/// rows; every node's `total_document_count` is its direct count plus the
/// totals of its children.
fn build_tree(rows: Vec<FolderRow>, counts: &[(i64, i64)]) -> Vec<FolderResponse> {
    let doc_counts: HashMap<i64, i64> = counts.iter().copied().collect();
    // Children keyed by parent id, keeping the query's name order.
    let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        children
            .entry(row.knowledge_folders_parent_id)
            .or_default()
            .push(index);
    }
    let mut visited = HashSet::new();
    attach_children(&rows, &children, &doc_counts, 0, &mut visited)
}

/// The recursive walk under one parent id.
fn attach_children(
    rows: &[FolderRow],
    children: &HashMap<i64, Vec<usize>>,
    doc_counts: &HashMap<i64, i64>,
    parent_id: i64,
    visited: &mut HashSet<i64>,
) -> Vec<FolderResponse> {
    let mut result = Vec::new();
    let Some(indexes) = children.get(&parent_id) else {
        return result;
    };
    for &index in indexes {
        let row = &rows[index];
        if !visited.insert(row.knowledge_folders_id) {
            // A parent cycle would recurse forever in the source (its
            // RecursionError becomes an unhandled 500). Stop descending so
            // the process stays alive; the folder service's depth checks keep
            // the stored data cycle-free.
            continue;
        }
        let direct = doc_counts
            .get(&row.knowledge_folders_id)
            .copied()
            .unwrap_or(0);
        let child_nodes = attach_children(
            rows,
            children,
            doc_counts,
            row.knowledge_folders_id,
            visited,
        );
        let total = direct
            + child_nodes
                .iter()
                .map(|child| child.total_document_count)
                .sum::<i64>();
        result.push(FolderResponse {
            id: row.knowledge_folders_id,
            kind_id: row.knowledge_folders_kind_id,
            parent_id: row.knowledge_folders_parent_id,
            name: row.knowledge_folders_name.clone(),
            origin: row.knowledge_folders_origin.clone(),
            children: child_nodes,
            document_count: direct,
            direct_document_count: direct,
            total_document_count: total,
            created_at: format_datetime(row.knowledge_folders_created_at),
            updated_at: format_datetime(row.knowledge_folders_updated_at),
        });
    }
    result
}

/// FastAPI's default JSON encoding of a naive datetime column.
fn format_datetime(value: chrono::NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(id: i64, parent_id: i64, name: &str) -> FolderRow {
        let timestamp =
            chrono::NaiveDateTime::parse_from_str("2026-01-01 16:43:32", "%Y-%m-%d %H:%M:%S")
                .unwrap();
        FolderRow {
            knowledge_folders_id: id,
            knowledge_folders_kind_id: 257464,
            knowledge_folders_parent_id: parent_id,
            knowledge_folders_name: name.to_string(),
            knowledge_folders_origin: "user".to_string(),
            knowledge_folders_created_at: timestamp,
            knowledge_folders_updated_at: timestamp,
        }
    }

    #[test]
    fn empty_tree_serializes_as_an_empty_array() {
        let tree = build_tree(Vec::new(), &[]);
        assert_eq!(serde_json::to_string(&tree).unwrap(), "[]");
    }

    #[test]
    fn nested_tree_rolls_up_document_counts() {
        // Query order is name order: "alpha", "beta" (child of alpha).
        let rows = vec![folder(1, 0, "alpha"), folder(2, 1, "beta")];
        let counts = vec![(1, 2), (2, 3), (0, 8)];
        let tree = build_tree(rows, &counts);
        assert_eq!(tree.len(), 1);
        let alpha = &tree[0];
        assert_eq!(alpha.id, 1);
        assert_eq!(alpha.document_count, 2);
        assert_eq!(alpha.direct_document_count, 2);
        assert_eq!(alpha.total_document_count, 5);
        assert_eq!(alpha.children.len(), 1);
        let beta = &alpha.children[0];
        assert_eq!(beta.id, 2);
        assert_eq!(beta.total_document_count, 3);
        // The root-level count (folder_id 0) never renders as a folder.
        assert_eq!(tree.iter().map(|node| node.id).collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn folders_without_parents_keep_query_order_and_are_dropped_when_orphaned() {
        let rows = vec![
            folder(3, 0, "zulu"),
            folder(4, 0, "alpha"),
            folder(5, 99, "orphan"),
        ];
        let tree = build_tree(rows, &[]);
        // Roots keep the name order of the folder query.
        assert_eq!(
            tree.iter().map(|node| node.id).collect::<Vec<_>>(),
            vec![3, 4]
        );
        // The orphan's parent is neither 0 nor a loaded folder, so it is
        // unreachable, like the source's `attach_children(0)` walk.
        assert!(tree.iter().all(|node| node.children.is_empty()));
    }

    #[test]
    fn response_field_order_matches_pydantic_model() {
        let tree = build_tree(vec![folder(7, 0, "n")], &[]);
        let body = serde_json::to_string(&tree).unwrap();
        assert_eq!(
            body,
            r#"[{"id":7,"kind_id":257464,"parent_id":0,"name":"n","origin":"user","children":[],"document_count":0,"direct_document_count":0,"total_document_count":0,"created_at":"2026-01-01T16:43:32","updated_at":"2026-01-01T16:43:32"}]"#
        );
    }

    #[test]
    fn unknown_origin_fails_validation() {
        assert!(validated_origin(Some("system")).is_err());
        assert!(validated_origin(None).unwrap().is_none());
        assert_eq!(validated_origin(Some("user")).unwrap(), Some("user"));
        assert_eq!(
            validated_origin(Some("generated")).unwrap(),
            Some("generated")
        );
    }

    #[test]
    fn path_validation_error_renders_fastapi_422() {
        use brz_http_server::IntoHttpError as _;
        let error = path_validation_error("abc");
        let response = error.into_http_error(&brz_http_server::EphemeralBytesArena::new(1024));
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    /// The recorded representative case's bulk folder query, byte-for-byte
    /// modulo whitespace.
    #[tokio::test]
    async fn folder_query_renders_the_recorded_statement() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        load_folders(&mysql, 257464, None).await.unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            "SELECT knowledge_folders.id AS knowledge_folders_id, \
             knowledge_folders.kind_id AS knowledge_folders_kind_id, \
             knowledge_folders.parent_id AS knowledge_folders_parent_id, \
             knowledge_folders.name AS knowledge_folders_name, \
             knowledge_folders.origin AS knowledge_folders_origin, \
             knowledge_folders.created_at AS knowledge_folders_created_at, \
             knowledge_folders.updated_at AS knowledge_folders_updated_at \
             FROM knowledge_folders \
             WHERE knowledge_folders.kind_id = 257464 \
             ORDER BY knowledge_folders.name"
        );
    }

    /// The origin filter appends to the folder and count queries like
    /// SQLAlchemy's `.filter(KnowledgeFolder.origin == value)`.
    #[tokio::test]
    async fn origin_filter_renders_in_both_queries() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        load_folders(&mysql, 257464, Some("user")).await.unwrap();
        load_document_counts(&mysql, 257464, Some("generated"))
            .await
            .unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert!(queries[0].sql.contains(
            "WHERE knowledge_folders.kind_id = 257464 \
                       AND knowledge_folders.origin = 'user' ORDER BY"
        ));
        assert!(queries[1].sql.contains(
            "WHERE knowledge_documents.kind_id = 257464 \
                       AND knowledge_documents.origin = 'generated' GROUP BY"
        ));
    }

    /// The recorded representative case's document-count aggregation.
    #[tokio::test]
    async fn count_query_renders_the_recorded_statement() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        load_document_counts(&mysql, 257464, None).await.unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            "SELECT knowledge_documents.folder_id AS knowledge_documents_folder_id, \
             count(knowledge_documents.id) AS count_1 \
             FROM knowledge_documents \
             WHERE knowledge_documents.kind_id = 257464 \
             GROUP BY knowledge_documents.folder_id"
        );
    }

    /// Python owns the route while the Rust handler stays registered.
    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/knowledge-bases/:knowledge_base_id/folders";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain Python-owned"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/knowledge-bases/257464/folders"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
