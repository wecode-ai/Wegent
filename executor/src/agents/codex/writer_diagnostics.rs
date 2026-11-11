// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs::File, io, path::Path};

pub(super) fn report(path: &Path, file: &File, error: &io::Error) {
    super::log_executor_event(
        "codex provider writer lock unavailable",
        &[
            (
                "lock",
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "os_error",
                error
                    .raw_os_error()
                    .map(|code| code.to_string())
                    .unwrap_or_default(),
            ),
            ("lock_records", lock_records(file)),
            ("open_file_processes", holders(file)),
        ],
    );
}

#[cfg(target_os = "linux")]
fn lock_records(file: &File) -> String {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = file.metadata() else {
        return "metadata_unavailable".into();
    };
    let key = format!(
        "{:02x}:{:02x}:{}",
        libc::major(metadata.dev()),
        libc::minor(metadata.dev()),
        metadata.ino()
    );
    std::fs::read_to_string("/proc/locks")
        .map(|locks| {
            locks
                .lines()
                .filter(|line| line.split_whitespace().any(|field| field == key))
                .take(4)
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .unwrap_or_else(|_| "proc_unavailable".into())
}

#[cfg(not(target_os = "linux"))]
fn lock_records(_file: &File) -> String {
    "unsupported".into()
}

#[cfg(target_os = "linux")]
fn holders(file: &File) -> String {
    use std::{fs, os::unix::fs::MetadataExt};

    let Ok(target) = file.metadata() else {
        return "metadata_unavailable".into();
    };
    let Ok(processes) = fs::read_dir("/proc") else {
        return "proc_unavailable".into();
    };
    let mut holders = Vec::new();
    for process in processes.flatten() {
        let Ok(pid) = process.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(files) = fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        if !files.flatten().any(|entry| {
            fs::metadata(entry.path()).is_ok_and(|metadata| {
                metadata.dev() == target.dev() && metadata.ino() == target.ino()
            })
        }) {
            continue;
        }
        let stat = fs::read_to_string(process.path().join("stat")).unwrap_or_default();
        let fields = stat
            .rsplit_once(')')
            .map(|(_, fields)| fields)
            .unwrap_or_default();
        // PID, state, parent PID and process group; never read command arguments.
        holders.push(format!(
            "{pid}:{}",
            fields
                .split_whitespace()
                .take(3)
                .collect::<Vec<_>>()
                .join(":")
        ));
        if holders.len() == 8 {
            break;
        }
    }
    holders.join(",")
}

#[cfg(not(target_os = "linux"))]
fn holders(_file: &File) -> String {
    "unsupported".into()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn identifies_the_actual_process_holding_the_writer_inode() {
        use fs2::FileExt;
        let file = tempfile::tempfile().unwrap();
        file.lock_exclusive().unwrap();
        let prefix = format!("{}:", std::process::id());
        assert!(super::holders(&file)
            .split(',')
            .any(|holder| holder.starts_with(&prefix)));
        assert!(super::lock_records(&file).contains(&format!(" {} ", std::process::id())));
    }
}
