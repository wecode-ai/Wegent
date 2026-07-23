use std::collections::{HashSet, VecDeque};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

const MAX_SETTLED_TASK_IDS: usize = 256;

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
    active_task_ids: HashSet<String>,
    settled_task_ids: VecDeque<String>,
}

impl RunningTaskState {
    fn observe(&mut self, task_ids: impl IntoIterator<Item = String>) {
        self.active_task_ids.extend(
            task_ids
                .into_iter()
                .filter(|task_id| !self.settled_task_ids.contains(task_id)),
        );
    }

    fn start(&mut self, task_id: Option<&str>) {
        let Some(task_id) = task_id else {
            return;
        };
        if let Some(index) = self
            .settled_task_ids
            .iter()
            .position(|settled_task_id| settled_task_id == task_id)
        {
            self.settled_task_ids.remove(index);
        }
        self.active_task_ids.insert(task_id.to_owned());
    }

    fn settle(&mut self, task_id: Option<&str>) {
        if let Some(task_id) = task_id {
            self.active_task_ids.remove(task_id);
            if !self
                .settled_task_ids
                .iter()
                .any(|settled_task_id| settled_task_id == task_id)
            {
                self.settled_task_ids.push_back(task_id.to_owned());
                while self.settled_task_ids.len() > MAX_SETTLED_TASK_IDS {
                    self.settled_task_ids.pop_front();
                }
            }
        }
    }

    fn clear(&mut self) {
        self.active_task_ids.clear();
        self.settled_task_ids.clear();
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

    pub(crate) fn set_running_tasks(&self, active_task_ids: Vec<String>) {
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state");
            return;
        };
        inner.tasks.observe(active_task_ids);
        inner.reconcile();
    }

    pub(crate) fn handle_runtime_event(&self, event: &str, task_id: Option<&str>) {
        if !is_runtime_state_event(event) {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state");
            return;
        };
        if is_start_response_event(event) {
            inner.tasks.start(task_id);
        } else {
            inner.tasks.settle(task_id);
        }
        inner.reconcile();
    }

    pub(crate) fn clear_running_tasks(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Failed to lock system sleep state while clearing tasks");
            return;
        };
        inner.tasks.clear();
        inner.reconcile();
    }
}

impl SystemSleepInner {
    fn reconcile(&mut self) {
        if !self.enabled || self.tasks.active_task_ids.is_empty() {
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

fn is_start_response_event(event: &str) -> bool {
    event == "response.created"
}

fn is_runtime_state_event(event: &str) -> bool {
    is_start_response_event(event) || is_terminal_response_event(event)
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
        assert!(is_runtime_state_event("response.created"));
        assert!(is_runtime_state_event("response.completed"));
        assert!(!is_runtime_state_event("response.output_text.delta"));
    }

    #[test]
    fn tracks_concurrent_tasks_without_releasing_early() {
        let mut tasks = RunningTaskState::default();
        tasks.observe(["task-1".to_owned(), "task-2".to_owned()]);

        tasks.settle(Some("task-1"));
        assert_eq!(tasks.active_task_ids.len(), 1);

        tasks.settle(Some("task-1"));
        assert_eq!(tasks.active_task_ids.len(), 1);

        tasks.settle(Some("task-2"));
        assert!(tasks.active_task_ids.is_empty());
    }

    #[test]
    fn late_terminal_event_does_not_settle_an_unrelated_running_task() {
        let mut tasks = RunningTaskState::default();
        tasks.observe(["current-task".to_owned()]);

        tasks.settle(Some("older-task"));

        assert_eq!(
            tasks.active_task_ids,
            HashSet::from(["current-task".to_owned()])
        );
    }

    #[test]
    fn stale_observation_cannot_revive_a_settled_task_but_a_new_start_can() {
        let mut tasks = RunningTaskState::default();
        tasks.observe(["task-1".to_owned()]);
        tasks.settle(Some("task-1"));

        tasks.observe(["task-1".to_owned()]);
        assert!(tasks.active_task_ids.is_empty());

        tasks.start(Some("task-1"));
        assert_eq!(tasks.active_task_ids, HashSet::from(["task-1".to_owned()]));
    }

    #[test]
    fn incomplete_observation_does_not_settle_an_active_task() {
        let mut tasks = RunningTaskState::default();
        tasks.observe(["task-1".to_owned()]);

        tasks.observe([]);

        assert_eq!(tasks.active_task_ids, HashSet::from(["task-1".to_owned()]));
    }

    #[test]
    fn settled_task_bookkeeping_is_bounded() {
        let mut tasks = RunningTaskState::default();
        for index in 0..=MAX_SETTLED_TASK_IDS {
            tasks.settle(Some(&format!("task-{index}")));
        }

        assert_eq!(tasks.settled_task_ids.len(), MAX_SETTLED_TASK_IDS);
        assert!(!tasks.settled_task_ids.contains(&"task-0".to_owned()));
        assert!(tasks
            .settled_task_ids
            .contains(&format!("task-{MAX_SETTLED_TASK_IDS}")));
    }

    #[test]
    fn sleep_inhibition_is_enabled_by_default() {
        assert!(SystemSleepInner::default().enabled);
    }
}
