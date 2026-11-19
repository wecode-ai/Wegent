// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs::File, io, path::Path};

pub(super) fn report(path: &Path, file: &File, error: &io::Error) {
    let records = lock_records(file);
    let owners = owners(&records);
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
            ("lock_records", records),
            ("owner_processes", owners),
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
fn owners(records: &str) -> String {
    records
        .split(" | ")
        .filter_map(|record| {
            let fields = record.split_whitespace().collect::<Vec<_>>();
            let pid = fields
                .windows(2)
                .find(|pair| matches!(pair[0], "READ" | "WRITE"))?[1]
                .parse::<u32>()
                .ok()?;
            Some(match super::process_exit::process_stat(pid) {
                Ok(Some(member)) => format!(
                    "{pid}:{}:{}:{}",
                    member.state, member.process_group, member.thread_count
                ),
                _ => format!("{pid}:unavailable"),
            })
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(not(target_os = "linux"))]
fn owners(_records: &str) -> String {
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
        assert!(super::owners(&super::lock_records(&file))
            .split(',')
            .any(|holder| holder.starts_with(&prefix)));
        assert!(super::lock_records(&file).contains(&format!(" {} ", std::process::id())));
    }
}
