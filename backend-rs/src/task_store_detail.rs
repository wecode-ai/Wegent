// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Packet-safe task-detail documents shared by task-store implementations.
//!
//! Large task and subtask JSON values are compressed in MySQL, split into
//! bounded result rows, and reassembled before decoding. Keeping every result
//! cell below the transport boundary avoids depending on one multi-megabyte
//! MySQL value while preserving the complete stored document.

use std::collections::HashMap;

use brz_json::OpaqueJson;
use brz_mysql::{MysqlResult, MysqlRow};

/// Each MySQL result cell stays comfortably below the observed multi-megabyte
/// transport boundary. The 256 generated indexes support up to 128 MiB of
/// compressed JSON and fail closed through the declared-length check beyond
/// that bound.
pub(crate) const JSON_CHUNK_BYTES: usize = 512 * 1024;

const TASK_DETAIL_INNER_PROJECTION: &str = "id, user_id, kind, name, namespace, \
COMPRESS(CAST(json AS CHAR CHARACTER SET utf8mb4)) AS json_compressed, is_active, \
created_at, updated_at, project_id, client_origin, is_group_chat";

const TASK_DETAIL_OUTER_PROJECTION: &str = "task_payload.id, task_payload.user_id, \
task_payload.kind, task_payload.name, task_payload.namespace, task_payload.is_active, \
task_payload.created_at, task_payload.updated_at, task_payload.project_id, \
task_payload.client_origin, task_payload.is_group_chat";

const SUBTASK_DETAIL_INNER_PROJECTION: &str = "id, user_id, task_id, team_id, title, bot_ids, \
`role`, executor_namespace, executor_name, executor_deleted_at, prompt, message_id, parent_id, \
status, progress, COMPRESS(CAST(result AS CHAR CHARACTER SET utf8mb4)) AS result_compressed, \
error_message, created_at, updated_at, completed_at, sender_type, sender_user_id, \
reply_to_subtask_id";

const SUBTASK_DETAIL_OUTER_PROJECTION: &str = "subtask_payload.id, subtask_payload.user_id, \
subtask_payload.task_id, subtask_payload.team_id, subtask_payload.title, \
subtask_payload.bot_ids, subtask_payload.`role`, subtask_payload.executor_namespace, \
subtask_payload.executor_name, subtask_payload.executor_deleted_at, subtask_payload.prompt, \
subtask_payload.message_id, subtask_payload.parent_id, subtask_payload.status, \
subtask_payload.progress, subtask_payload.error_message, subtask_payload.created_at, \
subtask_payload.updated_at, subtask_payload.completed_at, subtask_payload.sender_type, \
subtask_payload.sender_user_id, subtask_payload.reply_to_subtask_id";

/// One detail task row plus its reassembled JSON document.
#[derive(Debug)]
pub struct TaskDocumentRow {
    pub row: MysqlRow,
    pub json: OpaqueJson,
}

/// One ordered subtask row plus its reassembled optional result document.
#[derive(Debug)]
pub struct SubtaskDocumentRow {
    pub row: MysqlRow,
    pub result: Option<OpaqueJson>,
}

fn chunk_indexes_statement() -> String {
    let digit = (0..16)
        .map(|value| format!("SELECT {value} AS n"))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    format!(
        "SELECT low.n + high.n * 16 AS chunk_index \
         FROM ({digit}) AS low CROSS JOIN ({digit}) AS high"
    )
}

fn chunked_task_statement(inner: String) -> String {
    let indexes = chunk_indexes_statement();
    format!(
        "SELECT {TASK_DETAIL_OUTER_PROJECTION}, chunks.chunk_index, \
         OCTET_LENGTH(task_payload.json_compressed) AS json_compressed_bytes, \
         SUBSTRING(task_payload.json_compressed, \
                   chunks.chunk_index * {JSON_CHUNK_BYTES} + 1, {JSON_CHUNK_BYTES}) AS json_chunk \
         FROM ({inner}) AS task_payload \
         JOIN ({indexes}) AS chunks \
           ON chunks.chunk_index * {JSON_CHUNK_BYTES} \
              < OCTET_LENGTH(task_payload.json_compressed) \
         ORDER BY chunks.chunk_index"
    )
}

/// `task_store.get_by_id` restricted to one owner. The `LIMIT` forces MySQL
/// to materialize the compressed value once before the outer chunk join.
pub fn task_by_id_owned_statement(table: &str) -> String {
    chunked_task_statement(format!(
        "SELECT {TASK_DETAIL_INNER_PROJECTION} \
         FROM {table} WHERE id = ? AND user_id = ? LIMIT 1"
    ))
}

/// `task_store.get_active_non_deleted_task` before the Rust deletion filter.
pub fn active_task_by_id_statement(
    table: &str,
    json_delete_filter: bool,
    client_origin: bool,
) -> String {
    let mut inner = format!(
        "SELECT {TASK_DETAIL_INNER_PROJECTION} \
         FROM {table} WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)"
    );
    if json_delete_filter {
        inner.push_str(" AND JSON_EXTRACT(json, '$.status.status') != 'DELETE'");
    }
    if client_origin {
        inner.push_str(" AND client_origin = ?");
    }
    inner.push_str(" LIMIT 1");
    chunked_task_statement(inner)
}

/// `subtask_store.list_by_task_ordered`. The maximum unsigned `LIMIT` keeps
/// the inner result materialized so each document is compressed once, while
/// the outer join emits one bounded cell per chunk. A NULL result keeps one
/// row with a NULL chunk.
pub fn subtasks_by_message_ordered_statement(table: &str) -> String {
    let indexes = chunk_indexes_statement();
    format!(
        "SELECT {SUBTASK_DETAIL_OUTER_PROJECTION}, chunks.chunk_index, \
         OCTET_LENGTH(subtask_payload.result_compressed) AS result_compressed_bytes, \
         SUBSTRING(subtask_payload.result_compressed, \
                   chunks.chunk_index * {JSON_CHUNK_BYTES} + 1, {JSON_CHUNK_BYTES}) AS result_chunk \
         FROM (SELECT {SUBTASK_DETAIL_INNER_PROJECTION} \
               FROM {table} WHERE task_id = ? \
               ORDER BY message_id ASC, created_at ASC \
               LIMIT 18446744073709551615) AS subtask_payload \
         JOIN ({indexes}) AS chunks \
           ON (subtask_payload.result_compressed IS NULL AND chunks.chunk_index = 0) \
           OR chunks.chunk_index * {JSON_CHUNK_BYTES} \
              < OCTET_LENGTH(subtask_payload.result_compressed) \
         ORDER BY subtask_payload.message_id ASC, subtask_payload.created_at ASC, \
                  chunks.chunk_index ASC"
    )
}

/// Reassemble the one task document returned by a chunked task statement.
pub fn task_document_from_chunks(rows: Vec<MysqlRow>) -> MysqlResult<Option<TaskDocumentRow>> {
    if rows.is_empty() {
        return Ok(None);
    }
    let json = crate::json_compat::mysql_compressed_json_chunks(
        &rows,
        "json_chunk",
        "json_compressed_bytes",
    )?
    .ok_or_else(|| brz_mysql::MysqlError::UnexpectedNull {
        column: "json_chunk".to_string(),
    })?;
    let row = rows.into_iter().next().expect("rows are non-empty");
    Ok(Some(TaskDocumentRow { row, json }))
}

/// Group the chunk rows by subtask id, preserving the first-seen subtask
/// order, and reassemble each optional result document.
pub fn subtask_documents_from_chunks(rows: Vec<MysqlRow>) -> MysqlResult<Vec<SubtaskDocumentRow>> {
    let mut groups: Vec<Vec<MysqlRow>> = Vec::new();
    let mut group_by_id: HashMap<i64, usize> = HashMap::new();
    for row in rows {
        let id = row.get_required::<i64>("id")?;
        let group_index = match group_by_id.get(&id).copied() {
            Some(index) => index,
            None => {
                let index = groups.len();
                groups.push(Vec::new());
                group_by_id.insert(id, index);
                index
            }
        };
        groups[group_index].push(row);
    }

    groups
        .into_iter()
        .map(|group| {
            let result = crate::json_compat::mysql_compressed_json_chunks(
                &group,
                "result_chunk",
                "result_compressed_bytes",
            )?;
            let row = group.into_iter().next().expect("groups are non-empty");
            Ok(SubtaskDocumentRow { row, result })
        })
        .collect()
}
