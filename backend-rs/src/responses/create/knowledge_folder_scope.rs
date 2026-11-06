// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `KnowledgeFolderService.resolve_document_ids_for_scope`
//! (`app/services/knowledge/folder_service.py:597`), reached from the create
//! flow's `KnowledgeBaseNameResolver._build_resolved_ref`
//! (`app/services/openapi/kb_resolver.py:239`).
//!
//! A restricted knowledge-base reference resolves to the ordered document-id
//! set the retrieval path accepts:
//!
//! 1. `_check_kb_access` — the knowledge-base `Kind` row plus the full ACL
//!    chain of `resolve_knowledge_base_permission`; a missing or inaccessible
//!    knowledge base raises the source's `ValueError` before any scope input is
//!    validated.
//! 2. Explicit `document_ids`, deduplicated in first-seen order, loaded in
//!    batches of [`MAX_IN_CLAUSE_SIZE`] and required to belong to this
//!    knowledge base.
//! 3. `folder_ids`: every positive id must exist in this knowledge base and,
//!    when `include_subfolders` is set, expands to its descendants; the
//!    documents of the resulting folder set are appended in document-id order.
//!    `folder_ids == [0]` means root-level documents only — folder 0 is not a
//!    tree node and never expands to the whole knowledge base.
//!
//! The source renders its `IN` lists with literal values (the recorded
//! statements carry `kind_id IN (263078)`, not placeholders), so the statement
//! builders below do the same. The knowledge tables are deployment-wide and
//! are not task-sharded, so these reads carry no `ByTaskId` routing key; their
//! physical names still come from [`KnowledgeScopeTables`] the way the task
//! statements take their templates, rather than from literals inside the
//! resolution logic.
use std::collections::{BTreeSet, HashMap, HashSet};

use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, Mysql, MysqlError, MysqlResult};
use brz_redis::Redis;

use crate::knowledge_documents_content::access::{knowledge_base_access, knowledge_base_record};
use crate::knowledge_documents_content::reader::DOCUMENT_COLUMNS;
use crate::permissions::EntityResolvers;

/// `_MAX_IN_CLAUSE_SIZE`: the explicit-document batch size.
pub const MAX_IN_CLAUSE_SIZE: usize = 1000;

/// `knowledge_folders` columns as rendered by `db.query(KnowledgeFolder)`.
const FOLDER_COLUMNS: &str = "knowledge_folders.id AS knowledge_folders_id, \
     knowledge_folders.kind_id AS knowledge_folders_kind_id, \
     knowledge_folders.parent_id AS knowledge_folders_parent_id, \
     knowledge_folders.name AS knowledge_folders_name, \
     knowledge_folders.origin AS knowledge_folders_origin, \
     knowledge_folders.created_at AS knowledge_folders_created_at, \
     knowledge_folders.updated_at AS knowledge_folders_updated_at";

/// The physical tables the scope statements render.
///
/// The default is the shared [`Self::base`] schema. A deployment that resolves
/// these tables differently builds its reader with
/// [`MysqlScopeReader::with_tables`] and its own rendered names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KnowledgeScopeTables {
    /// The rendered `knowledge_folders` table name.
    pub folders: &'static str,
    /// The rendered `knowledge_documents` table name.
    pub documents: &'static str,
}

impl KnowledgeScopeTables {
    /// The shared `knowledge_folders` / `knowledge_documents` tables.
    pub const fn base() -> Self {
        Self {
            folders: "knowledge_folders",
            documents: "knowledge_documents",
        }
    }
}

impl Default for KnowledgeScopeTables {
    fn default() -> Self {
        Self::base()
    }
}

/// One `resolve_document_ids_for_scope` call's inputs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DocumentScopeRequest {
    pub knowledge_base_id: i64,
    /// The requesting user (`_check_kb_access`).
    pub user_id: i64,
    /// `folder_ids or None`: `None` and an empty list differ — the source
    /// raises for an empty list but skips the folder half for `None`.
    pub folder_ids: Option<Vec<i64>>,
    /// `document_ids or None`, with the same empty-list rule.
    pub document_ids: Option<Vec<i64>>,
    /// `bool(ref.get("include_subfolders", True))`.
    pub include_subfolders: bool,
}

/// The source `ValueError`s this resolution raises, plus dependency failures
/// the source lets propagate.
#[derive(Debug, PartialEq, Eq)]
pub enum ScopeResolutionError {
    /// `_check_kb_access`'s "Knowledge base not found or access denied".
    AccessDenied,
    /// `folder_ids must not be empty`.
    EmptyFolderIds,
    /// `document_ids must not be empty`.
    EmptyDocumentIds,
    /// `Document {id} not found in this knowledge base`.
    DocumentNotFound(i64),
    /// `Folder {id} not found in this knowledge base`.
    FolderNotFound(i64),
    /// A store failure that is not a `ValueError` in the source.
    Dependency(String),
}

impl ScopeResolutionError {
    /// The `ValueError` message `_build_resolved_ref` turns into
    /// `HTTPException(400, detail=str(exc))`; `None` for a dependency failure,
    /// which the source leaves unhandled.
    pub fn value_error_message(&self) -> Option<String> {
        match self {
            Self::AccessDenied => Some("Knowledge base not found or access denied".to_string()),
            Self::EmptyFolderIds => Some("folder_ids must not be empty".to_string()),
            Self::EmptyDocumentIds => Some("document_ids must not be empty".to_string()),
            Self::DocumentNotFound(id) => {
                Some(format!("Document {id} not found in this knowledge base"))
            }
            Self::FolderNotFound(id) => {
                Some(format!("Folder {id} not found in this knowledge base"))
            }
            Self::Dependency(_) => None,
        }
    }
}

impl std::fmt::Display for ScopeResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.value_error_message() {
            Some(message) => formatter.write_str(&message),
            None => match self {
                Self::Dependency(message) => formatter.write_str(message),
                _ => Ok(()),
            },
        }
    }
}

impl std::error::Error for ScopeResolutionError {}

/// One loaded `knowledge_documents` row, projected to the two columns the
/// resolution reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScopeDocument {
    pub id: i64,
    pub kind_id: i64,
}

/// The row reads `resolve_document_ids_for_scope` performs after its access
/// check. Production reads use [`MysqlScopeReader`]; tests substitute an
/// in-memory implementation.
#[async_trait]
pub trait ScopeReader: Send + Sync {
    /// `_bulk_load_documents` for one batch.
    async fn documents_by_ids(&self, ids: &[i64]) -> MysqlResult<Vec<ScopeDocument>>;
    /// The `(kind_id, id IN ...)` folder existence read.
    async fn folders_by_ids(&self, knowledge_base_id: i64, ids: &[i64]) -> MysqlResult<Vec<i64>>;
    /// `_collect_descendant_ids`: the folder's descendants, excluding itself.
    async fn descendant_ids(&self, knowledge_base_id: i64, folder_id: i64)
    -> MysqlResult<Vec<i64>>;
    /// The folder-document read, ordered by `knowledge_documents.id`.
    async fn documents_in_folders(
        &self,
        knowledge_base_id: i64,
        folder_ids: &[i64],
    ) -> MysqlResult<Vec<i64>>;
}

/// `resolve_document_ids_for_scope`: the complete source call.
///
/// `redis` and `resolvers` feed `_check_kb_access`'s ACL chain exactly like
/// the folder endpoints' `knowledge_base_access`; the scope reads themselves
/// only touch MySQL.
pub async fn resolve_document_ids_for_scope<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    request: &DocumentScopeRequest,
) -> Result<Vec<i64>, ScopeResolutionError>
where
    M: Mysql,
    R: Redis,
{
    check_kb_access(
        mysql,
        redis,
        resolvers,
        request.knowledge_base_id,
        request.user_id,
    )
    .await?;
    let reader = MysqlScopeReader::new(mysql);
    resolve_scope_ids(&reader, request).await
}

/// `_check_kb_access`: the KB record, then the full ACL chain. A missing row
/// short-circuits before any ACL read, exactly like the source.
async fn check_kb_access<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    knowledge_base_id: i64,
    user_id: i64,
) -> Result<(), ScopeResolutionError>
where
    M: Mysql,
    R: Redis,
{
    let kb = knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(dependency)?;
    let has_access = match kb {
        None => false,
        Some(kb) => knowledge_base_access(mysql, redis, resolvers, &kb, user_id)
            .await
            .map_err(|error| ScopeResolutionError::Dependency(error.detail().to_string()))?,
    };
    if !has_access {
        return Err(ScopeResolutionError::AccessDenied);
    }
    Ok(())
}

fn dependency(error: MysqlError) -> ScopeResolutionError {
    ScopeResolutionError::Dependency(error.to_string())
}

/// The source body after `_check_kb_access`: validate the inputs, load the
/// explicit documents, then expand the folder scope.
pub async fn resolve_scope_ids<S>(
    reader: &S,
    request: &DocumentScopeRequest,
) -> Result<Vec<i64>, ScopeResolutionError>
where
    S: ScopeReader + ?Sized,
{
    let knowledge_base_id = request.knowledge_base_id;
    if matches!(&request.folder_ids, Some(ids) if ids.is_empty()) {
        return Err(ScopeResolutionError::EmptyFolderIds);
    }
    if matches!(&request.document_ids, Some(ids) if ids.is_empty()) {
        return Err(ScopeResolutionError::EmptyDocumentIds);
    }

    let mut resolved_ids: Vec<i64> = Vec::new();
    let mut seen_document_ids: HashSet<i64> = HashSet::new();

    if let Some(document_ids) = request.document_ids.as_deref() {
        let unique_document_ids = deduplicate(document_ids);
        for batch in unique_document_ids.chunks(MAX_IN_CLAUSE_SIZE) {
            let documents = reader.documents_by_ids(batch).await.map_err(dependency)?;
            let documents_by_id: HashMap<i64, i64> = documents
                .into_iter()
                .map(|document| (document.id, document.kind_id))
                .collect();
            for document_id in batch {
                match documents_by_id.get(document_id) {
                    Some(kind_id) if *kind_id == knowledge_base_id => {
                        if seen_document_ids.insert(*document_id) {
                            resolved_ids.push(*document_id);
                        }
                    }
                    _ => return Err(ScopeResolutionError::DocumentNotFound(*document_id)),
                }
            }
        }
    }

    if let Some(folder_ids) = request.folder_ids.as_deref() {
        resolve_folder_documents(
            reader,
            knowledge_base_id,
            folder_ids,
            request.include_subfolders,
            &mut seen_document_ids,
            &mut resolved_ids,
        )
        .await?;
    }

    Ok(resolved_ids)
}

/// The `folder_ids` half: validate the positive folders, expand the subtree
/// when requested, then append the folder documents in document-id order.
///
/// `folder_id_set` is a set in the source; the physical `IN` list renders in
/// ascending id order here. The resolved document order is unaffected — the
/// folder-document query orders by `knowledge_documents.id`.
async fn resolve_folder_documents<S>(
    reader: &S,
    knowledge_base_id: i64,
    folder_ids: &[i64],
    include_subfolders: bool,
    seen_document_ids: &mut HashSet<i64>,
    resolved_ids: &mut Vec<i64>,
) -> Result<(), ScopeResolutionError>
where
    S: ScopeReader + ?Sized,
{
    let mut folder_id_set: BTreeSet<i64> = folder_ids.iter().copied().collect();
    let positive_folder_ids: Vec<i64> = folder_ids
        .iter()
        .copied()
        .filter(|folder_id| *folder_id > 0)
        .collect();

    if !positive_folder_ids.is_empty() {
        let found_folder_ids: HashSet<i64> = reader
            .folders_by_ids(knowledge_base_id, &positive_folder_ids)
            .await
            .map_err(dependency)?
            .into_iter()
            .collect();
        for folder_id in positive_folder_ids {
            if !found_folder_ids.contains(&folder_id) {
                return Err(ScopeResolutionError::FolderNotFound(folder_id));
            }
            if include_subfolders {
                folder_id_set.extend(
                    reader
                        .descendant_ids(knowledge_base_id, folder_id)
                        .await
                        .map_err(dependency)?,
                );
            }
        }
    }

    let folder_id_list: Vec<i64> = folder_id_set.into_iter().collect();
    let folder_documents = reader
        .documents_in_folders(knowledge_base_id, &folder_id_list)
        .await
        .map_err(dependency)?;
    for document_id in folder_documents {
        if seen_document_ids.insert(document_id) {
            resolved_ids.push(document_id);
        }
    }
    Ok(())
}

/// `dict.fromkeys(ids)`: deduplicate while preserving first-seen order.
fn deduplicate(ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::with_capacity(ids.len());
    let mut unique = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(*id) {
            unique.push(*id);
        }
    }
    unique
}

/// `_bulk_load_documents`: `db.query(KnowledgeDocument)` filtered by one id
/// batch.
pub fn documents_by_ids_statement(tables: KnowledgeScopeTables, ids: &[i64]) -> String {
    format!(
        "SELECT {} \nFROM {} \nWHERE {}.id IN ({})",
        document_columns(tables.documents),
        tables.documents,
        tables.documents,
        join_ids(ids)
    )
}

/// `db.query(KnowledgeFolder).filter(kind_id == ..., id.in_(ids))`, rendered
/// for the full folder entity.
pub fn folders_by_ids_statement(
    tables: KnowledgeScopeTables,
    knowledge_base_id: i64,
    ids: &[i64],
) -> String {
    format!(
        "SELECT {} \nFROM {} \nWHERE {}.kind_id = {knowledge_base_id} AND {}.id IN ({})",
        folder_columns(tables.folders),
        tables.folders,
        tables.folders,
        tables.folders,
        join_ids(ids)
    )
}

/// `_collect_descendant_ids_cte`: the source's recursive CTE, rendered with
/// literal parameters like the rest of the recorded statements.
pub fn descendants_statement(
    tables: KnowledgeScopeTables,
    knowledge_base_id: i64,
    folder_id: i64,
) -> String {
    let folders = tables.folders;
    format!(
        "
            WITH RECURSIVE descendants AS (
                -- Anchor: direct children of the target folder
                SELECT id
                FROM {folders}
                WHERE kind_id = {knowledge_base_id}
                  AND parent_id = {folder_id}

                UNION ALL

                -- Recursive: children of already-found descendants
                SELECT kf.id
                FROM {folders} kf
                         INNER JOIN descendants d ON kf.parent_id = d.id
                WHERE kf.kind_id = {knowledge_base_id})
            SELECT id
            FROM descendants
            "
    )
}

/// `_collect_descendant_ids_bfs`: one level's children, used when the server
/// cannot run the recursive CTE.
pub fn descendants_bfs_statement(
    tables: KnowledgeScopeTables,
    knowledge_base_id: i64,
    parent_ids: &[i64],
) -> String {
    format!(
        "SELECT {folders}.id AS knowledge_folders_id \nFROM {folders} \n\
         WHERE {folders}.kind_id = {knowledge_base_id} \
         AND {folders}.parent_id IN ({})",
        join_ids(parent_ids),
        folders = tables.folders
    )
}

/// `db.query(KnowledgeDocument.id).filter(kind_id == ..., folder_id.in_(...))
/// .order_by(KnowledgeDocument.id)`.
pub fn folder_documents_statement(
    tables: KnowledgeScopeTables,
    knowledge_base_id: i64,
    folder_ids: &[i64],
) -> String {
    format!(
        "SELECT {documents}.id AS knowledge_documents_id \nFROM {documents} \n\
         WHERE {documents}.kind_id = {knowledge_base_id} \
         AND {documents}.folder_id IN ({}) ORDER BY {documents}.id",
        join_ids(folder_ids),
        documents = tables.documents
    )
}

/// The `knowledge_documents` projection for the rendered table: the shared
/// SQLAlchemy labels, with the table qualifier following the template.
fn document_columns(table: &str) -> String {
    DOCUMENT_COLUMNS.replace("knowledge_documents.", &format!("{table}."))
}

/// The `knowledge_folders` projection for the rendered table.
fn folder_columns(table: &str) -> String {
    FOLDER_COLUMNS.replace("knowledge_folders.", &format!("{table}."))
}

/// SQLAlchemy renders an expanding `IN` list as comma-separated literals.
fn join_ids(ids: &[i64]) -> String {
    ids.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// A server-side error means the recursive CTE was rejected (syntax or
/// unsupported feature). Pool, timeout and decoding failures are not
/// database errors, so they propagate like the source's connection errors.
fn is_unsupported_cte(error: &MysqlError) -> bool {
    matches!(error, MysqlError::Database { .. })
}

/// The MySQL-backed [`ScopeReader`].
pub struct MysqlScopeReader<'a, M: Mysql> {
    mysql: &'a M,
    tables: KnowledgeScopeTables,
}

impl<'a, M: Mysql> MysqlScopeReader<'a, M> {
    /// A reader over the shared knowledge tables.
    pub fn new(mysql: &'a M) -> Self {
        Self::with_tables(mysql, KnowledgeScopeTables::base())
    }

    /// A reader over a deployment's rendered table names.
    pub fn with_tables(mysql: &'a M, tables: KnowledgeScopeTables) -> Self {
        Self { mysql, tables }
    }
}

#[async_trait]
impl<M: Mysql> ScopeReader for MysqlScopeReader<'_, M> {
    async fn documents_by_ids(&self, ids: &[i64]) -> MysqlResult<Vec<ScopeDocument>> {
        // `_bulk_load_documents`'s range loop issues no statement for an empty
        // batch, so neither does the reader.
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(Debug, FromMysqlRow)]
        struct Row {
            knowledge_documents_id: i64,
            knowledge_documents_kind_id: i64,
        }
        let rows: Vec<Row> = self
            .mysql
            .fetch_all(documents_by_ids_statement(self.tables, ids), ())
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| ScopeDocument {
                id: row.knowledge_documents_id,
                kind_id: row.knowledge_documents_kind_id,
            })
            .collect())
    }

    async fn folders_by_ids(&self, knowledge_base_id: i64, ids: &[i64]) -> MysqlResult<Vec<i64>> {
        #[derive(Debug, FromMysqlRow)]
        struct Row {
            knowledge_folders_id: i64,
        }
        let rows: Vec<Row> = self
            .mysql
            .fetch_all(
                folders_by_ids_statement(self.tables, knowledge_base_id, ids),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| row.knowledge_folders_id)
            .collect())
    }

    async fn descendant_ids(
        &self,
        knowledge_base_id: i64,
        folder_id: i64,
    ) -> MysqlResult<Vec<i64>> {
        let result: MysqlResult<Vec<i64>> = self
            .mysql
            .fetch_all(
                descendants_statement(self.tables, knowledge_base_id, folder_id),
                (),
            )
            .await;
        match result {
            Ok(ids) => Ok(ids),
            Err(error) if is_unsupported_cte(&error) => {
                // `_collect_descendant_ids`'s ProgrammingError/OperationalError
                // fallback: a server that cannot run the recursive CTE answers
                // with a database error, so the BFS walk runs instead.
                tracing::warn!(
                    %error,
                    folder_id,
                    "recursive CTE unavailable; falling back to the iterative walk"
                );
                self.mysql
                    .fetch_all(
                        descendants_bfs_statement(self.tables, knowledge_base_id, &[folder_id]),
                        (),
                    )
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn documents_in_folders(
        &self,
        knowledge_base_id: i64,
        folder_ids: &[i64],
    ) -> MysqlResult<Vec<i64>> {
        self.mysql
            .fetch_all(
                folder_documents_statement(self.tables, knowledge_base_id, folder_ids),
                (),
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// In-memory [`ScopeReader`] that records the calls it receives.
    #[derive(Default)]
    struct FakeScopeReader {
        documents: HashMap<i64, i64>,
        folders: HashSet<i64>,
        descendants: HashMap<i64, Vec<i64>>,
        folder_documents: Vec<(i64, i64)>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeScopeReader {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
    }

    fn ids_string(ids: &[i64]) -> String {
        join_ids(ids)
    }

    #[async_trait]
    impl ScopeReader for FakeScopeReader {
        async fn documents_by_ids(&self, ids: &[i64]) -> MysqlResult<Vec<ScopeDocument>> {
            self.record(format!("documents:{}", ids_string(ids)));
            Ok(ids
                .iter()
                .filter_map(|id| {
                    self.documents.get(id).map(|kind_id| ScopeDocument {
                        id: *id,
                        kind_id: *kind_id,
                    })
                })
                .collect())
        }

        async fn folders_by_ids(
            &self,
            knowledge_base_id: i64,
            ids: &[i64],
        ) -> MysqlResult<Vec<i64>> {
            self.record(format!("folders:{knowledge_base_id}:{}", ids_string(ids)));
            Ok(ids
                .iter()
                .filter(|id| self.folders.contains(id))
                .copied()
                .collect())
        }

        async fn descendant_ids(
            &self,
            knowledge_base_id: i64,
            folder_id: i64,
        ) -> MysqlResult<Vec<i64>> {
            self.record(format!("descendants:{knowledge_base_id}:{folder_id}"));
            Ok(self
                .descendants
                .get(&folder_id)
                .cloned()
                .unwrap_or_default())
        }

        async fn documents_in_folders(
            &self,
            knowledge_base_id: i64,
            folder_ids: &[i64],
        ) -> MysqlResult<Vec<i64>> {
            self.record(format!(
                "folder_documents:{knowledge_base_id}:{}",
                ids_string(folder_ids)
            ));
            let mut documents: Vec<i64> = self
                .folder_documents
                .iter()
                .filter(|(folder_id, _)| folder_ids.contains(folder_id))
                .map(|(_, document_id)| *document_id)
                .collect();
            documents.sort_unstable();
            Ok(documents)
        }
    }

    fn request(
        folder_ids: Option<Vec<i64>>,
        document_ids: Option<Vec<i64>>,
        include_subfolders: bool,
    ) -> DocumentScopeRequest {
        DocumentScopeRequest {
            knowledge_base_id: 257464,
            user_id: 7,
            folder_ids,
            document_ids,
            include_subfolders,
        }
    }

    fn folder_tree_reader() -> FakeScopeReader {
        let mut reader = FakeScopeReader {
            folders: [10, 11, 12, 13].into_iter().collect(),
            folder_documents: vec![
                (10, 100),
                (10, 101),
                (11, 102),
                (12, 103),
                (13, 104),
                (20, 200),
            ],
            ..FakeScopeReader::default()
        };
        // `_collect_descendant_ids` returns the whole subtree, not one level.
        reader.descendants.insert(10, vec![11, 12, 13]);
        reader.descendants.insert(11, vec![13]);
        reader
    }

    /// Restricted scope with folder ids and the default `include_subfolders`:
    /// the named folder plus every descendant folder's documents, in document
    /// id order.
    #[tokio::test]
    async fn restricted_scope_with_folder_ids_resolves_the_subtree() {
        let reader = folder_tree_reader();
        let resolved = resolve_scope_ids(&reader, &request(Some(vec![10]), None, true))
            .await
            .unwrap();
        assert_eq!(resolved, vec![100, 101, 102, 103, 104]);
        assert_eq!(
            reader.calls(),
            vec![
                "folders:257464:10".to_string(),
                "descendants:257464:10".to_string(),
                "folder_documents:257464:10, 11, 12, 13".to_string(),
            ]
        );
    }

    /// `include_subfolders` changes the resolved set: the disabled walk never
    /// reads descendants and only the named folder's documents survive.
    #[tokio::test]
    async fn include_subfolders_false_reads_only_the_named_folder() {
        let reader = folder_tree_reader();
        let resolved = resolve_scope_ids(&reader, &request(Some(vec![10]), None, false))
            .await
            .unwrap();
        assert_eq!(resolved, vec![100, 101]);
        assert_eq!(
            reader.calls(),
            vec![
                "folders:257464:10".to_string(),
                "folder_documents:257464:10".to_string(),
            ]
        );
    }

    /// Explicit documents keep the request's first-seen order, deduplicate,
    /// and precede the folder documents they overlap.
    #[tokio::test]
    async fn explicit_documents_keep_request_order_and_precede_folder_documents() {
        let mut reader = folder_tree_reader();
        reader.documents.insert(105, 257464);
        reader.documents.insert(100, 257464);
        let resolved = resolve_scope_ids(
            &reader,
            &request(Some(vec![10]), Some(vec![105, 100, 105]), false),
        )
        .await
        .unwrap();
        assert_eq!(resolved, vec![105, 100, 101]);
    }

    /// An empty scope resolves no documents and performs no scope read.
    #[tokio::test]
    async fn empty_scope_resolves_no_documents_and_reads_nothing() {
        let reader = FakeScopeReader::default();
        let resolved = resolve_scope_ids(&reader, &request(None, None, true))
            .await
            .unwrap();
        assert!(resolved.is_empty());
        assert!(reader.calls().is_empty());
    }

    /// `folder_ids == [0]` addresses root-level documents: folder 0 is never
    /// validated against the folder table or expanded into a subtree.
    #[tokio::test]
    async fn root_only_folder_scope_reads_root_documents_without_expansion() {
        let reader = FakeScopeReader {
            folder_documents: vec![(0, 300), (10, 301)],
            ..FakeScopeReader::default()
        };
        let resolved = resolve_scope_ids(&reader, &request(Some(vec![0]), None, true))
            .await
            .unwrap();
        assert_eq!(resolved, vec![300]);
        assert_eq!(
            reader.calls(),
            vec!["folder_documents:257464:0".to_string()]
        );
    }

    /// A folder outside the knowledge base fails before any document read.
    #[tokio::test]
    async fn unknown_folder_raises_the_source_value_error() {
        let reader = folder_tree_reader();
        let error = resolve_scope_ids(&reader, &request(Some(vec![10, 99]), None, true))
            .await
            .unwrap_err();
        assert_eq!(error, ScopeResolutionError::FolderNotFound(99));
        assert_eq!(
            error.value_error_message().as_deref(),
            Some("Folder 99 not found in this knowledge base")
        );
        // Folder 10 is validated (and, with `include_subfolders`, expanded)
        // before the missing 99 is reported, like the source loop.
        assert_eq!(
            reader.calls(),
            vec![
                "folders:257464:10, 99".to_string(),
                "descendants:257464:10".to_string(),
            ]
        );
    }

    /// A missing document — or one owned by another knowledge base — raises.
    #[tokio::test]
    async fn documents_must_belong_to_the_knowledge_base() {
        let mut reader = FakeScopeReader::default();
        reader.documents.insert(100, 257464);
        reader.documents.insert(200, 999);
        let missing = resolve_scope_ids(&reader, &request(None, Some(vec![100, 404]), true))
            .await
            .unwrap_err();
        assert_eq!(missing, ScopeResolutionError::DocumentNotFound(404));
        let foreign = resolve_scope_ids(&reader, &request(None, Some(vec![200]), true))
            .await
            .unwrap_err();
        assert_eq!(foreign, ScopeResolutionError::DocumentNotFound(200));
        assert_eq!(
            foreign.value_error_message().as_deref(),
            Some("Document 200 not found in this knowledge base")
        );
    }

    /// The empty-list guards run before any read and keep the source's order:
    /// `folder_ids` is checked before `document_ids`.
    #[tokio::test]
    async fn empty_lists_are_rejected() {
        let reader = FakeScopeReader::default();
        assert_eq!(
            resolve_scope_ids(&reader, &request(Some(Vec::new()), None, true))
                .await
                .unwrap_err(),
            ScopeResolutionError::EmptyFolderIds
        );
        assert_eq!(
            resolve_scope_ids(&reader, &request(None, Some(Vec::new()), true))
                .await
                .unwrap_err(),
            ScopeResolutionError::EmptyDocumentIds
        );
        assert_eq!(
            resolve_scope_ids(&reader, &request(Some(Vec::new()), Some(Vec::new()), true))
                .await
                .unwrap_err(),
            ScopeResolutionError::EmptyFolderIds
        );
        assert!(reader.calls().is_empty());
    }

    /// `_bulk_load_documents` splits explicit ids into `_MAX_IN_CLAUSE_SIZE`
    /// batches.
    #[tokio::test]
    async fn explicit_documents_load_in_source_batches() {
        let mut reader = FakeScopeReader::default();
        let ids: Vec<i64> = (1..=MAX_IN_CLAUSE_SIZE as i64 + 1).collect();
        for id in &ids {
            reader.documents.insert(*id, 257464);
        }
        let resolved = resolve_scope_ids(&reader, &request(None, Some(ids.clone()), true))
            .await
            .unwrap();
        assert_eq!(resolved, ids);
        let calls = reader.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0],
            format!("documents:{}", ids_string(&ids[..MAX_IN_CLAUSE_SIZE]))
        );
        assert_eq!(
            calls[1],
            format!("documents:{}", ids_string(&ids[MAX_IN_CLAUSE_SIZE..]))
        );
    }

    /// The rendered statements carry the source's literals and SQLAlchemy
    /// labels for the shared tables.
    #[test]
    fn statements_render_the_source_queries() {
        let tables = KnowledgeScopeTables::base();
        assert_eq!(
            documents_by_ids_statement(tables, &[41418, 41419]),
            format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id IN (41418, 41419)"
            )
        );
        assert_eq!(
            folders_by_ids_statement(tables, 257464, &[10, 11]),
            format!(
                "SELECT {FOLDER_COLUMNS} \nFROM knowledge_folders \n\
                 WHERE knowledge_folders.kind_id = 257464 \
                 AND knowledge_folders.id IN (10, 11)"
            )
        );
        assert_eq!(
            folder_documents_statement(tables, 257464, &[0, 10]),
            "SELECT knowledge_documents.id AS knowledge_documents_id \n\
             FROM knowledge_documents \n\
             WHERE knowledge_documents.kind_id = 257464 \
             AND knowledge_documents.folder_id IN (0, 10) \
             ORDER BY knowledge_documents.id"
        );
        assert_eq!(
            descendants_bfs_statement(tables, 257464, &[10, 11]),
            "SELECT knowledge_folders.id AS knowledge_folders_id \n\
             FROM knowledge_folders \n\
             WHERE knowledge_folders.kind_id = 257464 \
             AND knowledge_folders.parent_id IN (10, 11)"
        );
    }

    /// A deployment-rendered template replaces every table reference and keeps
    /// the SQLAlchemy result labels.
    #[test]
    fn statements_render_deployment_templates() {
        let tables = KnowledgeScopeTables {
            folders: "{{folders}}",
            documents: "{{documents}}",
        };
        let statement = folder_documents_statement(tables, 7, &[3]);
        assert!(statement.contains("FROM {{documents}}"));
        assert!(statement.contains("WHERE {{documents}}.kind_id = 7"));
        assert!(statement.contains("AS knowledge_documents_id"));
        assert!(!statement.contains("knowledge_documents.id AS knowledge_documents_id"));

        let descendants = descendants_statement(tables, 7, 3);
        assert_eq!(descendants.matches("{{folders}}").count(), 2);
        assert!(descendants.contains("kind_id = 7"));
        assert!(descendants.contains("parent_id = 3"));
    }

    /// The MySQL reader issues the rendered statements through the handle.
    #[tokio::test]
    async fn mysql_reader_issues_the_rendered_statements() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let reader = MysqlScopeReader::new(&mysql);
        reader.documents_by_ids(&[1, 2]).await.unwrap();
        reader.folders_by_ids(7, &[3]).await.unwrap();
        reader.descendant_ids(7, 3).await.unwrap();
        reader.documents_in_folders(7, &[3]).await.unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 4);
        assert!(queries[0].sql.contains("knowledge_documents.id IN (1, 2)"));
        assert!(
            queries[1]
                .sql
                .contains("knowledge_folders.kind_id = 7 AND knowledge_folders.id IN (3)")
        );
        assert!(queries[2].sql.contains("WITH RECURSIVE descendants AS"));
        assert!(queries[3].sql.contains(
            "knowledge_documents.kind_id = 7 AND knowledge_documents.folder_id IN (3) \
                 ORDER BY knowledge_documents.id"
        ));
    }
}
