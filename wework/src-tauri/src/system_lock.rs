use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

pub const SYSTEM_SESSION_LOCK_CHANGED_EVENT: &str = "wework-system-session-lock-changed";

#[derive(Default)]
pub struct SystemLockState {
    locked: AtomicBool,
}

impl SystemLockState {
    fn update<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>, locked: bool) {
        if self.locked.swap(locked, Ordering::SeqCst) == locked {
            return;
        }
        if let Err(error) = app.emit(SYSTEM_SESSION_LOCK_CHANGED_EVENT, locked) {
            log::warn!("Failed to emit system session lock changed event: {error}");
        }
    }

    fn is_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub fn get_system_session_locked(state: tauri::State<'_, SystemLockState>) -> bool {
    state.is_locked()
}

#[cfg(target_os = "macos")]
pub fn setup(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceSessionDidBecomeActiveNotification,
        NSWorkspaceSessionDidResignActiveNotification,
    };

    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let locked_app = app.clone();
    let locked_handler = RcBlock::new(move |_| {
        locked_app
            .state::<SystemLockState>()
            .update(&locked_app, true);
    });
    let unlocked_app = app;
    let unlocked_handler = RcBlock::new(move |_| {
        unlocked_app
            .state::<SystemLockState>()
            .update(&unlocked_app, false);
    });

    // NSNotificationCenter retains both registrations for its own lifetime.
    unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceSessionDidResignActiveNotification),
            None,
            None,
            &locked_handler,
        );
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceSessionDidBecomeActiveNotification),
            None,
            None,
            &unlocked_handler,
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn setup(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::SystemLockState;

    #[test]
    fn lock_state_defaults_to_unlocked() {
        assert!(!SystemLockState::default().is_locked());
    }
}
