// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#[cfg(windows)]
#[path = "windows_process.rs"]
mod implementation;

#[cfg(windows)]
pub use implementation::{recover_trial, AppProcess, Parent};

#[cfg(not(windows))]
mod implementation {
    use super::super::Result;
    use std::{
        ffi::OsString,
        path::Path,
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    pub struct Parent(u32);

    pub fn recover_trial(_id: &str) -> Result<()> {
        // Only Windows ships this updater; POSIX has no crash-owned job equivalent.
        Ok(())
    }

    impl Parent {
        pub fn open(pid: u32) -> Result<Self> {
            if pid == 0 || pid > i32::MAX as u32 || pid == std::process::id() {
                return Err("Invalid update parent PID".into());
            }
            Ok(Self(pid))
        }

        pub fn wait(self) -> Result<()> {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if unsafe { libc::kill(self.0 as i32, 0) } != 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::ESRCH) {
                        return Ok(());
                    }
                    return Err(format!("Cannot inspect parent process: {error}"));
                }
                if Instant::now() >= deadline {
                    return Err("Timed out waiting for the desktop to exit".into());
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
    }

    pub struct AppProcess {
        child: Child,
        armed: bool,
    }

    impl AppProcess {
        pub fn spawn(
            executable: &Path,
            root: &Path,
            args: &[OsString],
            transaction: Option<(&str, &str)>,
        ) -> Result<Self> {
            use std::os::unix::process::CommandExt;
            let mut command = Command::new(executable);
            command
                .args(args)
                .current_dir(executable.parent().ok_or("Executable has no directory")?)
                .env("WEWORK_UPDATE_INSTALL_ROOT", root)
                .env_remove("WEWORK_UPDATE_TRANSACTION_ID")
                .env_remove("WEWORK_UPDATE_HEALTH_TOKEN")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            if let Some((id, token)) = transaction {
                command
                    .env("WEWORK_UPDATE_TRANSACTION_ID", id)
                    .env("WEWORK_UPDATE_HEALTH_TOKEN", token);
            }
            let child = command
                .spawn()
                .map_err(|e| format!("Cannot launch desktop: {e}"))?;
            Ok(Self {
                child,
                armed: transaction.is_some(),
            })
        }

        pub fn id(&self) -> u32 {
            self.child.id()
        }

        pub fn exited(&mut self) -> Result<bool> {
            self.child
                .try_wait()
                .map(|status| status.is_some())
                .map_err(|e| e.to_string())
        }

        pub fn disarm(&mut self) -> Result<()> {
            self.armed = false;
            Ok(())
        }

        pub fn terminate(&mut self) -> Result<()> {
            let result = unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!("Cannot stop failed desktop: {error}"));
                }
            }
            self.child.wait().map_err(|e| e.to_string())?;
            self.armed = false;
            Ok(())
        }
    }

    impl Drop for AppProcess {
        fn drop(&mut self) {
            if self.armed {
                let _ = self.terminate();
            }
        }
    }
}

#[cfg(not(windows))]
pub use implementation::{recover_trial, AppProcess, Parent};
