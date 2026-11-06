// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::process::Child;

use super::signal_codex_app_server_child;
use crate::file_lease::FileLease;

/// Keeps a Home's authentication ownership until its native process exits,
/// including when startup or a running turn is cancelled by dropping its future.
pub(super) struct CodexAppServerChild {
    child: Option<Child>,
    auth_lease: Option<FileLease>,
}

impl CodexAppServerChild {
    pub(super) fn new(child: Child, auth_lease: Option<FileLease>) -> Self {
        Self {
            child: Some(child),
            auth_lease,
        }
    }
}

impl Deref for CodexAppServerChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        self.child
            .as_ref()
            .expect("Codex child is present until drop")
    }
}

impl DerefMut for CodexAppServerChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.child
            .as_mut()
            .expect("Codex child is present until drop")
    }
}

impl Drop for CodexAppServerChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        signal_codex_app_server_child(&mut child);
        let Some(lease) = self.auth_lease.take() else {
            return;
        };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let cleanup = Arc::new(Mutex::new(Some((child, lease))));
        let worker = Arc::clone(&cleanup);
        // A separate reaper remains valid while the Tokio runtime is shutting
        // down. Normal awaited teardown has already reaped the child above.
        if std::thread::Builder::new()
            .name("codex-auth-reaper".to_owned())
            .spawn(move || reap(worker))
            .is_err()
        {
            reap(cleanup);
        }
    }
}

type ReapState = Arc<Mutex<Option<(Child, FileLease)>>>;

fn reap(state: ReapState) {
    let Some((mut child, _lease)) = state.lock().unwrap().take() else {
        return;
    };
    while !matches!(child.try_wait(), Ok(Some(_))) {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
impl From<Child> for CodexAppServerChild {
    fn from(child: Child) -> Self {
        Self::new(child, None)
    }
}
