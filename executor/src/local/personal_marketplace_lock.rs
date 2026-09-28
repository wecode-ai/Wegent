// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

use fs2::FileExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

pub(super) fn acquire_personal_marketplace_lock(
    marketplace_root: &Path,
) -> Result<fs::File, String> {
    let parent = marketplace_root
        .parent()
        .ok_or_else(|| "Personal marketplace has no parent directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let lock_parent = parent
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {error}", parent.display()))?;
    let root_name = marketplace_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Personal marketplace has no valid directory name".to_owned())?;
    let lock_path = lock_parent.join(format!(".{root_name}.plugin-mutations.lock"));
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!(
            "Personal marketplace lock may not be a symbolic link: {}",
            lock_path.display()
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let lock = options
        .open(&lock_path)
        .map_err(|error| format!("Failed to open {}: {error}", lock_path.display()))?;
    lock.lock_exclusive()
        .map_err(|error| format!("Failed to lock {}: {error}", marketplace_root.display()))?;
    Ok(lock)
}
