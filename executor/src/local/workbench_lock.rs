// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, PathBuf};

/// Hold OS file locks until the desktop closes its pipe or this process exits.
/// Persistent lock files must never be unlinked: all owners must lock the same inode.
pub fn run(resources: &str) -> Result<(), String> {
    let mut paths: Vec<PathBuf> = serde_json::from_str(resources)
        .map_err(|_| "Invalid Workbench migration lock resources")?;
    if paths.is_empty()
        || paths.len() > 3
        || paths.iter().any(|path| {
            !path.is_absolute()
                || path.parent().is_none()
                || path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
        })
    {
        return Err("Invalid Workbench migration lock resources".into());
    }
    paths.sort();
    paths.dedup();
    let mut locks: Vec<File> = Vec::new();
    for path in paths {
        let parent = path.parent().ok_or("Missing lock parent")?;
        let mut directories = DirBuilder::new();
        directories.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directories.mode(0o700);
        }
        directories
            .create(parent)
            .map_err(|_| "Cannot create migration lock directory")?;
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| "Cannot open migration lock file")?;
        if !file
            .metadata()
            .map_err(|_| "Cannot inspect migration lock file")?
            .is_file()
        {
            return Err("Migration lock must be a regular file".into());
        }
        file.try_lock_exclusive()
            .map_err(|_| "Workbench Home migration lock unavailable")?;
        locks.push(file);
    }
    println!("{{\"protocol_version\":1,\"locked\":true}}");
    io::stdout()
        .flush()
        .map_err(|_| "Cannot acknowledge migration lock")?;
    // EOF follows both normal release and abrupt parent death. No PID-file reclamation.
    let mut byte = [0_u8];
    loop {
        match io::stdin().read(&mut byte) {
            Ok(0) => break,
            Ok(_) => return Err("Unexpected migration lock input".into()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Migration lock control pipe failed".into()),
        }
    }
    drop(locks);
    Ok(())
}
