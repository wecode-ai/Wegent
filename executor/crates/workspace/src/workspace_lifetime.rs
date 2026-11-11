//! Keep a workspace present while executor-owned Git processes use it.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

fn access(path: &Path) -> Result<Arc<RwLock<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<RwLock<()>>>>> = OnceLock::new();
    let canonical = match std::fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .map_err(|error| error.to_string())?
                    .join(path)
            }
        }
        Err(error) => return Err(format!("Cannot identify workspace directory: {error}")),
    };
    let mut key = canonical.to_string_lossy().into_owned();
    if cfg!(windows) {
        key = key.replace('\\', "/").to_lowercase();
        if let Some(unc) = key.strip_prefix("//?/unc/") {
            key = format!("//{unc}");
        } else if let Some(local) = key.strip_prefix("//?/") {
            key = local.to_owned();
        }
    }
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Workspace lifetime registry is unavailable".to_owned())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(RwLock::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub async fn use_directory(path: &Path) -> Result<OwnedRwLockReadGuard<()>, String> {
    Ok(access(path)?.read_owned().await)
}

/// Like the synchronous filesystem mutation it protects, call outside async workers.
pub fn remove_directory(path: &Path) -> Result<OwnedRwLockWriteGuard<()>, String> {
    let lock = access(path)?;
    if let Ok(guard) = lock.clone().try_write_owned() {
        return Ok(guard);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(runtime.block_on(lock.write_owned()))
}
