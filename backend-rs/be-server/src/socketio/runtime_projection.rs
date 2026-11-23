// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind committed Runtime projections to Issue automation and Socket.IO effects.

use brz_mysql::{MysqlResult, MysqlTransaction as _, MysqlTransactionService};
use wegent_project_coordination::project_chat_message::Message;
use wegent_runtime_execution::ProjectionActivities;
use wegent_runtime_execution::runtime_projection as projection;

use super::{project_chat_snapshot, runtime::SocketRuntime};
use crate::background_jobs::project::{notifications, store};
use crate::background_jobs::robot;
use crate::state::AppState;

use projection::lifecycle::Effects;
#[cfg(test)]
pub(super) use projection::verify_restored_activity_timestamp;
pub(super) use projection::{
    Projected, RuntimeIdentity, execution_for_runtime, lifecycle, open_accepted_activity,
    owned_identity_ids, reload_execution,
};

pub(super) struct ProjectActivities;

#[async_trait::async_trait]
impl ProjectionActivities<MysqlTransactionService> for ProjectActivities {
    async fn start(
        &self,
        tx: &mut MysqlTransactionService,
        message: &mut Message,
        owner: Option<i64>,
    ) -> MysqlResult<()> {
        robot::start_runtime_activity(tx, message, owner).await
    }

    async fn finish(
        &self,
        tx: &mut MysqlTransactionService,
        message: &mut Message,
        status: &str,
        detail: &str,
    ) -> MysqlResult<()> {
        robot::finish_runtime_activity(tx, message, status, detail).await
    }
}

pub(super) async fn project(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<Projected>> {
    let (projected, effects) = projection::project(
        &state.mysql,
        &ProjectActivities,
        user_id,
        device_id,
        identity,
    )
    .await?;
    super::runtime_projection_metrics::record(effects.matched.as_ref(), identity);
    deliver(effects, state, runtime).await;
    Ok(projected)
}

pub(super) async fn write_back_execution_event(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<()> {
    if let Some(effects) = projection::write_back_execution_event(
        &state.mysql,
        &ProjectActivities,
        user_id,
        device_id,
        identity,
    )
    .await?
    {
        deliver(effects, state, runtime).await;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn verify_late_human_reply_projection(
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    projection::verify_late_human_reply_projection(mysql, &ProjectActivities).await
}

pub(super) async fn deliver(effects: Effects, state: &AppState, runtime: &SocketRuntime) {
    if let Some((issue_id, owner)) = effects.settled_reply {
        project_chat_snapshot::publish_item_change_with_reason(
            state,
            runtime,
            &issue_id,
            owner,
            "human_reply_accepted",
        )
        .await;
    }
    for message in effects.messages {
        let projected = Projected {
            message: projection::projected_view(&message),
            delta: false,
            terminal_activity: None,
        };
        crate::socketio::device_runtime_event::emit_project_chat(state, runtime, &projected).await;
    }
    let Some(execution) = effects.matched else {
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
    if effects.changed {
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
                &state.mysql,
                &project,
                &issue,
                execution.id,
                owner,
                execution.status_or_empty(),
                &effects.detail,
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
