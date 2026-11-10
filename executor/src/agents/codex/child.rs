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
use crate::server::codex_model_catalog::ProcessCatalog;

/// Keeps a Home's authentication ownership until its native process exits,
/// including when startup or a running turn is cancelled by dropping its future.
pub(super) struct CodexAppServerChild {
    child: Option<Child>,
    auth_lease: Option<FileLease>,
    catalog: Option<ProcessCatalog>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    exit: super::process_exit::ExitProgress,
}

impl CodexAppServerChild {
    pub(super) fn new(child: Child, auth_lease: Option<FileLease>) -> Self {
        Self {
            child: Some(child),
            auth_lease,
            catalog: None,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            exit: Default::default(),
        }
    }

    pub(super) fn hold_catalog(&mut self, catalog: Option<ProcessCatalog>) {
        self.catalog = catalog;
    }

    pub(super) async fn kill(&mut self) -> std::io::Result<()> {
        signal_codex_app_server_child(self);
        self.wait().await.map(|_| ())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let child = self.child.as_mut().expect("owned child remains present");
        if self.exit.reaped || child.id().is_none() {
            child.try_wait()
        } else {
            super::process_exit::status(child)
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let child = self.child.as_mut().expect("owned child remains present");
        while !self.exit.try_reap(child) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        child.wait().await
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
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if self.exit.reaped {
            return;
        }
        if self.child.is_none() {
            return;
        }
        signal_codex_app_server_child(self);
        let Some(mut child) = self.child.take() else {
            return;
        };
        let lease = self.auth_lease.take();
        let catalog = self.catalog.take();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if self.exit.try_reap(&mut child) {
            return;
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        if lease.is_none() && catalog.is_none() {
            return;
        }
        let cleanup = Arc::new(Mutex::new(Some(ReapResources {
            child,
            _auth_lease: lease,
            _catalog: catalog,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            exit: std::mem::take(&mut self.exit),
        })));
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

struct ReapResources {
    child: Child,
    _auth_lease: Option<FileLease>,
    _catalog: Option<ProcessCatalog>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    exit: super::process_exit::ExitProgress,
}

type ReapState = Arc<Mutex<Option<ReapResources>>>;

fn reap(state: ReapState) {
    let Some(mut resources) = state.lock().unwrap().take() else {
        return;
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    while !resources.exit.try_reap(&mut resources.child) {
        std::thread::sleep(Duration::from_millis(10));
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    while !matches!(resources.child.try_wait(), Ok(Some(_))) {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
impl From<Child> for CodexAppServerChild {
    fn from(child: Child) -> Self {
        Self::new(child, None)
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;
    use fs2::FileExt;

    #[test]
    fn native_writer_fixture() {
        let Some(root) = std::env::var_os("WEGENT_TEST_NATIVE_WRITER_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let writer = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("writer.lock"))
            .unwrap();
        writer.try_lock_exclusive().unwrap();
        std::fs::write(root.join("writer-ready"), b"").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[tokio::test]
    async fn exited_wrapper_retains_ownership_until_its_native_descendants_exit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ownership.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.try_lock_exclusive().unwrap();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "\"$1\" --exact agents::codex::child::tests::native_writer_fixture --nocapture & exit 0", "--"])
            .arg(std::env::current_exe().unwrap())
            .env("WEGENT_TEST_NATIVE_WRITER_ROOT", root.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        super::super::configure_codex_app_server_process_group(&mut command);
        let raw = command.spawn().unwrap();
        let group = raw.id().unwrap();
        let mut child = CodexAppServerChild::new(raw, Some(FileLease(file)));
        tokio::time::timeout(Duration::from_secs(5), async {
            while child.try_wait().unwrap().is_none() || !root.path().join("writer-ready").exists()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(super::super::process_exit::descendants_running(group).unwrap());
        drop(child);
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        let writer_probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.path().join("writer.lock"))
            .unwrap();
        let premature = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if probe.try_lock_exclusive().is_ok() {
                    break writer_probe.try_lock_exclusive().is_err();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if premature {
            // SAFETY: the still-live descendants retain this fixture's reserved group ID.
            unsafe {
                libc::kill(-(group as libc::pid_t), libc::SIGKILL);
            }
        }
        assert!(
            !premature,
            "Home ownership was released while the wrapped native process was alive"
        );
    }
}
