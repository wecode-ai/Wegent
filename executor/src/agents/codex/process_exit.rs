// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::io;
use std::{os::unix::process::ExitStatusExt, process::ExitStatus};
use tokio::process::Child;

#[derive(Default)]
pub(super) struct ExitProgress {
    pub(super) reaped: bool,
    last_error: Option<String>,
}

impl ExitProgress {
    pub(super) fn try_reap(&mut self, child: &mut Child) -> bool {
        if self.reaped {
            return true;
        }
        match reap_stopped_group(child) {
            Ok(done) => {
                self.reaped = done;
                done
            }
            Err(error) => {
                let message = error.to_string();
                if self.last_error.as_ref() != Some(&message) {
                    super::log_executor_event(
                        "codex process group exit wait failed",
                        &[
                            ("process_id", child.id().unwrap_or_default().to_string()),
                            ("error", message.clone()),
                        ],
                    );
                    self.last_error = Some(message);
                }
                false
            }
        }
    }
}

/// WNOWAIT keeps the leader PID reserved while its descendants are draining.
pub(super) fn status(child: &Child) -> io::Result<Option<ExitStatus>> {
    let Some(pid) = child.id() else {
        return Ok(None);
    };
    // SAFETY: this is our owned child; WNOWAIT leaves final reaping to Child.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        if libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) != 0
        {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(None)
            } else {
                Err(error)
            };
        }
        if info.si_pid() == 0 {
            return Ok(None);
        }
        let raw = match info.si_code {
            libc::CLD_EXITED => info.si_status() << 8,
            libc::CLD_DUMPED => info.si_status() | 0x80,
            _ => info.si_status(),
        };
        Ok(Some(ExitStatus::from_raw(raw)))
    }
}

fn reap_stopped_group(child: &mut Child) -> io::Result<bool> {
    if child.id().is_none() {
        return Ok(child.try_wait()?.is_some());
    }
    if status(child)?.is_none() {
        return Ok(false);
    }
    let group = child.id().expect("unreaped owned child retains its PID");
    if descendants_running(group)? {
        // SAFETY: the unreaped leader reserves this owned group against PID reuse.
        unsafe {
            libc::kill(-(group as libc::pid_t), libc::SIGKILL);
        }
        return Ok(false);
    }
    Ok(child.try_wait()?.is_some())
}

/// The leader stays owned until every member that can retain native files exits.
#[cfg(target_os = "macos")]
pub(super) fn descendants_running(group: u32) -> io::Result<bool> {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listpgrppids(group: libc::pid_t, buffer: *mut libc::c_void, bytes: i32) -> i32;
    }
    let mut members = vec![0i32; 64];
    loop {
        // SAFETY: libproc writes at most the supplied capacity of aligned PID storage.
        let count = unsafe {
            *libc::__error() = 0;
            proc_listpgrppids(
                group as libc::pid_t,
                members.as_mut_ptr().cast(),
                (members.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if count < 0 || (count == 0 && io::Error::last_os_error().raw_os_error() != Some(0)) {
            return Err(io::Error::last_os_error());
        }
        if (count as usize) < members.len() {
            return Ok(members[..count as usize]
                .iter()
                .any(|pid| *pid > 0 && *pid != group as i32));
        }
        members.resize(members.len() * 2, 0);
    }
}

#[cfg(target_os = "linux")]
pub(super) fn descendants_running(group: u32) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == group {
            continue;
        }
        let source = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(source) => source,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                ) =>
            {
                continue
            }
            Err(error) => return Err(error),
        };
        let Some((_, fields)) = source.rsplit_once(')') else {
            continue;
        };
        let mut fields = fields.split_whitespace();
        let state = fields.next();
        let process_group = fields.nth(1).and_then(|value| value.parse::<u32>().ok());
        // Zombies have closed their files, even when container PID 1 has not reaped them.
        if process_group == Some(group) && !matches!(state, Some("Z" | "X")) {
            return Ok(true);
        }
    }
    Ok(false)
}
