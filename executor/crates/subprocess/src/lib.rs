//! Platform process creation, output collection, and child-tree lifetime primitives.

#[cfg(windows)]
use std::{env, path::Path};
use std::{path::PathBuf, process::Stdio};
use tokio::{io::AsyncWriteExt, process::Command};
#[cfg(windows)]
use wegent_runtime_logging::log_executor_event;
#[cfg(windows)]
mod windows_batch;
#[cfg(windows)]
pub use windows_batch::shell_command as windows_shell_command;

pub struct ProcessTreeGuard {
    #[cfg(windows)]
    pid: Option<u32>,
}

impl ProcessTreeGuard {
    pub fn new(pid: Option<u32>) -> Self {
        #[cfg(not(windows))]
        let _ = pid;
        Self {
            #[cfg(windows)]
            pid,
        }
    }

    pub fn disarm(&mut self) {
        #[cfg(windows)]
        {
            self.pid = None;
        }
    }

    pub fn terminate(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.pid.take() {
            kill_windows_process_tree(pid);
        }
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(windows)]
pub fn kill_windows_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = pid.to_string();
    let status = std::process::Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    match status {
        Ok(status) if !status.success() => log_executor_event(
            "windows process tree termination failed",
            &[("pid", pid), ("exit_status", status.to_string())],
        ),
        Err(error) => log_executor_event(
            "windows process tree termination failed",
            &[("pid", pid), ("error", error.to_string())],
        ),
        Ok(_) => {}
    }
}

/// Returns the effective program and any prefix arguments for a spawn.
///
/// On Windows, npm/node-style batch shims are resolved to their native
/// executable so that arguments containing newlines (common in agent prompts)
/// can be passed through directly instead of being rejected by `cmd.exe` with
/// `batch file arguments are invalid`. Other platforms return the program
/// unchanged.
pub fn spawn_program_parts(program: &str) -> (PathBuf, Vec<String>) {
    #[cfg(windows)]
    {
        let search_path = env::var_os("PATH");
        let program_path =
            windows_batch::resolve_program_path(Path::new(program), search_path.as_deref());
        if windows_batch::is_batch_file(&program_path) {
            if let Some(target) = windows_batch::resolve_batch_target(&program_path) {
                return (target.program, target.prefix_args);
            }
        }
        (program_path, Vec::new())
    }
    #[cfg(not(windows))]
    (PathBuf::from(program), Vec::new())
}

pub async fn run_prepared_command(
    mut command: Command,
    stdin: Option<String>,
) -> std::io::Result<std::process::Output> {
    hide_windows_console(&mut command);
    let Some(input) = stdin else {
        return command.output().await;
    };

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let writer = child.stdin.take().map(|mut child_stdin| {
        tokio::spawn(async move { child_stdin.write_all(input.as_bytes()).await })
    });
    let output = child.wait_with_output().await;
    if let Some(writer) = writer {
        if let Ok(Err(error)) = writer.await {
            if output.as_ref().is_ok_and(|output| output.status.success()) {
                return Err(error);
            }
        }
    }
    output
}

pub fn decode_output(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

#[cfg(windows)]
mod windows_console {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub trait HideConsole {
        fn hide_console(&mut self);
    }

    impl HideConsole for std::process::Command {
        fn hide_console(&mut self) {
            self.creation_flags(CREATE_NO_WINDOW);
        }
    }

    impl HideConsole for tokio::process::Command {
        fn hide_console(&mut self) {
            self.creation_flags(CREATE_NO_WINDOW);
        }
    }
}

#[cfg(windows)]
pub fn hide_windows_console<C: windows_console::HideConsole>(command: &mut C) {
    command.hide_console();
}

#[cfg(not(windows))]
pub fn hide_windows_console<C>(_command: &mut C) {}

pub mod process_service;

mod command_spec;
pub use command_spec::{CommandOutcome, CommandSpec};

pub mod environment;
