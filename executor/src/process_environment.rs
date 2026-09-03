// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, env, path::PathBuf};

#[cfg(unix)]
use std::{
    io::{Read, Seek, SeekFrom},
    process::{Command, ExitStatus, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::{
    io::Read,
    process::Command as WindowsCommand,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use regex::Regex;

const STANDARD_DEVELOPER_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/Library/Apple/usr/bin",
];

#[cfg(unix)]
const SHELL_ENV_DELIMITER: &str = "_WEGENT_SHELL_ENV_DELIMITER_";
#[cfg(unix)]
const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const SHELL_ENV_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const MAX_CAPTURED_STREAM_BYTES: usize = 1024 * 1024;
#[cfg(unix)]
const SHELL_ENV_MARKER: &str = "WEGENT_SHELL_ENV_CAPTURE";
#[cfg(unix)]
const TRANSIENT_SHELL_ENV_KEYS: &[&str] = &[
    "OLDPWD",
    "PWD",
    "SHLVL",
    "_",
    "CODEX_SHELL",
    SHELL_ENV_MARKER,
];

#[cfg(windows)]
const WINDOWS_PATH_READ_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(windows)]
const WINDOWS_PATH_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellEnvironmentLoad {
    pub shell: String,
    pub path_entry_count: usize,
}

pub fn process_env(extra_env: &[(String, String)]) -> HashMap<String, String> {
    let mut values = env::vars().collect::<HashMap<_, _>>();
    values.extend(extra_env.iter().cloned());
    let current_path = values.get("PATH").map(String::as_str).unwrap_or_default();
    let runtime_bin = values.get("WEWORK_RUNTIME_BIN").map(String::as_str);
    let extra_paths = values.get("WEGENT_EXTRA_PATHS").map(String::as_str);
    values.insert(
        "PATH".to_owned(),
        normalized_process_path_with_extra(current_path, runtime_bin, extra_paths),
    );
    values.retain(|key, _| !ignored_process_env_key(key));
    values
}

pub fn normalized_process_path(current_path: &str) -> String {
    normalized_process_path_with_extra(
        current_path,
        env::var("WEWORK_RUNTIME_BIN").ok().as_deref(),
        env::var("WEGENT_EXTRA_PATHS").ok().as_deref(),
    )
}

pub fn hydrate_process_environment() -> Result<Option<ShellEnvironmentLoad>, String> {
    #[cfg(unix)]
    {
        let shells = shell_candidates();
        let loaded = load_shell_environment_from_candidates(&shells, SHELL_ENV_TIMEOUT)?;
        let values = merged_shell_environment(env::vars().collect(), &loaded);
        let path_entry_count = values
            .get("PATH")
            .map(|path| env::split_paths(path).count())
            .unwrap_or_default();
        for (key, value) in values {
            env::set_var(key, value);
        }
        Ok(Some(ShellEnvironmentLoad {
            shell: loaded.shell,
            path_entry_count,
        }))
    }

    #[cfg(windows)]
    {
        // Windows has no login shell to capture, so merge the current user and
        // machine PATH from the registry instead. A GUI app inherits PATH from
        // its parent, which may predate a `setx`/Settings PATH edit, so the
        // executor would otherwise never see tools a fresh pwsh can resolve.
        let (machine_path, user_path) = windows_registry_paths()?;
        let current_path = env::var("PATH").unwrap_or_default();
        let mut merged = Vec::new();
        for value in [machine_path, user_path].into_iter().flatten() {
            append_unique_windows_path(&mut merged, &value);
        }
        // Keep parent-provided entries that are not in the registry so extra
        // developer/runtime directories survive a refresh.
        append_unique_windows_path(&mut merged, &current_path);
        let merged = env::join_paths(merged)
            .map_err(|error| format!("Failed to join Windows PATH entries: {error}"))?;
        let merged = merged.to_string_lossy().into_owned();
        let path_entry_count = env::split_paths(&merged).count();
        env::set_var("PATH", &merged);
        Ok(Some(ShellEnvironmentLoad {
            shell: "windows-registry".to_owned(),
            path_entry_count,
        }))
    }
}

#[cfg(windows)]
fn windows_registry_paths() -> Result<(Option<String>, Option<String>), String> {
    let system_root = env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
    let powershell = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let script = format!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
        [string]::Join('===', @([Environment]::GetEnvironmentVariable('Path','Machine'),\
        [Environment]::GetEnvironmentVariable('Path','User')))"
    );
    let mut child = WindowsCommand::new(&powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!("Failed to read Windows registry PATH with {powershell}: {error}")
        })?;

    // Drain stdout and stderr on dedicated threads while the main thread waits
    // with a deadline, mirroring the bounded Unix shell capture. A registry
    // PATH can exceed the pipe buffer, so a naive wait-then-read would
    // deadlock, and an unbounded wait would hang executor startup.
    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "PowerShell stdout pipe is unavailable".to_owned())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "PowerShell stderr pipe is unavailable".to_owned())?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout_pipe.read_to_end(&mut bytes);
        (bytes, result)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stderr_pipe.read_to_end(&mut bytes);
        (bytes, result)
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|error| {
            format!("Failed to wait for PowerShell registry PATH lookup: {error}")
        })? {
            Some(status) => break status,
            None => {
                if started.elapsed() >= WINDOWS_PATH_READ_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Timed out reading the Windows registry PATH".to_owned());
                }
                thread::sleep(WINDOWS_PATH_POLL_INTERVAL);
            }
        }
    };
    let (stdout_bytes, stdout_result) = stdout_reader
        .join()
        .map_err(|_| "PowerShell stdout reader thread panicked".to_owned())?;
    let (stderr_bytes, stderr_result) = stderr_reader
        .join()
        .map_err(|_| "PowerShell stderr reader thread panicked".to_owned())?;
    stdout_result.map_err(|error| format!("Failed to read PowerShell stdout: {error}"))?;
    stderr_result.map_err(|error| format!("Failed to read PowerShell stderr: {error}"))?;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_owned();
        return Err(if stderr.is_empty() {
            "PowerShell failed to read the Windows registry PATH".to_owned()
        } else {
            stderr
        });
    }
    let combined = String::from_utf8(stdout_bytes)
        .map_err(|error| format!("PowerShell PATH output is not valid UTF-8: {error}"))?
        .trim()
        .to_owned();
    let (machine_path, user_path) = match combined.split_once("===") {
        Some((machine, user)) => (machine, user),
        None => (combined.as_str(), ""),
    };
    let machine_path = if machine_path.is_empty() {
        None
    } else {
        Some(machine_path.to_owned())
    };
    let user_path = if user_path.is_empty() {
        None
    } else {
        Some(user_path.to_owned())
    };
    Ok((machine_path, user_path))
}

#[cfg(windows)]
fn append_unique_windows_path(paths: &mut Vec<std::path::PathBuf>, value: &str) {
    for path in env::split_paths(value) {
        if path.as_os_str().is_empty() {
            continue;
        }
        let normalized = path.to_string_lossy().to_lowercase();
        if !paths
            .iter()
            .any(|existing| existing.to_string_lossy().to_lowercase() == normalized)
        {
            paths.push(path);
        }
    }
}

fn normalized_process_path_with_extra(
    current_path: &str,
    runtime_bin: Option<&str>,
    extra_paths: Option<&str>,
) -> String {
    let mut paths = Vec::new();
    if let Some(runtime_bin) = runtime_bin {
        append_path_entries(&mut paths, runtime_bin);
    }
    append_path_entries(&mut paths, current_path);
    if let Some(extra_paths) = extra_paths {
        append_path_entries(&mut paths, extra_paths);
    }
    for path in STANDARD_DEVELOPER_PATHS {
        append_unique_path(&mut paths, PathBuf::from(path));
    }

    env::join_paths(paths)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| current_path.to_owned())
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct LoadedShellEnvironment {
    shell: String,
    values: HashMap<String, String>,
}

#[cfg(unix)]
fn load_shell_environment_from_candidates(
    shells: &[String],
    timeout: Duration,
) -> Result<LoadedShellEnvironment, String> {
    let mut last_error = None;
    for shell in shells {
        match capture_shell_environment(shell, timeout) {
            Ok(mut values) => {
                values.insert("SHELL".to_string(), shell.clone());
                return Ok(LoadedShellEnvironment {
                    shell: shell.clone(),
                    values,
                });
            }
            Err(error) => last_error = Some(format!("{shell}: {error}")),
        }
    }
    Err(last_error.unwrap_or_else(|| "No supported login shell was found".to_string()))
}

#[cfg(unix)]
fn shell_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(shell) = login_shell_from_user_database() {
        append_unique_shell(&mut candidates, shell);
    }
    if let Ok(shell) = env::var("SHELL") {
        append_unique_shell(&mut candidates, shell);
    }
    append_unique_shell(&mut candidates, "/bin/zsh".to_string());
    append_unique_shell(&mut candidates, "/bin/bash".to_string());
    append_unique_shell(&mut candidates, "/bin/sh".to_string());
    candidates
}

#[cfg(unix)]
fn append_unique_shell(shells: &mut Vec<String>, shell: String) {
    let shell = shell.trim();
    if shell.is_empty() || shells.iter().any(|candidate| candidate == shell) {
        return;
    }
    shells.push(shell.to_string());
}

#[cfg(unix)]
fn login_shell_from_user_database() -> Option<String> {
    use std::{ffi::CStr, mem, ptr};

    let buffer_size = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let buffer_size = if buffer_size <= 0 {
        16 * 1024
    } else {
        usize::try_from(buffer_size).ok()?.clamp(1024, 1024 * 1024)
    };
    let mut password_entry = unsafe { mem::zeroed::<libc::passwd>() };
    let mut result = ptr::null_mut();
    let mut buffer = vec![0_u8; buffer_size];
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut password_entry,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || password_entry.pw_shell.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(password_entry.pw_shell) }
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|shell| !shell.is_empty())
        .map(str::to_string)
}

#[cfg(unix)]
fn capture_shell_environment(
    shell: &str,
    timeout: Duration,
) -> Result<HashMap<String, String>, String> {
    let mut stdout = tempfile::tempfile()
        .map_err(|error| format!("failed to create login shell stdout capture: {error}"))?;
    let stderr = tempfile::tempfile()
        .map_err(|error| format!("failed to create login shell stderr capture: {error}"))?;
    let script = format!(
        "printf '%s' '{0}'; command env; printf '%s' '{0}'; exit",
        SHELL_ENV_DELIMITER
    );
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .env("CODEX_SHELL", "1")
        .env(SHELL_ENV_MARKER, "1")
        .env("DISABLE_AUTO_UPDATE", "true")
        .env("ZSH_TMUX_AUTOSTARTED", "true")
        .env("ZSH_TMUX_AUTOSTART", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout.try_clone().map_err(|error| {
            format!("failed to clone login shell stdout: {error}")
        })?))
        .stderr(Stdio::from(stderr.try_clone().map_err(|error| {
            format!("failed to clone login shell stderr: {error}")
        })?))
        .spawn()
        .map_err(|error| format!("failed to start login shell: {error}"))?;

    let status = wait_for_child(&mut child, timeout)?;
    if !status.success() {
        let stderr_bytes = stderr
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        return Err(format!(
            "login shell exited with {status}; stderr_bytes={}",
            stderr_bytes
        ));
    }
    stdout
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("failed to rewind login shell stdout: {error}"))?;
    parse_shell_environment(&String::from_utf8_lossy(&read_stream_with_limit(stdout)))
}

#[cfg(unix)]
fn read_stream_with_limit(mut stream: impl Read) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8192];
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let remaining = MAX_CAPTURED_STREAM_BYTES.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    captured
}

#[cfg(unix)]
fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<ExitStatus, String> {
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started_at.elapsed() < timeout => {
                thread::sleep(SHELL_ENV_POLL_INTERVAL);
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "login shell environment load timed out after {}ms",
                    timeout.as_millis()
                ));
            }
            Err(error) => return Err(format!("failed to wait for login shell: {error}")),
        }
    }
}

#[cfg(unix)]
fn parse_shell_environment(output: &str) -> Result<HashMap<String, String>, String> {
    let Some((_, delimited)) = output.split_once(SHELL_ENV_DELIMITER) else {
        return Err("login shell output did not contain the first delimiter".to_string());
    };
    let Some((environment, _)) = delimited.split_once(SHELL_ENV_DELIMITER) else {
        return Err("login shell output did not contain the closing delimiter".to_string());
    };
    let environment = strip_ansi_codes(environment);
    let mut values = HashMap::new();
    for line in environment.lines() {
        let Some((key, value)) = line.trim_end().split_once('=') else {
            continue;
        };
        if !key.is_empty() && !TRANSIENT_SHELL_ENV_KEYS.contains(&key) {
            values.insert(key.to_string(), value.to_string());
        }
    }
    if values.is_empty() {
        return Err("login shell returned an empty environment".to_string());
    }
    Ok(values)
}

#[cfg(unix)]
fn strip_ansi_codes(value: &str) -> String {
    static ANSI_PATTERN: OnceLock<Regex> = OnceLock::new();
    ANSI_PATTERN
        .get_or_init(|| {
            Regex::new(r"(?:\x1B\][\s\S]*?(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~])")
                .expect("ANSI escape pattern should compile")
        })
        .replace_all(value, "")
        .into_owned()
}

#[cfg(unix)]
fn merged_shell_environment(
    process_environment: HashMap<String, String>,
    shell_environment: &LoadedShellEnvironment,
) -> HashMap<String, String> {
    let mut merged = process_environment.clone();
    merged.extend(shell_environment.values.clone());
    for (key, value) in process_environment {
        if protected_executor_env_key(&key) {
            merged.insert(key, value);
        }
    }
    let current_path = merged.get("PATH").map(String::as_str).unwrap_or_default();
    let runtime_bin = merged.get("WEWORK_RUNTIME_BIN").map(String::as_str);
    let extra_paths = merged.get("WEGENT_EXTRA_PATHS").map(String::as_str);
    merged.insert(
        "PATH".to_string(),
        normalized_process_path_with_extra(current_path, runtime_bin, extra_paths),
    );
    merged
}

#[cfg(unix)]
fn protected_executor_env_key(key: &str) -> bool {
    key.starts_with("WEGENT_")
        || key.starts_with("WEWORK_")
        || key.starts_with("DEVICE_")
        || key.starts_with("EXECUTOR_")
        || matches!(
            key,
            "AUTH_TOKEN"
                | "BIND_SHELL"
                | "CLAUDE_BINARY_PATH"
                | "CLAUDE_BIN"
                | "CODEX_BINARY_PATH"
                | "CODEX_BIN"
                | "CODEX_HOME"
                | "HOME"
                | "LOCAL_WORKSPACE_ROOT"
                | "TASK_API_DOMAIN"
        )
}

fn append_path_entries(paths: &mut Vec<PathBuf>, value: &str) {
    for path in env::split_paths(value) {
        append_unique_path(paths, path);
    }
}

fn append_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() || paths.iter().any(|existing| existing == &path) {
        return;
    }
    paths.push(path);
}

fn ignored_process_env_key(key: &str) -> bool {
    key.starts_with("_PYI_")
        || key.starts_with("_MEI_")
        || key.starts_with("BASH_FUNC_")
        || key == "_MEIPASS"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn shell_environment_parser_ignores_noise_and_transient_values() {
        let output = format!(
            "welcome\u{1b}[31m!\u{1b}[0m{0}PATH=/Users/test/.npm-global/bin:/usr/bin\n\
             TOKEN=value=with=equals\nPWD=/tmp\nSHLVL=2\n{0}goodbye",
            SHELL_ENV_DELIMITER
        );

        let environment = parse_shell_environment(&output).expect("environment should parse");

        assert_eq!(
            environment.get("PATH").map(String::as_str),
            Some("/Users/test/.npm-global/bin:/usr/bin")
        );
        assert_eq!(
            environment.get("TOKEN").map(String::as_str),
            Some("value=with=equals")
        );
        assert!(!environment.contains_key("PWD"));
        assert!(!environment.contains_key("SHLVL"));
    }

    #[cfg(unix)]
    #[test]
    fn shell_environment_loader_falls_back_to_the_next_shell() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp directory should be created");
        let script_path = directory.path().join("shell");
        let script = format!(
            "#!/bin/sh\nprintf 'startup noise{0}PATH=/Users/test/.npm-global/bin:/usr/bin\\n\
             CUSTOM_ENV=loaded\\n{0}'\n",
            SHELL_ENV_DELIMITER
        );
        std::fs::write(&script_path, script).expect("script should be written");
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700))
            .expect("script should be executable");

        // The whole test binary shares a thread pool, so a generous timeout
        // keeps this stable while hundreds of other tests run in parallel.
        let environment = load_shell_environment_from_candidates(
            &[
                "/missing/wework-shell".to_string(),
                script_path.display().to_string(),
            ],
            Duration::from_secs(30),
        )
        .expect("fallback shell should load");

        assert_eq!(environment.shell, script_path.display().to_string());
        assert_eq!(
            environment.values.get("PATH").map(String::as_str),
            Some("/Users/test/.npm-global/bin:/usr/bin")
        );
        assert_eq!(
            environment.values.get("CUSTOM_ENV").map(String::as_str),
            Some("loaded")
        );
        assert_eq!(
            environment.values.get("SHELL").map(String::as_str),
            Some(script_path.to_string_lossy().as_ref())
        );
    }

    #[cfg(unix)]
    #[test]
    fn merged_shell_environment_preserves_shell_path_order_and_executor_values() {
        let process_environment = HashMap::from([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("HOME".to_string(), "/isolated/wework".to_string()),
            ("DEVICE_ID".to_string(), "parent-device".to_string()),
            (
                "CODEX_HOME".to_string(),
                "/isolated/wework/codex".to_string(),
            ),
            (
                "WEWORK_RUNTIME_BIN".to_string(),
                "/isolated/wework/runtime/bin".to_string(),
            ),
        ]);
        let shell_environment = LoadedShellEnvironment {
            shell: "/bin/zsh".to_string(),
            values: HashMap::from([
                (
                    "PATH".to_string(),
                    "/Users/test/.npm-global/bin:/usr/bin:/bin".to_string(),
                ),
                ("SHELL".to_string(), "/bin/zsh".to_string()),
                ("HOME".to_string(), "/Users/test".to_string()),
                ("DEVICE_ID".to_string(), "profile-device".to_string()),
                ("CODEX_HOME".to_string(), "/Users/test/.codex".to_string()),
            ]),
        };

        let merged = merged_shell_environment(process_environment, &shell_environment);

        assert!(merged["PATH"]
            .starts_with("/isolated/wework/runtime/bin:/Users/test/.npm-global/bin:/usr/bin:/bin"));
        assert!(merged["PATH"].contains("/opt/homebrew/bin"));
        assert_eq!(merged["SHELL"], "/bin/zsh");
        assert_eq!(merged["HOME"], "/isolated/wework");
        assert_eq!(merged["DEVICE_ID"], "parent-device");
        assert_eq!(merged["CODEX_HOME"], "/isolated/wework/codex");
        assert_eq!(merged["WEWORK_RUNTIME_BIN"], "/isolated/wework/runtime/bin");
    }

    #[cfg(unix)]
    #[test]
    fn child_wait_times_out() {
        let mut child = Command::new("/bin/sleep")
            .arg("10")
            .spawn()
            .expect("sleep process should start");

        let error = wait_for_child(&mut child, Duration::from_millis(50))
            .expect_err("child wait should time out");

        assert!(error.contains("timed out"), "unexpected error: {error}");
    }
}
