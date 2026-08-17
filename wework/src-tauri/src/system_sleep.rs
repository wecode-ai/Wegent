use std::collections::{HashSet, VecDeque};
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_foundation::string::CFString;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const MAX_SETTLED_TASK_IDS: usize = 256;
#[cfg(target_os = "macos")]
const MACOS_ASSERTION_REASON: &str = "Wework local task is running";
#[cfg(target_os = "macos")]
const MACOS_ASSERTION_TYPE: &str = "PreventUserIdleSystemSleep";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

#[cfg(target_os = "windows")]
struct SleepInhibitor {
    thread_id: u32,
}

#[cfg(target_os = "macos")]
struct SleepInhibitor {
    _assertion: MacSleepAssertion,
}

#[cfg(target_os = "linux")]
struct SleepInhibitor {
    child: Child,
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
struct SleepInhibitor;

impl SleepInhibitor {
    fn acquire() -> Result<Self, String> {
        acquire_sleep_inhibitor()
    }
}

#[cfg(target_os = "windows")]
fn acquire_sleep_inhibitor() -> Result<SleepInhibitor, String> {
    // Call SetThreadExecutionState directly so no console window is created.
    // ES_SYSTEM_REQUIRED (0x00000001) resets the system idle timer and keeps
    // the system awake while the thread is active; ES_CONTINUOUS (0x80000000)
    // keeps the state in effect until reset. Reset happens in Drop by calling
    // again with ES_CONTINUOUS on the same OS thread that acquired it.
    unsafe {
        let result = windows_sys::Win32::System::Power::SetThreadExecutionState(
            windows_sys::Win32::System::Power::ES_SYSTEM_REQUIRED
                | windows_sys::Win32::System::Power::ES_CONTINUOUS,
        );
        if result == 0 {
            return Err("SetThreadExecutionState returned zero".to_owned());
        }
    }
    Ok(SleepInhibitor {
        thread_id: unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() },
    })
}

#[cfg(target_os = "macos")]
fn acquire_sleep_inhibitor() -> Result<SleepInhibitor, String> {
    MacSleepAssertion::create(MACOS_ASSERTION_REASON).map(|assertion| SleepInhibitor {
        _assertion: assertion,
    })
}

#[cfg(target_os = "macos")]
struct MacSleepAssertion {
    id: u32,
}

#[cfg(target_os = "macos")]
impl MacSleepAssertion {
    fn create(name: &str) -> Result<Self, String> {
        let assertion_type = CFString::new(MACOS_ASSERTION_TYPE);
        let assertion_name = CFString::new(name);
        let mut id = 0;
        let result = unsafe {
            IOPMAssertionCreateWithName(
                assertion_type.as_concrete_TypeRef().cast(),
                MACOS_ASSERTION_LEVEL_ON,
                assertion_name.as_concrete_TypeRef().cast(),
                &mut id,
            )
        };
        if result == MACOS_IO_RETURN_SUCCESS {
            Ok(Self { id })
        } else {
            Err(format!(
                "IOPMAssertionCreateWithName returned error {result}"
            ))
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacSleepAssertion {
    fn drop(&mut self) {
        let result = unsafe { IOPMAssertionRelease(self.id) };
        if result != MACOS_IO_RETURN_SUCCESS {
            log::warn!("Failed to release macOS sleep assertion: IOKit error {result}");
        }
    }
}

#[cfg(target_os = "macos")]
type MacosCfStringRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type MacosIoReturn = std::ffi::c_int;
#[cfg(target_os = "macos")]
const MACOS_IO_RETURN_SUCCESS: MacosIoReturn = 0;
#[cfg(target_os = "macos")]
const MACOS_ASSERTION_LEVEL_ON: u32 = 255;

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(
        assertion_type: MacosCfStringRef,
        assertion_level: u32,
        assertion_name: MacosCfStringRef,
        assertion_id: *mut u32,
    ) -> MacosIoReturn;

    fn IOPMAssertionRelease(assertion_id: u32) -> MacosIoReturn;
}

#[cfg(target_os = "linux")]
fn acquire_sleep_inhibitor() -> Result<SleepInhibitor, String> {
    let mut command = Command::new("systemd-inhibit");
    command.args([
        "--what=sleep",
        "--who=Wework",
        "--why=Local task is running",
        "--mode=block",
        "sleep",
        "infinity",
    ]);
    let child = spawn_inhibitor_command(command)?;
    Ok(SleepInhibitor { child })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn acquire_sleep_inhibitor() -> Result<SleepInhibitor, String> {
    Err("system sleep inhibition is not supported on this platform".to_owned())
}

#[cfg(target_os = "linux")]
fn spawn_inhibitor_command(mut command: Command) -> Result<Child, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start sleep inhibitor: {error}"))
}

#[cfg(target_os = "windows")]
impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        let current_thread_id =
            unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() };
        if current_thread_id != self.thread_id {
            log::warn!(
                "Sleep inhibitor dropped on a different OS thread than it was acquired on; \
                 leaving ES_CONTINUOUS state in place"
            );
            return;
        }
        unsafe {
            windows_sys::Win32::System::Power::SetThreadExecutionState(
                windows_sys::Win32::System::Power::ES_CONTINUOUS,
            );
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        if let Err(error) = self.child.kill() {
            log::warn!("Failed to stop system sleep inhibitor: {error}");
        }
        let _ = self.child.wait();
    }
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
