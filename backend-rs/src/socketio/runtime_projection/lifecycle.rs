// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{MysqlResult, MysqlTransaction};

use super::ExecutionRow;
use crate::background_jobs::project::{notifications, store};
use crate::socketio::{project_chat_snapshot, runtime::SocketRuntime};
use crate::state::AppState;

pub(in crate::socketio) async fn item_version(
    tx: &mut impl MysqlTransaction,
    execution: Option<&ExecutionRow>,
) -> MysqlResult<Option<i64>> {
    let Some(id) = execution
        .and_then(|row| row.loop_item_id.as_deref())
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let row: Option<brz_mysql::MysqlRow> = tx
        .fetch_optional(
            "SELECT version FROM loop_items WHERE id=? AND resource_type='task'",
            (id,),
        )
        .await?;
    row.map(|row| row.get_required("version")).transpose()
}

pub(in crate::socketio) struct Effects {
    pub(in crate::socketio) matched: Option<ExecutionRow>,
    pub(in crate::socketio) changed: bool,
    pub(in crate::socketio) detail: String,
    pub(in crate::socketio) messages: Vec<super::Message>,
    pub(in crate::socketio) settled_reply: Option<(String, i64)>,
}

impl Effects {
    pub(in crate::socketio) async fn deliver(self, state: &AppState, runtime: &SocketRuntime) {
        if let Some((issue_id, owner)) = self.settled_reply {
            project_chat_snapshot::publish_item_change_with_reason(
                state,
                runtime,
                &issue_id,
                owner,
                "human_reply_accepted",
            )
            .await;
        }
        for message in self.messages {
            let projected = super::Projected {
                message: super::projected_view(&message),
                delta: false,
                terminal_activity: None,
            };
            crate::socketio::device_runtime_event::emit_project_chat(state, runtime, &projected)
                .await;
        }
        let Some(execution) = self.matched else {
            return;
        };
        let Some(issue_id) = execution
            .loop_item_id
            .as_deref()
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        let owner = execution.executor_owner_user_id.unwrap_or(0);
        if self.changed {
            project_chat_snapshot::publish_item_change_with_reason(
                state,
                runtime,
                issue_id,
                owner,
                "runtime_execution_status",
            )
            .await;
        }
        if !execution.is_terminal() {
            return;
        }
        let result = state
            .mysql
            .with_transaction(async |tx| {
                let issue: Option<store::Node> = tx
                    .fetch_optional(
                        format!(
                            "SELECT {} FROM loop_items WHERE id=? AND resource_type='task'",
                            store::COLUMNS
                        ),
                        (issue_id,),
                    )
                    .await?;
                let Some(issue) = issue else { return Ok(None) };
                let project: Option<store::Node> = tx
                    .fetch_optional(
                        format!(
                            "SELECT {} FROM loop_items WHERE id=? AND resource_type='project'",
                            store::COLUMNS
                        ),
                        (issue.cloud_project_id.as_str(),),
                    )
                    .await?;
                let Some(project) = project else {
                    return Ok(None);
                };
                notifications::execution_on(
                    tx,
                    state,
                    &project,
                    &issue,
                    execution.id,
                    owner,
                    execution.status_or_empty(),
                    &self.detail,
                )
                .await
            })
            .await;
        match result {
            Ok(Some(pending)) => notifications::deliver(state, pending).await,
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, execution_id = execution.id, "Runtime execution lifecycle notification failed")
            }
        }
    }
}
