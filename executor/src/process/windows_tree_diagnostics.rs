// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct Relation {
    pid: u32,
    parent_pid: u32,
}

#[derive(Debug, Serialize)]
struct Observation {
    state: &'static str,
    exit_code: Option<u32>,
    error_code: Option<u32>,
}

#[derive(Debug, Serialize)]
struct Descendant {
    relation: Relation,
    observation: Observation,
}

#[derive(Debug, Serialize)]
struct TreeDiagnostic {
    target_pid: u32,
    target: Observation,
    parent_pid: Option<u32>,
    snapshot_error_code: Option<u32>,
    descendants: Vec<Descendant>,
}

fn collect(
    target_pid: u32,
    snapshot: Result<Vec<Relation>, u32>,
    mut query: impl FnMut(u32) -> Observation,
) -> TreeDiagnostic {
    let mut diagnostic = TreeDiagnostic {
        target_pid,
        target: query(target_pid),
        parent_pid: None,
        snapshot_error_code: None,
        descendants: Vec::new(),
    };
    let relations = match snapshot {
        Ok(relations) => relations,
        Err(code) => {
            diagnostic.snapshot_error_code = Some(code);
            return diagnostic;
        }
    };
    diagnostic.parent_pid = relations
        .iter()
        .find(|entry| entry.pid == target_pid)
        .map(|entry| entry.parent_pid);
    let mut visited = HashSet::from([target_pid]);
    loop {
        let mut changed = false;
        for relation in &relations {
            if visited.contains(&relation.parent_pid) && visited.insert(relation.pid) {
                changed = true;
                diagnostic.descendants.push(Descendant {
                    relation: *relation,
                    observation: query(relation.pid),
                });
            }
        }
        if !changed {
            break;
        }
    }
    diagnostic
        .descendants
        .sort_by_key(|entry| entry.relation.pid);
    diagnostic
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
            WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetExitCodeProcess, OpenProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: Only successfully acquired, uniquely owned handles are wrapped.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn snapshot() -> Result<Vec<Relation>, u32> {
        // SAFETY: This call only captures process metadata and does not open modules or heaps.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(unsafe { GetLastError() });
        }
        let handle = OwnedHandle(raw);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        // SAFETY: The snapshot is live and entry is initialized to the documented size.
        let mut available = unsafe { Process32FirstW(handle.0, &mut entry) };
        let mut relations = Vec::new();
        loop {
            if available == 0 {
                let code = unsafe { GetLastError() };
                return if code == ERROR_NO_MORE_FILES {
                    Ok(relations)
                } else {
                    Err(code)
                };
            }
            // Executable names from PROCESSENTRY32W are deliberately not retained.
            relations.push(Relation {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
            });
            available = unsafe { Process32NextW(handle.0, &mut entry) };
        }
    }

    fn query(pid: u32) -> Observation {
        let failed = |state, code| Observation {
            state,
            exit_code: None,
            error_code: Some(code),
        };
        // SAFETY: Query and zero-timeout synchronization rights cannot terminate a process.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            return failed("open-failed", unsafe { GetLastError() });
        }
        let handle = OwnedHandle(raw);
        let state = match unsafe { WaitForSingleObject(handle.0, 0) } {
            WAIT_OBJECT_0 => "exited",
            WAIT_TIMEOUT => "running",
            _ => return failed("state-query-failed", unsafe { GetLastError() }),
        };
        let mut exit_code = 0;
        if unsafe { GetExitCodeProcess(handle.0, &mut exit_code) } == 0 {
            return failed("exit-query-failed", unsafe { GetLastError() });
        }
        Observation {
            state,
            exit_code: Some(exit_code),
            error_code: None,
        }
    }

    pub(super) fn capture(pid: u32) -> TreeDiagnostic {
        // Snapshot relationships and later PID queries do not establish creation identity or ownership.
        collect(pid, snapshot(), query)
    }
}

#[cfg(windows)]
pub(super) fn capture_json(pid: u32) -> String {
    serde_json::to_string(&native::capture(pid))
        .unwrap_or_else(|_| "{\"capture_available\":false}".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running() -> Observation {
        Observation {
            state: "running",
            exit_code: Some(259),
            error_code: None,
        }
    }

    #[test]
    fn collects_only_related_numeric_identities_once_despite_cycles() {
        let mut queried = Vec::new();
        let report = collect(
            10,
            Ok(vec![
                Relation {
                    pid: 30,
                    parent_pid: 20,
                },
                Relation {
                    pid: 10,
                    parent_pid: 30,
                },
                Relation {
                    pid: 20,
                    parent_pid: 10,
                },
                Relation {
                    pid: 99,
                    parent_pid: 98,
                },
            ]),
            |pid| {
                queried.push(pid);
                running()
            },
        );
        assert_eq!(report.parent_pid, Some(30));
        assert_eq!(queried, vec![10, 20, 30]);
        assert_eq!(report.descendants.len(), 2);
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["descendants"][0]["relation"]["pid"], 20);
        assert!(!json.to_string().contains("99"));
        assert!(!json.to_string().contains("name"));
    }

    #[test]
    fn snapshot_failure_keeps_target_query_error_without_retrying() {
        let mut calls = 0;
        let report = collect(10, Err(5), |_| {
            calls += 1;
            Observation {
                state: "open-failed",
                exit_code: None,
                error_code: Some(87),
            }
        });
        assert_eq!(calls, 1);
        assert_eq!(report.snapshot_error_code, Some(5));
        assert_eq!(report.target.error_code, Some(87));
        assert!(report.descendants.is_empty());
    }

    #[test]
    fn missing_target_is_not_replaced_by_an_unrelated_process() {
        let report = collect(
            10,
            Ok(vec![Relation {
                pid: 99,
                parent_pid: 98,
            }]),
            |_| running(),
        );
        assert!(report.parent_pid.is_none());
        assert!(report.descendants.is_empty());
        assert!(report.snapshot_error_code.is_none());
    }

    #[test]
    fn retains_numeric_query_failure_for_a_descendant_that_disappeared() {
        let report = collect(
            10,
            Ok(vec![Relation {
                pid: 20,
                parent_pid: 10,
            }]),
            |pid| {
                if pid == 10 {
                    running()
                } else {
                    Observation {
                        state: "open-failed",
                        exit_code: None,
                        error_code: Some(87),
                    }
                }
            },
        );
        let value = serde_json::to_value(report).unwrap();
        assert_eq!(
            value["descendants"][0]["observation"]["state"],
            "open-failed"
        );
        assert_eq!(value["descendants"][0]["observation"]["error_code"], 87);
        assert!(value["descendants"][0]["observation"]["exit_code"].is_null());
    }

    #[cfg(windows)]
    #[test]
    fn native_snapshot_observes_a_real_child_parent_and_cleans_up() {
        let mut child = std::process::Command::new("cmd")
            .args(["/d", "/c", "set /p hold="])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let child_pid = child.id();
        let own = native::capture(std::process::id());
        let target = native::capture(child_pid);
        let cleanup = child.kill();
        let reaped = child.wait();
        cleanup.unwrap();
        assert!(reaped.is_ok());
        assert_eq!(target.parent_pid, Some(std::process::id()));
        assert_eq!(target.target.state, "running");
        assert_eq!(target.target.exit_code, Some(259));
        assert!(own
            .descendants
            .iter()
            .any(|entry| entry.relation.pid == child_pid));
        assert!(own.snapshot_error_code.is_none());
        assert!(target.snapshot_error_code.is_none());
    }
}
