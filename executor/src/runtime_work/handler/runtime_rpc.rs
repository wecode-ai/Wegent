// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkHandler for RuntimeWorkRpcHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let method = string_field(&data, "method")
                .ok_or_else(|| AppIpcError::new("bad_request", "method is required"))?;
            let payload = data
                .get("payload")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            self.dispatch(&method, payload).await
        })
    }

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            let method = string_field(&data, "method")
                .ok_or_else(|| AppIpcError::new("bad_request", "method is required"))?;
            if !is_allowed_plugin_app_server_method(&method) {
                return Err(AppIpcError::new(
                    "unsupported_codex_app_server_method",
                    format!("Unsupported Codex app-server method: {method}"),
                ));
            }
            let params = data
                .get("params")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            self.codex_app_server
                .request(&method, params)
                .await
                .map_err(|error| AppIpcError::new("codex_app_server_request_failed", error))
        })
    }
}

pub(super) fn is_allowed_plugin_app_server_method(method: &str) -> bool {
    matches!(
        method,
        "marketplace/add"
            | "marketplace/remove"
            | "marketplace/upgrade"
            | "plugin/list"
            | "plugin/installed"
            | "plugin/read"
            | "plugin/skill/read"
            | "plugin/install"
            | "plugin/uninstall"
            | "skills/list"
            | "skills/config/write"
            | "app/list"
    )
}

#[cfg(debug_assertions)]
const SLOW_RUNTIME_COLLECT_THREAD_MS: u128 = 100;

#[cfg(debug_assertions)]
pub(super) fn log_runtime_collect_diagnostic(
    stage: &str,
    archived: bool,
    started_at: Instant,
    stage_started_at: Instant,
    fields: &[(&str, String)],
) {
    let mut diagnostic_fields = vec![
        ("stage", stage.to_owned()),
        ("archived", archived.to_string()),
        ("elapsed_ms", elapsed_ms(started_at)),
        ("stage_elapsed_ms", elapsed_ms(stage_started_at)),
    ];
    if let Some(rss_kb) = current_process_max_rss_kb() {
        diagnostic_fields.push(("max_rss_kb", rss_kb.to_string()));
    }
    diagnostic_fields.extend(fields.iter().map(|(key, value)| (*key, value.clone())));
    log_executor_event("runtime work collect diagnostic", &diagnostic_fields);
}

#[cfg(not(debug_assertions))]
pub(super) fn log_runtime_collect_diagnostic(
    _stage: &str,
    _archived: bool,
    _started_at: Instant,
    _stage_started_at: Instant,
    _fields: &[(&str, String)],
) {
}

#[cfg(debug_assertions)]
pub(super) fn log_slow_runtime_collect_thread(
    archived: bool,
    thread_id: &str,
    started_at: Instant,
    thread: &Value,
    link: &RuntimeTaskLink,
) {
    let elapsed = started_at.elapsed().as_millis();
    if elapsed < SLOW_RUNTIME_COLLECT_THREAD_MS {
        return;
    }
    log_executor_event(
        "runtime work collect slow thread",
        &[
            ("archived", archived.to_string()),
            ("elapsed_ms", elapsed.to_string()),
            ("thread_id", thread_id.to_owned()),
            ("thread_json_bytes", debug_json_len(thread).to_string()),
            ("local_task_id", link.local_task_id.clone()),
            ("workspace_path", link.workspace_path.clone()),
            ("status", link.status.clone()),
        ],
    );
}

#[cfg(not(debug_assertions))]
pub(super) fn log_slow_runtime_collect_thread(
    _archived: bool,
    _thread_id: &str,
    _started_at: Instant,
    _thread: &Value,
    _link: &RuntimeTaskLink,
) {
}

#[cfg(debug_assertions)]
pub(super) fn log_slow_runtime_collect_thread_missing(
    archived: bool,
    thread_id: &str,
    started_at: Instant,
    thread: &Value,
) {
    let elapsed = started_at.elapsed().as_millis();
    if elapsed < SLOW_RUNTIME_COLLECT_THREAD_MS {
        return;
    }
    log_executor_event(
        "runtime work collect slow skipped thread",
        &[
            ("archived", archived.to_string()),
            ("elapsed_ms", elapsed.to_string()),
            ("thread_id", thread_id.to_owned()),
            ("thread_json_bytes", debug_json_len(thread).to_string()),
        ],
    );
}

#[cfg(not(debug_assertions))]
pub(super) fn log_slow_runtime_collect_thread_missing(
    _archived: bool,
    _thread_id: &str,
    _started_at: Instant,
    _thread: &Value,
) {
}

#[cfg(debug_assertions)]
fn debug_json_len(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
pub(super) fn log_runtime_work_list_diagnostic(
    stage: &str,
    started_at: Instant,
    stage_started_at: Instant,
    fields: &[(&str, String)],
) {
    let mut diagnostic_fields = vec![
        ("stage", stage.to_owned()),
        ("elapsed_ms", elapsed_ms(started_at)),
        ("stage_elapsed_ms", elapsed_ms(stage_started_at)),
    ];
    if let Some(rss_kb) = current_process_max_rss_kb() {
        diagnostic_fields.push(("max_rss_kb", rss_kb.to_string()));
    }
    diagnostic_fields.extend(fields.iter().map(|(key, value)| (*key, value.clone())));
    log_executor_event("runtime work list diagnostic", &diagnostic_fields);
}

#[cfg(not(debug_assertions))]
pub(super) fn log_runtime_work_list_diagnostic(
    _stage: &str,
    _started_at: Instant,
    _stage_started_at: Instant,
    _fields: &[(&str, String)],
) {
}

#[cfg(all(debug_assertions, not(windows)))]
fn current_process_max_rss_kb() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    let max_rss = unsafe { usage.assume_init().ru_maxrss };
    #[cfg(target_os = "macos")]
    {
        Some((max_rss as u64).saturating_div(1024))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(max_rss as u64)
    }
}

#[cfg(all(debug_assertions, windows))]
fn current_process_max_rss_kb() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters = std::mem::MaybeUninit::<PROCESS_MEMORY_COUNTERS>::uninit();
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            counters.as_mut_ptr(),
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if ok == 0 {
        return None;
    }
    let counters = unsafe { counters.assume_init() };
    Some((counters.PeakWorkingSetSize as u64).saturating_div(1024))
}
