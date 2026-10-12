// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

/// All executor-owned state uses this root. Explicit application/volume roots win.
pub fn executor_home() -> PathBuf {
    configured_home().unwrap_or_else(|| {
        crate::services::workbench::workbench_root()
            .map(|root| root.join("executor"))
            .unwrap_or_else(|_| default_home(&platform_home()))
    })
}

fn platform_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn default_home(home: &Path) -> PathBuf {
    home.join(".wegent/workbench/executor")
}

fn configured_home() -> Option<PathBuf> {
    let value = env::var("WEGENT_EXECUTOR_HOME").ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(if value == "~" {
        platform_home()
    } else if let Some(relative) = value.strip_prefix("~/") {
        platform_home().join(relative)
    } else {
        PathBuf::from(value)
    })
}

/// Run before loading installation identity or opening any executor state.
pub fn migrate_default_home() -> io::Result<()> {
    if configured_home().is_some() {
        return Ok(());
    }
    let target = crate::services::workbench::workbench_root()
        .map_err(io::Error::other)?
        .join("executor");
    migrate_at(&platform_home(), &target)
}

fn migrate_at(home: &Path, target: &Path) -> io::Result<()> {
    let parent = target.parent().unwrap();
    fs::create_dir_all(parent)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join(".executor-migration.lock"))?;
    lock.lock_exclusive()?;
    let legacy = home.join(".wegent-executor");
    match fs::symlink_metadata(&legacy) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            if legacy.canonicalize()? == target.canonicalize()? {
                return Ok(());
            }
            return Err(io::Error::other(
                "Legacy executor Home points to a different directory",
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(io::Error::other("Legacy executor Home is not a directory"))
        }
        _ => {}
    }
    if target.try_exists()? {
        return Err(io::Error::other("Both legacy and unified executor Homes exist; refusing to merge installation identities"));
    }
    let writer = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(legacy.join(".writer.lock"))?;
    writer.try_lock_exclusive().map_err(|_| {
        io::Error::other("Legacy Executor is still running; stop it before migrating its Home")
    })?;
    fs::rename(&legacy, target)?;
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(target, &legacy);
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(target, &legacy);
    if let Err(error) = linked {
        fs::rename(target, &legacy)?;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_identity_sessions_and_old_paths_and_is_repeatable() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(".wegent-executor");
        fs::create_dir_all(legacy.join("sessions/task-1")).unwrap();
        fs::write(legacy.join("device-config.json"), "installation-1").unwrap();
        fs::write(
            legacy.join("sessions/task-1/.claude_session_id"),
            "session-1",
        )
        .unwrap();
        migrate_at(root.path(), &default_home(root.path())).unwrap();
        migrate_at(root.path(), &default_home(root.path())).unwrap();
        assert_eq!(
            legacy.canonicalize().unwrap(),
            default_home(root.path()).canonicalize().unwrap()
        );
        assert_eq!(
            fs::read_to_string(legacy.join("device-config.json")).unwrap(),
            "installation-1"
        );
        assert_eq!(
            fs::read_to_string(
                default_home(root.path()).join("sessions/task-1/.claude_session_id")
            )
            .unwrap(),
            "session-1"
        );
    }

    #[test]
    fn migration_does_not_overwrite_two_existing_homes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".wegent-executor")).unwrap();
        fs::create_dir_all(default_home(root.path())).unwrap();
        assert!(migrate_at(root.path(), &default_home(root.path())).is_err());
        assert!(!fs::symlink_metadata(root.path().join(".wegent-executor"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
