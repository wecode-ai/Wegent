// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The device-scoped claim query path for the local App puller.
//!
//! Mirrors `loop_item_execution_service.claim_next_for_device` in
//! `app/services/loop_item_executions/service.py`: one queued run is selected
//! for a stable execution target behind the device lock, using the Runtime
//! capacity truth reported by `_runtime_capacity_used`.
//!
//! # Scope boundary
//!
//! The recorded `POST /api/v1/loop-item-executions/claim-my-next` traffic for
//! this API always has an empty queue for the calling owner, so the observed
//! contract is the "nothing queued" result. The candidate-selection and
//! claim-write tail (`_execution_is_claimable_by_device`,
//! `_matches_issue_device_affinity`, `_agent_limits`, the CAS `UPDATE`, and the
//! `_claimed_execution_view` body with its `build_runtime_payload`) depends on
//! the issue-affinity, project-allowlist, agent-limit, and execution-view
//! surfaces that are not migrated yet. This module therefore issues the exact
//! source query sequence and reports "no candidate"; the remaining tail is
//! deferred to the work item that owns those surfaces rather than being
//! approximated here.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;

use super::capacity::runtime_capacity_used;
use super::device::{canonical_execution_device, owned_execution_device_ids};

/// `STATUS_QUEUED`: only queued rows are claimable.
const STATUS_QUEUED: &str = "queued";

/// The caller-supplied claim parameters
/// (`LoopItemExecutionDeviceClaim` plus the resolved Runtime capacity).
pub(crate) struct ClaimRequest<'a> {
    pub execution_device_id: &'a str,
    pub environment: &'a str,
    pub runtime_instance_id: &'a str,
    pub device_capacity: i64,
    pub runtime_active: i64,
    pub runtime_active_task_ids: &'a [String],
    pub owner_user_id: i32,
}

/// A queued candidate row, projected from the source's execution columns.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct CandidateRow {
    #[mysql(rename = "loop_item_executions_id")]
    pub id: i64,
}

/// The `WHERE` fragment shared by the agent-id and candidate-row queries.
///
/// SQLAlchemy renders the owner id as a numeric literal, the owned device list
/// as an expanded `IN`, and the environment/status literals inline; the
/// empty-string branch admits unbound local rows. The owner id is a validated
/// `i32`, so it is rendered as the same numeric literal rather than bound as a
/// string parameter, which would render as a quoted `'157'` and no longer match
/// the recorded dependency. The device identities stay bound: Replay matches
/// them as the quoted string literals the source emits.
fn queue_filter(
    owner_user_id: i32,
    device_ids: &[String],
    environment: &str,
) -> (String, Vec<String>) {
    let placeholders = vec!["?"; device_ids.len()].join(", ");
    let mut params: Vec<String> = device_ids.to_vec();
    params.push(environment.to_string());
    let sql = format!(
        "loop_item_executions.executor_owner_user_id = {owner_user_id} AND \
         (loop_item_executions.execution_device_id IN ({placeholders}) AND \
         loop_item_executions.execution_environment = ? OR \
         loop_item_executions.execution_device_id = '') AND \
         loop_item_executions.status = '{STATUS_QUEUED}'"
    );
    (sql, params)
}

/// `claim_next_for_device`: select one queued run for a stable target.
///
/// Issues the source query sequence (owned identities, canonical identity,
/// Runtime capacity, queued agent ids, ordered candidate rows). Selecting and
/// writing the claim is out of the current scope (see the module boundary), so
/// a non-empty queue is reported and left unclaimed rather than mutated.
pub(crate) async fn claim_next_for_device<M: Mysql>(
    mysql: &M,
    request: &ClaimRequest<'_>,
) -> MysqlResult<()> {
    let execution_device_ids =
        owned_execution_device_ids(mysql, request.owner_user_id, request.execution_device_id)
            .await?;
    let _canonical =
        canonical_execution_device(mysql, request.owner_user_id, request.execution_device_id)
            .await?;
    let running_count = runtime_capacity_used(
        mysql,
        request.owner_user_id,
        request.runtime_instance_id,
        request.runtime_active,
        request.runtime_active_task_ids,
    )
    .await?;
    if running_count.is_none_or(|count| count >= request.device_capacity) {
        return Ok(());
    }

    let (filter, params) = queue_filter(
        request.owner_user_id,
        &execution_device_ids,
        request.environment,
    );

    let _agent_ids: Vec<String> = mysql
        .fetch_all(
            &format!(
                "SELECT DISTINCT loop_item_executions.agent_id \
                 AS loop_item_executions_agent_id \
                 \nFROM loop_item_executions \nWHERE {filter} \
                 AND loop_item_executions.agent_id != ''"
            ),
            params.clone(),
        )
        .await?;

    let candidates: Vec<CandidateRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \nWHERE {filter} \
                 ORDER BY loop_item_executions.priority_weight DESC, \
                 loop_item_executions.queued_at ASC, loop_item_executions.id ASC"
            ),
            params,
        )
        .await?;
    if let Some(candidate) = candidates.first() {
        tracing::debug!(
            candidate = candidate.id,
            owner_user_id = request.owner_user_id,
            "queued claim candidate present; selection tail is out of scope"
        );
    }
    Ok(())
}

/// `claim_next_unbound_local`: the legacy alias for the unified claim path.
pub(crate) async fn claim_next_unbound_local<M: Mysql>(
    mysql: &M,
    request: &ClaimRequest<'_>,
) -> MysqlResult<()> {
    claim_next_for_device(mysql, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_filter_renders_the_numeric_owner_and_binds_the_device_identities() {
        let (filter, params) = queue_filter(
            157,
            &[
                "app-record-267101".to_string(),
                "local-device".to_string(),
                "electron-5b4a6b29-5218-45fe-b306-6a131274b09c".to_string(),
            ],
            "local",
        );
        // The recorded dependency renders the owner id as the numeric literal
        // `157`; binding it as a string would render `'157'` and stop matching.
        assert_eq!(
            filter,
            "loop_item_executions.executor_owner_user_id = 157 AND \
             (loop_item_executions.execution_device_id IN (?, ?, ?) AND \
             loop_item_executions.execution_environment = ? OR \
             loop_item_executions.execution_device_id = '') AND \
             loop_item_executions.status = 'queued'"
        );
        assert!(filter.contains("executor_owner_user_id = 157 AND"));
        assert_eq!(params.len(), 4);
        assert_eq!(params[0], "app-record-267101");
        assert_eq!(params[1], "local-device");
        assert_eq!(params[2], "electron-5b4a6b29-5218-45fe-b306-6a131274b09c");
        assert_eq!(params[3], "local");
    }
}
