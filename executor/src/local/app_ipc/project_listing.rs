// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::LocalTaskStore;

/// Git discovery and SQLite initialization must not occupy the IPC reactor.
pub(super) async fn list(gate: Arc<Mutex<()>>) -> Result<Value, AppIpcError> {
    let permit = gate.lock_owned().await;
    tokio::task::spawn_blocking(move || {
        // Keep the worker bounded even if its caller disconnects or times out.
        let _permit = permit;
        let store = wegent_runtime_logging::project_index_diagnostics::trace(
            "projects_list.init",
            LocalTaskStore::from_env,
        )
        .map_err(task_runtime_error)?;
        serialize_task_value(
            TaskRuntime::list_collaboration_projects(&store).map_err(task_runtime_error)?,
        )
    })
    .await
    .map_err(|error| AppIpcError::new("task_runtime_failed", error.to_string()))?
}
