// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::Path;

use tokio::process::Command;

use super::hide_windows_console;

/// Build a subprocess command with Windows console windows hidden by default.
///
/// Every executor subprocess should be created through this function (or
/// [`shell`]) instead of raw `Command::new` so Windows builds cannot
/// reintroduce visible console windows. On non-Windows platforms this is
/// equivalent to `Command::new`.
pub fn command(program: impl AsRef<Path>) -> Command {
    let mut command = Command::new(program.as_ref());
    hide_windows_console(&mut command);
    command
}

/// Synchronous counterpart of [`command`] for code that cannot await.
pub fn command_sync(program: impl AsRef<Path>) -> std::process::Command {
    let mut command = std::process::Command::new(program.as_ref());
    hide_windows_console(&mut command);
    command
}

/// Build a command that runs `command_line` through the platform shell.
///
/// On Unix this is `sh -c`. On Windows it is `cmd /S /C` with the script
/// passed as a single raw argument, so inner quoting survives and the whole
/// shell tree runs under one hidden console.
pub fn shell(command_line: &str) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd");
        command.args(["/S", "/C"]);
        command.raw_arg(format!("\"{}\"", command_line));
        hide_windows_console(&mut command);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("sh");
        command.args(["-c", command_line]);
        command
    }
}
