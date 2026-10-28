//! Current assignment nodes reuse the existing loop_items parent/type index.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlService, MysqlTransaction};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use super::assignments::{active_events, internal};
use super::loop_repository::{CommentRow, item_comments_query};
use crate::http_compat::FastApiError;
use crate::loop_node_storage;

#[cfg(test)]
#[path = "assignment_index_mysql_tests.rs"]
mod mysql_tests;

const INDEX_QUERY: &str =
    "SELECT id FROM loop_items WHERE id = ? AND resource_type = 'assignment_index'";

pub(super) fn index_id(kind: &str, id: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{kind}:{id}").as_bytes()))
}

#[derive(FromMysqlRow)]
struct IndexRow {
    #[allow(dead_code, reason = "presence-only lookup")]
    id: String,
}

pub(super) async fn ensure_active_index(
    mysql: &MysqlService,
    item_id: &str,
) -> Result<(), FastApiError> {
    let marker = index_id("assignment-index", item_id);
    let initialized: Option<IndexRow> = mysql
        .fetch_optional(INDEX_QUERY, (marker.as_str(),))
        .await
        .map_err(internal)?;
    if initialized.is_some() {
        return Ok(());
    }
    // Legacy Issues are initialized once, under the same lock as assignment changes.
    // The normal path above and all subsequent receipt requests use only indexed reads.
    let exists = mysql
        .with_transaction(async |tx| initialize_index(tx, item_id, &marker).await)
        .await
        .map_err(internal)?;
    if exists {
        Ok(())
    } else {
        Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Issue not found",
        ))
    }
}

async fn initialize_index<T: MysqlTransaction>(
    tx: &mut T,
    item_id: &str,
    marker: &str,
) -> MysqlResult<bool> {
    let issue: Option<IndexRow> = tx
        .fetch_optional(
            "SELECT id FROM loop_items WHERE id = ? AND resource_type = 'task' FOR UPDATE",
            (item_id,),
        )
        .await?;
    if issue.is_none() {
        return Ok(false);
    }
    let initialized: Option<IndexRow> = tx
        .fetch_optional(format!("{INDEX_QUERY} FOR UPDATE"), (marker,))
        .await?;
    if initialized.is_some() {
        return Ok(true);
    }
    let comments: Vec<CommentRow> = tx
        .fetch_all(format!("{} FOR UPDATE", item_comments_query()), (item_id,))
        .await?;
    let required = loop_node_storage::required_columns(tx).await?;
    let (marker_insert, assignment_insert) = index_insert_statements(&required);
    for (position, event) in active_events(&comments).into_iter().enumerate() {
        tx.execute(
            &assignment_insert,
            (
                index_id("active-assignment", &event.comment.id),
                item_id,
                position as i64,
                event.comment.id.as_str(),
            ),
        )
        .await?;
    }
    tx.execute(&marker_insert, (marker, item_id, 0i64)).await?;
    Ok(true)
}

fn index_insert_statements(required: &HashSet<String>) -> (String, String) {
    let mut columns = vec![
        "id",
        "resource_type",
        "parent_id",
        "description",
        "version",
        "sort_order",
        "project_space",
        "assignee_agent_id",
        "next_item_number",
        "created_at",
        "updated_at",
    ];
    let mut values = vec![
        "?",
        "'assignment_index'",
        "?",
        "''",
        "1",
        "?",
        "'default'",
        "''",
        "1",
        "UTC_TIMESTAMP()",
        "UTC_TIMESTAMP()",
    ];
    let marker = loop_node_storage::insert_sql(&columns, &values, required);
    columns.push("loop_item_id");
    values.push("?");
    let assignment = loop_node_storage::insert_sql(&columns, &values, required);
    (marker, assignment)
}
