//! Source ownership for Issue questions, independent of routing authority.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql};

use super::{error, internal};
use crate::http_compat::FastApiError;

pub(super) async fn owned_devices<M: Mysql>(
    mysql: &M,
    user: i64,
    device: &str,
) -> Result<Vec<String>, FastApiError> {
    use crate::device_identity::{
        DeviceKindRow, KINDS_DEVICE_QUERY, resolve_device_alias, unambiguous_device_identity_ids,
    };
    let devices: Vec<DeviceKindRow> = mysql
        .fetch_all(KINDS_DEVICE_QUERY, (user,))
        .await
        .map_err(internal)?;
    // General alias expansion retains unknown addresses and cannot prove ownership.
    if resolve_device_alias(&devices, device).is_none() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Question device is not owned by the caller",
        ));
    }
    Ok(unambiguous_device_identity_ids(&devices, device))
}

pub(super) struct RuntimeEvidence<'a> {
    pub execution_id: Option<i64>,
    pub project_id: &'a str,
    pub issue_id: &'a str,
    pub device_id: &'a str,
    pub task_id: &'a str,
}

pub(super) async fn require_runtime<M: Mysql>(
    mysql: &M,
    user: i64,
    evidence: RuntimeEvidence<'_>,
    aliases: &[String],
) -> Result<i64, FastApiError> {
    let execution_id = evidence.execution_id.filter(|id| *id > 0).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Issue activity has no recorded execution authority",
        )
    })?;
    #[derive(FromMysqlRow)]
    struct Execution {
        executor_owner_user_id: i64,
        runtime_device_id: Option<String>,
        runtime_task_id: Option<String>,
    }
    let execution: Option<Execution> = mysql.fetch_optional(
        "SELECT executor_owner_user_id,runtime_device_id,runtime_task_id FROM loop_item_executions WHERE id=? AND cloud_project_id=? AND loop_item_id=?",
        (execution_id,evidence.project_id,evidence.issue_id),
    ).await.map_err(internal)?;
    let execution = execution.ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Original Issue execution is unavailable",
        )
    })?;
    if execution.executor_owner_user_id != user {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Question Runtime is not owned by the caller",
        ));
    }
    if execution.runtime_task_id.as_deref() != Some(evidence.task_id)
        || !aliases.iter().any(|alias| alias == evidence.device_id)
        || !execution
            .runtime_device_id
            .as_ref()
            .is_some_and(|device| aliases.contains(device))
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Issue activity does not match its original Runtime",
        ));
    }
    Ok(execution_id)
}
