// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use std::{
    fs,
    fs::File,
    fs::OpenOptions,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
pub(crate) enum Entry {
    Locks,
    Publish,
    Tasks,
}

impl Entry {
    fn names(self) -> (&'static str, &'static str) {
        match self {
            Self::Locks => (".repository-locks", "locks"),
            Self::Publish => (".repository-publish.lock", "publish.lock"),
            Self::Tasks => (".repository-tasks", "tasks"),
        }
    }
}

fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// Existing installations keep their lock inodes until an explicit offline migration.
pub(crate) fn path(root: &Path, entry: Entry) -> Result<PathBuf, String> {
    let target = root.join(".wegent");
    if exists(&target)? && !fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_dir()) {
        return Err("Workspace metadata must be a directory, not a symlink".into());
    }
    let mut legacy = false;
    let mut current = false;
    for candidate in [Entry::Locks, Entry::Publish, Entry::Tasks] {
        let (old, new) = candidate.names();
        legacy |= exists(&root.join(old))?;
        current |= exists(&target.join(new))?;
    }
    if legacy && current {
        return Err("Mixed workspace metadata layouts; stop executors and complete --migrate-workspace-metadata".into());
    }
    let (old, new) = entry.names();
    let selected = if legacy {
        root.join(old)
    } else {
        target.join(new)
    };
    if exists(&selected)? {
        let meta = fs::symlink_metadata(&selected).map_err(|error| error.to_string())?;
        let valid = match entry {
            Entry::Publish => meta.is_file(),
            Entry::Locks | Entry::Tasks => meta.is_dir(),
        };
        if !valid {
            return Err("Invalid workspace metadata entry; symlinks are not supported".into());
        }
    }
    Ok(selected)
}

pub(crate) fn lock_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "Repository lock must be a regular file",
        ));
    }
    file.try_lock_exclusive()?;
    Ok(file)
}

/// The caller must stop all executors sharing this root, including older versions.
/// Lock probes detect active work but cannot stop an old binary opening a new lock.
pub fn migrate(root: &Path) -> Result<(), String> {
    if !root.is_absolute() || !fs::symlink_metadata(root).is_ok_and(|meta| meta.is_dir()) {
        return Err("Migration requires an existing absolute workspace directory".into());
    }
    let target = root.join(".wegent");
    if exists(&target)? && !fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_dir()) {
        return Err("Workspace metadata must be a directory, not a symlink".into());
    }
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let _migration =
        lock_file(&target.join("migration.lock")).map_err(|error| error.to_string())?;
    let mut moves = Vec::new();
    let mut leases = Vec::new();
    for entry in [Entry::Locks, Entry::Publish, Entry::Tasks] {
        let (old, new) = entry.names();
        let source = root.join(old);
        let destination = target.join(new);
        if exists(&source)? && exists(&destination)? {
            return Err(
                "Conflicting workspace metadata layouts; existing files were preserved".into(),
            );
        }
        let source = if exists(&source)? {
            source
        } else {
            destination.clone()
        };
        if !exists(&source)? {
            continue;
        }
        let meta = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        match entry {
            Entry::Publish if meta.is_file() => {
                leases.push(
                    lock_file(&source)
                        .map_err(|_| "Workspace publication is active; stop executors first")?,
                );
            }
            Entry::Locks if meta.is_dir() => {
                for entry in fs::read_dir(&source).map_err(|error| error.to_string())? {
                    let entry = entry.map_err(|error| error.to_string())?;
                    if !entry
                        .file_type()
                        .map_err(|error| error.to_string())?
                        .is_file()
                    {
                        return Err("Invalid repository lock entry; no metadata moved".into());
                    }
                    leases.push(
                        lock_file(&entry.path())
                            .map_err(|_| "Repository is active; stop executors first")?,
                    );
                }
            }
            Entry::Tasks if meta.is_dir() => {}
            _ => return Err("Invalid workspace metadata entry; no metadata moved".into()),
        }
        if source != destination {
            moves.push((source, destination));
        }
    }
    // Rename, never copy or overwrite. Each completed step is valid on the next run.
    for (source, destination) in moves {
        fs::rename(source, destination).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
