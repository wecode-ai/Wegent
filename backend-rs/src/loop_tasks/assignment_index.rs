//! Current assignment nodes reuse the existing loop_items parent/type index.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, MysqlTransaction};
use sha2::{Digest, Sha256};

use super::assignments::{active_events, internal};
use super::loop_repository::{CommentRow, item_comments_query};
use crate::{http_compat::FastApiError, state::AppState};

pub(super) fn index_id(kind: &str, id: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{kind}:{id}").as_bytes()))
}

#[derive(FromMysqlRow)]
struct IndexRow {
    #[allow(dead_code, reason = "presence-only lookup")]
    id: String,
}

pub(super) async fn ensure_active_index(
    state: &AppState,
    item_id: &str,
) -> Result<(), FastApiError> {
    let marker = index_id("assignment-index", item_id);
    let query = "SELECT id FROM loop_items WHERE id = ? AND resource_type = 'assignment_index'";
    let initialized: Option<IndexRow> = state
        .mysql
        .fetch_optional(query, (marker.as_str(),))
        .await
        .map_err(internal)?;
    if initialized.is_some() {
        return Ok(());
    }
    // Legacy Issues are initialized once, under the same lock as assignment changes.
    // The normal path above and all subsequent receipt requests use only indexed reads.
    let exists = state.mysql.with_transaction(async |tx| {
        let issue: Option<IndexRow> = tx.fetch_optional("SELECT id FROM loop_items WHERE id = ? AND resource_type = 'task' FOR UPDATE", (item_id,)).await?;
        if issue.is_none() { return Ok(false); }
        let initialized: Option<IndexRow> = tx.fetch_optional(format!("{query} FOR UPDATE"), (marker.as_str(),)).await?;
        if initialized.is_some() { return Ok(true); }
        let comments: Vec<CommentRow> = tx.fetch_all(format!("{} FOR UPDATE", item_comments_query()), (item_id,)).await?;
        let insert = "INSERT INTO loop_items (id,resource_type,parent_id,loop_item_id,description,version,sort_order,project_space,assignee_agent_id,created_at,updated_at) VALUES (?,'assignment_index',?,?,'',1,?,'default','',UTC_TIMESTAMP(),UTC_TIMESTAMP())";
        for (position, event) in active_events(&comments).into_iter().enumerate() {
            tx.execute(insert, (index_id("active-assignment", &event.comment.id), item_id, Some(event.comment.id.as_str()), position as i64)).await?;
        }
        tx.execute(insert, (marker.as_str(), item_id, None::<&str>, 0i64)).await?;
        Ok(true)
    }).await.map_err(internal)?;
    if exists {
        Ok(())
    } else {
        Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Issue not found",
        ))
    }
}
