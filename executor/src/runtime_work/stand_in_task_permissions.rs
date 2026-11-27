use serde::Deserialize;

use crate::protocol::StandInTaskPermissions;

use super::response::RuntimeTaskLink;
use super::util::{is_codex_runtime, runtime_origin};

pub(super) const TASK_PERMISSIONS: &str = "taskPermissions";

pub(super) fn task_permissions(link: &RuntimeTaskLink) -> Option<StandInTaskPermissions> {
    let handle = &link.runtime_handle;
    let origin = runtime_origin(handle)?;
    let execution = handle
        .get("executionRequest")
        .or_else(|| handle.get("execution_request"))?;
    let delegation = execution.get("standInDelegation")?;
    if link.ephemeral
        || link.parent.is_some()
        || !is_codex_runtime(&link.runtime)
        || origin["type"] != "stand_in_task"
        || origin["initiatedBy"] != "stand_in"
        || !origin["userId"].is_i64()
        || origin["userId"] != execution["user_id"]
        || origin["userId"] != delegation["userId"]
        || !origin["deviceId"].is_string()
        || !origin["sourceTaskId"].is_string()
        || origin["sourceTaskId"] != delegation["sourceTaskId"]
        || !origin["workId"].is_null()
        || !origin["sourceProvider"].is_null()
        || !origin["cloudProjectId"].is_null()
        || !origin["loopItemId"].is_null()
        || !delegation["sourceMessageId"].is_null()
    {
        return None;
    }

    if let Some(value) = handle.get(TASK_PERMISSIONS) {
        return StandInTaskPermissions::deserialize(value).ok();
    }
    // Existing specialist work was always created with the read-only policy.
    (origin["roleDelegation"].is_object()
        && origin["roleDelegation"] == delegation["roleDelegation"])
        .then(StandInTaskPermissions::default)
}
