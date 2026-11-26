// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File, OpenOptions, Permissions},
    io,
    os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use fs2::FileExt;
use tokio::net::UnixListener;

pub(super) fn bind(path: &Path) -> Result<(File, UnixListener), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app IPC socket directory: {error}"))?;
        fs::set_permissions(parent, Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to secure app IPC socket directory: {error}"))?;
    }
    let lease = lock_socket(path)?;
    remove_stale_socket(path)?;
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("failed to bind app IPC Unix socket: {error}"))?;
    fs::set_permissions(path, Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to secure app IPC Unix socket: {error}"))?;
    Ok((lease, listener))
}

fn lock_socket(path: &Path) -> Result<File, String> {
    // Keep the lock file across restarts so contenders always lock the same inode.
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(lock_path)
        .map_err(|error| format!("failed to open app IPC socket lock: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| format!("failed to inspect app IPC socket lock: {error}"))?
        .is_file()
    {
        return Err("app IPC socket lock must be a regular file".to_owned());
    }
    FileExt::try_lock_exclusive(&file)
        .map_err(|error| format!("failed to acquire app IPC socket lock: {error}"))?;
    Ok(file)
}

fn remove_stale_socket(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect app IPC Unix socket: {error}")),
    };
    if !metadata.file_type().is_socket() {
        return Err("refusing to replace a non-socket app IPC endpoint".to_owned());
    }
    fs::remove_file(path)
        .map_err(|error| format!("failed to remove stale app IPC Unix socket: {error}"))
}

#[cfg(test)]
mod tests {
    use super::bind;
    use tokio::net::UnixStream;

    #[tokio::test]
    async fn only_reclaims_socket_after_the_listener_closes() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = directory.path().join("executor.sock");
        let (lease, listener) = bind(&endpoint).unwrap();

        let error = bind(&endpoint).unwrap_err();
        assert!(error.contains("failed to acquire app IPC socket lock"));
        UnixStream::connect(&endpoint).await.unwrap();

        drop(listener);
        drop(lease);
        let (_lease, _listener) = bind(&endpoint).unwrap();
        UnixStream::connect(&endpoint).await.unwrap();
    }
}
