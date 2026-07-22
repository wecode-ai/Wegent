use std::collections::HashSet;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct SystemSleepState {
    inner: Mutex<SystemSleepInner>,
}

struct SystemSleepInner {
    enabled: bool,
    tasks: RunningTaskState,
    inhibitor: Option<SleepInhibitor>,
}

impl Default for SystemSleepInner {
    fn default() -> Self {
        Self {
            enabled: true,
            tasks: RunningTaskState::default(),
            inhibitor: None,
        }
    }
}

#[derive(Default)]
struct RunningTaskState {
    count: usize,
    settled_task_ids: HashSet<String>,
}

impl RunningTaskState {
    fn replace_count(&mut self, count: usize) {
        self.count = count;
        self.settled_task_ids.clear();
    }

    fn settle(&mut self, task_id: Option<&str>) {
        let newly_settled = match task_id {
            Some(id) => self.settled_task_ids.insert(id.to_owned()),
            None => true,
        };
        if newly_settled {
            self.count = self.count.saturating_sub(1);
        }
    }
}

impl SystemSleepState {
    pub(crate) fn set_enabled(&self, enabled: bool) {
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state");
            return;
        };
        inner.enabled = enabled;
        inner.reconcile();
    }

    pub(crate) fn set_running_count(&self, running_count: usize) {
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state");
            return;
        };
        inner.tasks.replace_count(running_count);
        inner.reconcile();
    }

    pub(crate) fn handle_terminal_event(&self, event: &str, task_id: Option<&str>) {
        if !is_terminal_response_event(event) {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state");
            return;
        };
        inner.tasks.settle(task_id);
        inner.reconcile();
    }

    pub(crate) fn clear_running_tasks(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state while clearing tasks");
            return;
        };
        inner.tasks.replace_count(0);
        inner.reconcile();
    }
}

impl SystemSleepInner {
    fn reconcile(&mut self) {
        if !self.enabled || self.tasks.count == 0 {
            if self.inhibitor.take().is_some() {
                log::info!("Released system sleep inhibition after local tasks settled");
            }
            return;
        }
        if self.inhibitor.is_some() {
            return;
        }
        match SleepInhibitor::acquire() {
            Ok(inhibitor) => {
                self.inhibitor = Some(inhibitor);
                log::info!("Inhibited system sleep while local tasks are running");
            }
            Err(error) => log::warn!("Failed to inhibit system sleep: {error}"),
        }
    }
}

fn is_terminal_response_event(event: &str) -> bool {
    matches!(
        event,
        "response.completed" | "response.failed" | "response.incomplete"
    )
}

struct SleepInhibitor {
    child: Child,
}

impl SleepInhibitor {
    fn acquire() -> Result<Self, String> {
        let mut command = sleep_inhibitor_command()?;
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to start sleep inhibitor: {error}"))?;
        Ok(Self { child })
    }
}

impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        if let Err(error) = self.child.kill() {
            log::warn!("Failed to stop system sleep inhibitor: {error}");
        }
        let _ = self.child.wait();
    }
}

#[cfg(target_os = "macos")]
fn sleep_inhibitor_command() -> Result<Command, String> {
    let mut command = Command::new("/usr/bin/caffeinate");
    command.arg("-i");
    Ok(command)
}

#[cfg(target_os = "linux")]
fn sleep_inhibitor_command() -> Result<Command, String> {
    let mut command = Command::new("systemd-inhibit");
    command.args([
        "--what=sleep",
        "--who=Wework",
        "--why=Local task is running",
        "--mode=block",
        "sleep",
        "infinity",
    ]);
    Ok(command)
}

#[cfg(target_os = "windows")]
fn sleep_inhibitor_command() -> Result<Command, String> {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -Namespace Wework -Name Sleep -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'; [Wework.Sleep]::SetThreadExecutionState(0x80000001); while ($true) { Start-Sleep -Seconds 3600 }",
    ]);
    Ok(command)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn sleep_inhibitor_command() -> Result<Command, String> {
    Err("system sleep inhibition is not supported on this platform".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_every_terminal_response_event() {
        assert!(is_terminal_response_event("response.completed"));
        assert!(is_terminal_response_event("response.failed"));
        assert!(is_terminal_response_event("response.incomplete"));
        assert!(!is_terminal_response_event("response.created"));
        assert!(!is_terminal_response_event("response.output_text.delta"));
    }

    #[test]
    fn tracks_concurrent_tasks_without_releasing_early() {
        let mut tasks = RunningTaskState::default();
        tasks.replace_count(2);

        tasks.settle(Some("task-1"));
        assert_eq!(tasks.count, 1);

        tasks.settle(Some("task-1"));
        assert_eq!(tasks.count, 1);

        tasks.settle(Some("task-2"));
        assert_eq!(tasks.count, 0);
    }

    #[test]
    fn refreshed_running_count_replaces_terminal_event_bookkeeping() {
        let mut tasks = RunningTaskState::default();
        tasks.replace_count(1);
        tasks.settle(Some("task-1"));
        tasks.replace_count(1);

        tasks.settle(Some("task-1"));
        assert_eq!(tasks.count, 0);
    }

    #[test]
    fn sleep_inhibition_is_enabled_by_default() {
        assert!(SystemSleepInner::default().enabled);
    }
}
