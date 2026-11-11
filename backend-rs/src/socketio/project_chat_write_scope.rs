//! Lock the current Thread owner before writing messages or their runtime markers.
use brz_mysql::{MysqlResult, MysqlTransaction};
use serde_json::Value;

use crate::background_jobs::project::store::{self, Node};
use crate::socketio::project_chat_events::ack_error;

pub(super) async fn lock(
    tx: &mut impl MysqlTransaction,
    project_id: &str,
    task_id: Option<&str>,
) -> MysqlResult<Result<Option<Node>, Value>> {
    let Some(task_id) = task_id.filter(|id| !id.is_empty()) else {
        return Ok(Ok(None));
    };
    let item = store::locked_live_existing(tx, "task", task_id).await?;
    if let Some(item) = item {
        if item.cloud_project_id == project_id {
            return Ok(Ok(Some(item)));
        }
    } else {
        let project: Option<Node> = tx
            .fetch_optional(
                format!(
                    "SELECT {} FROM loop_items WHERE id=? AND resource_type='project' AND {}",
                    store::COLUMNS,
                    store::LIVE
                ),
                (project_id,),
            )
            .await?;
        if project.is_some_and(|project| {
            matches!(
                project.meta()["task_provider"].as_str(),
                Some("github" | "gitlab")
            )
        }) {
            return Ok(Ok(None));
        }
    }
    Ok(Err(ack_error(
        "SCOPE_NOT_FOUND",
        "The Thread is no longer available in this project",
    )))
}
