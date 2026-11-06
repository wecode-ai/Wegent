//! Durable delivery intent. An uncertain delivery is never silently retried.
use crate::local::app_ipc::AppIpcError;
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::Path,
};

pub(crate) fn transact<T>(
    path: &Path,
    update: impl FnOnce(&mut Value) -> Result<T, AppIpcError>,
) -> Result<T, AppIpcError> {
    let io_error =
        |error: std::io::Error| AppIpcError::new("control_storage_failed", error.to_string());
    fs::create_dir_all(path.parent().expect("journal parent")).map_err(io_error)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(io_error)?;
    lock.lock_exclusive().map_err(io_error)?;
    let mut state = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| AppIpcError::new("control_storage_failed", "Invalid control journal"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            json!({"version":1,"operations":{}})
        }
        Err(error) => return Err(io_error(error)),
    };
    if state.get("version").and_then(Value::as_u64) != Some(1)
        || !state.get("operations").is_some_and(Value::is_object)
    {
        return Err(AppIpcError::new(
            "control_storage_failed",
            "Invalid control journal structure or version",
        ));
    }
    let original = state.clone();
    let result = update(&mut state)?;
    if original == state {
        return Ok(result);
    }
    let bytes = serde_json::to_vec(&state).map_err(|_| {
        AppIpcError::new("control_storage_failed", "Cannot serialize control journal")
    })?;
    crate::runtime_work::store::atomic_write_file(path, &bytes).map_err(io_error)?;
    Ok(result)
}
