// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlError, MysqlRow, MysqlTransaction};

use super::models::{ArtifactResponse, CONTEXT_TYPE, DeclareRequest, Metadata, Source, response};
use crate::http_compat::FastApiError;
use crate::state::AppState;

#[derive(FromMysqlRow)]
pub(super) struct Subtask {
    pub role: String,
    executor_name: Option<String>,
    executor_namespace: Option<String>,
}

impl Subtask {
    pub(super) fn source(self, workspace_binding_id: String) -> Result<Source, FastApiError> {
        Ok(Source {
            executor_name: self
                .executor_name
                .filter(|name| !name.is_empty())
                .ok_or_else(executor_binding_missing)?,
            executor_namespace: self.executor_namespace.unwrap_or_default(),
            workspace_root: String::new(),
            workspace_binding_id,
        })
    }
}

pub(super) async fn owned_subtask(
    state: &AppState,
    subtask_id: i64,
    task_id: i64,
    user_id: i64,
) -> Result<Option<Subtask>, FastApiError> {
    // A declaration can immediately follow dispatch. Read the committed
    // executor binding on the writer even when the replica is behind.
    let table = state.task_store.table_templates().subtasks;
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    mysql
        .with_transaction(async |tx| {
            tx.fetch_optional(
                format!(
                    "SELECT role, executor_name, executor_namespace FROM {table} \
                     WHERE id = ? AND task_id = ? AND user_id = ?"
                ),
                (subtask_id, task_id, user_id),
            )
            .await
        })
        .await
        .map_err(super::internal)
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct ContextRow {
    pub id: i64,
    pub subtask_id: i64,
    pub type_data: Json<Metadata>,
}

pub(super) async fn context<M: Mysql>(
    mysql: &M,
    context_id: i64,
    user_id: i64,
) -> Result<Option<ContextRow>, FastApiError> {
    mysql
        .fetch_optional(
            "SELECT id, subtask_id, type_data FROM subtask_contexts \
         WHERE id = ? AND user_id = ? AND context_type = ? LIMIT 1",
            (context_id, user_id, CONTEXT_TYPE),
        )
        .await
        .map_err(super::internal)
}

pub(super) fn validate_original_source(
    previous: Option<&Source>,
    authoritative: &Source,
) -> Result<(), FastApiError> {
    // A resumed execution can renew its verified Task Token and native proof.
    // Refresh that proof without allowing the original physical source to move.
    if !previous.is_some_and(|original| {
        original.executor_name == authoritative.executor_name
            && original.executor_namespace == authoritative.executor_namespace
            && original.workspace_root == authoritative.workspace_root
    }) {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Artifact execution source cannot change",
        ));
    }
    Ok(())
}

pub(super) async fn declare<M: Mysql>(
    mysql: &M,
    subtask_id: i64,
    task_id: i64,
    user_id: i64,
    source: Source,
    request: DeclareRequest,
) -> Result<ArtifactResponse, FastApiError> {
    // The stable owner row serializes metadata-only declarations across backend
    // replicas, including the first declaration before a context row exists.
    // File reads and device RPC never run while this short lock is held.
    mysql
        .with_transaction(async |transaction| {
            let owner: Option<MysqlRow> = transaction
                .fetch_optional("SELECT id FROM users WHERE id = ? FOR UPDATE", (user_id,))
                .await?;
            if owner.is_none() {
                return Ok::<_, MysqlError>(Err(super::not_found()));
            }
            let contexts: Vec<ContextRow> = transaction
                .fetch_all(
                    "SELECT id, subtask_id, type_data FROM subtask_contexts \
             WHERE subtask_id = ? AND user_id = ? AND context_type = ? FOR UPDATE",
                    (subtask_id, user_id, CONTEXT_TYPE),
                )
                .await?;
            let existing = contexts
                .into_iter()
                .find(|context| context.type_data.0.relative_path == request.relative_path);
            if let Some(context) = existing.as_ref()
                && let Err(error) =
                    validate_original_source(context.type_data.0.source.as_ref(), &source)
            {
                return Ok(Err(error));
            }
            let extension = std::path::Path::new(&request.relative_path)
                .extension()
                .map(|extension| format!(".{}", extension.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            let metadata = Metadata {
                task_id,
                relative_path: request.relative_path.clone(),
                file_extension: extension,
                file_size: request.file_size,
                mime_type: request.mime_type.clone(),
                modified_at: request.modified_at,
                sha256: request.sha256.clone(),
                source: Some(source.clone()),
            };
            let serialized =
                serde_json::to_string(&metadata).expect("artifact metadata serializes");
            let id = if let Some(context) = existing {
                transaction.execute(
                "UPDATE subtask_contexts SET name = ?, status = 'ready', error_message = '', \
                 type_data = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?",
                (request.name.as_str(), serialized.as_str(), context.id, user_id),
            ).await?;
                context.id
            } else {
                transaction
                    .execute(
                        "INSERT INTO subtask_contexts \
                 (subtask_id, user_id, context_type, name, status, binary_data, image_base64, \
                  extracted_text, text_length, error_message, type_data, created_at, updated_at) \
                 VALUES (?, ?, 'remote_workspace_artifact', ?, 'ready', X'', '', '', 0, '', \
                  ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
                        (
                            subtask_id,
                            user_id,
                            request.name.as_str(),
                            serialized.as_str(),
                        ),
                    )
                    .await?
                    .last_insert_id as i64
            };
            Ok(Ok(response(id, subtask_id, request.name.clone(), metadata)))
        })
        .await
        .map_err(super::internal)?
}

fn executor_binding_missing() -> FastApiError {
    FastApiError::json_body(
        StatusCode::CONFLICT,
        serde_json::json!({
            "detail": "Artifact execution source is unavailable",
            "code": "executor_binding_missing",
        }),
    )
}

pub(super) fn source_unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::CONFLICT,
        "Artifact execution source is unavailable",
    )
}
