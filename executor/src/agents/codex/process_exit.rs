// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::io;
use std::{os::unix::process::ExitStatusExt, process::ExitStatus};
use tokio::process::Child;

#[derive(Default)]
pub(super) struct ExitProgress {
    pub(super) reaped: bool,
    last_error: Option<String>,
    #[cfg(target_os = "linux")]
    waiting_thread_process: Option<u32>,
}

impl ExitProgress {
    pub(super) fn try_reap(&mut self, child: &mut Child) -> bool {
        if self.reaped {
            return true;
        }
        match self.reap_stopped_group(child) {
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

impl ExitProgress {
    fn reap_stopped_group(&mut self, child: &mut Child) -> io::Result<bool> {
        if child.id().is_none() {
            return Ok(child.try_wait()?.is_some());
        }
        if status(child)?.is_none() {
            return Ok(false);
        }
        let group = child.id().expect("unreaped owned child retains its PID");
        #[cfg(target_os = "linux")]
        let running = if let Some((pid, member)) = live_descendant(group)? {
            if matches!(member.state, 'Z' | 'X')
                && member.thread_count > 1
                && self.waiting_thread_process != Some(pid)
            {
                super::log_executor_event(
                    "codex process group waiting for native worker threads",
                    &[
                        ("process_id", group.to_string()),
                        ("native_process_id", pid.to_string()),
                        ("state", member.state.to_string()),
                        ("thread_count", member.thread_count.to_string()),
                    ],
                );
                self.waiting_thread_process = Some(pid);
            }
            true
        } else {
            false
        };
        #[cfg(target_os = "macos")]
        let running = descendants_running(group)?;
        if running {
            // SAFETY: the unreaped leader reserves this owned group against PID reuse.
            unsafe {
                libc::kill(-(group as libc::pid_t), libc::SIGKILL);
            }
            return Ok(false);
        }
        Ok(child.try_wait()?.is_some())
    }
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
fn live_descendant(group: u32) -> io::Result<Option<(u32, ProcessStat)>> {
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
        let member = match process_stat(pid) {
            Ok(Some(member)) => member,
            Ok(None) => continue,
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
        if member.process_group == group && member.has_live_threads() {
            return Ok(Some((pid, member)));
        }
    }
    Ok(None)
}

#[cfg(all(target_os = "linux", test))]
pub(super) fn descendants_running(group: u32) -> io::Result<bool> {
    live_descendant(group).map(|member| member.is_some())
}

#[cfg(any(target_os = "linux", test))]
pub(super) struct ProcessStat {
    pub(super) state: char,
    pub(super) process_group: u32,
    pub(super) thread_count: usize,
}

#[cfg(any(target_os = "linux", test))]
impl ProcessStat {
    fn has_live_threads(&self) -> bool {
        // A zombie main thread can leave other threads holding the shared file table.
        !matches!(self.state, 'Z' | 'X') || self.thread_count > 1
    }
}

#[cfg(target_os = "linux")]
pub(super) fn process_stat(pid: u32) -> io::Result<Option<ProcessStat>> {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|source| parse_process_stat(&source))
}

#[cfg(any(target_os = "linux", test))]
fn parse_process_stat(source: &str) -> Option<ProcessStat> {
    let fields = source
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    Some(ProcessStat {
        state: fields.first()?.chars().next()?,
        process_group: fields.get(2)?.parse().ok()?,
        thread_count: fields.get(17)?.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_zombie_main_thread_does_not_prove_the_shared_file_table_is_closed() {
        for (state, threads, live) in [
            ('Z', 2, true),
            ('Z', 1, false),
            ('X', 1, false),
            ('S', 1, true),
        ] {
            let source = format!(
                "42 (native (worker)) {state} 1 7 {} {threads}",
                vec!["0"; 14].join(" ")
            );
            let member = super::parse_process_stat(&source).unwrap();
            assert_eq!(member.process_group, 7);
            assert_eq!(member.thread_count, threads);
            assert_eq!(member.has_live_threads(), live);
        }
    }
}
