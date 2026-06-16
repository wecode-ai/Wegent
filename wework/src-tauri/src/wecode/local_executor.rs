use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(not(target_os = "windows"))]
const WECODE_CLI_INSTALL_SCRIPT_UNIX: &str = "https://git.intra.weibo.com/api/v4/projects/weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/repository/files/scripts%2Finstall.sh/raw?ref=master";
#[cfg(target_os = "windows")]
const WECODE_CLI_INSTALL_SCRIPT_WINDOWS: &str = "https://git.intra.weibo.com/api/v4/projects/weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/repository/files/scripts%2Finstall.ps1/raw?ref=master";
const EXECUTOR_GATEWAY_PORT: u16 = 17888;
const EXECUTOR_GATEWAY_PORT_RANGE_START: u16 = 17888;
const EXECUTOR_GATEWAY_PORT_RANGE_END: u16 = 17988;

#[derive(Serialize)]
pub(crate) struct WecodeCommandResult {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct ExecutorCommandOutput {
    execution_id: String,
    stream: String,
    content: String,
}

#[derive(Serialize)]
pub(crate) struct WecodeCliStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct NodeStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    major_version: Option<u32>,
    meets_minimum: bool,
    error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct StartupEnvVar {
    key: String,
    value: String,
    enabled: bool,
    sensitive: bool,
}

#[derive(Serialize)]
pub(crate) struct ExecutorStatus {
    node: NodeStatus,
    cli: WecodeCliStatus,
    installed: bool,
    running: bool,
    pid: Option<u32>,
    version: Option<String>,
    output: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct LocalProcessInfo {
    pid: u32,
    parent_pid: Option<u32>,
    command: String,
    is_executor_like: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct PortOccupantInfo {
    port: u16,
    pid: u32,
    command: String,
    is_executor_like: bool,
}

#[derive(Serialize)]
pub(crate) struct ExecutorProcessDiagnostics {
    processes: Vec<LocalProcessInfo>,
    port_occupants: Vec<PortOccupantInfo>,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct LocalExecutorRuntimeConfig {
    gateway_port: u16,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn candidate_path_dirs() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path));
    }

    paths.push(PathBuf::from("/opt/homebrew/bin"));
    paths.push(PathBuf::from("/usr/local/bin"));
    paths.push(PathBuf::from("/usr/bin"));
    paths.push(PathBuf::from("/bin"));
    paths.push(PathBuf::from("/usr/sbin"));
    paths.push(PathBuf::from("/sbin"));

    #[cfg(windows)]
    {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(program_files).join("nodejs"));
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            paths.push(PathBuf::from(program_files_x86).join("nodejs"));
        }
    }

    if let Some(home) = home_dir() {
        paths.push(home.join(".wecode").join("bin"));
        paths.push(home.join(".wecode").join("wecode-cli").join("bin"));
        paths.push(home.join(".nvm").join("current").join("bin"));

        #[cfg(windows)]
        {
            paths.push(home.join("AppData").join("Roaming").join("npm"));
        }
    }

    for path in candidate_node_paths()
        .into_iter()
        .chain(candidate_wecode_paths().into_iter())
    {
        if path.is_absolute() {
            if let Some(parent) = path.parent() {
                paths.push(parent.to_path_buf());
            }
        }
    }

    dedupe_paths(paths)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if path.as_os_str().is_empty() {
            continue;
        }
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn build_command_path() -> Option<OsString> {
    env::join_paths(candidate_path_dirs()).ok()
}

fn apply_command_env(command: &mut Command) {
    if let Some(path) = build_command_path() {
        command.env("PATH", path);
    }
}

fn candidate_wecode_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(path) = env::var("WECODE_CLI_PATH") {
        if !path.trim().is_empty() {
            paths.push(PathBuf::from(path));
        }
    }

    paths.push(PathBuf::from("wecode"));

    #[cfg(windows)]
    {
        paths.push(PathBuf::from("wecode.cmd"));
        paths.push(PathBuf::from("wecode.exe"));
    }

    if let Some(home) = home_dir() {
        paths.push(
            home.join(".wecode")
                .join("bin")
                .join(executable_name("wecode")),
        );
        paths.push(
            home.join(".wecode")
                .join("wecode-cli")
                .join("bin")
                .join(executable_name("wecode")),
        );
    }

    paths
}

fn candidate_node_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(path) = env::var("NODE_PATH") {
        if !path.trim().is_empty() {
            paths.push(PathBuf::from(path));
        }
    }

    paths.push(PathBuf::from("node"));

    #[cfg(windows)]
    {
        paths.push(PathBuf::from("node.exe"));
    }

    paths.push(PathBuf::from("/opt/homebrew/bin/node"));
    paths.push(PathBuf::from("/usr/local/bin/node"));

    if let Some(home) = home_dir() {
        paths.push(home.join(".nvm").join("current").join("bin").join("node"));
    }

    paths
}

fn executable_name(name: &str) -> String {
    #[cfg(windows)]
    {
        format!("{name}.cmd")
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn command_output_to_result(output: Output) -> WecodeCommandResult {
    WecodeCommandResult {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    }
}

fn run_wecode_args(path: &PathBuf, args: &[&str]) -> Result<WecodeCommandResult, String> {
    run_wecode_args_with_env(path, args, &[])
}

fn run_wecode_args_with_env(
    path: &PathBuf,
    args: &[&str],
    env_vars: &[StartupEnvVar],
) -> Result<WecodeCommandResult, String> {
    let mut command = Command::new(path);
    command.args(args);
    apply_command_env(&mut command);

    for env_var in env_vars.iter().filter(|item| item.enabled) {
        let key = env_var.key.trim();
        if is_valid_env_key(key) {
            command.env(key, &env_var.value);
        }
    }

    let output = command
        .output()
        .map_err(|error| format!("Failed to run wecode: {error}"))?;

    Ok(command_output_to_result(output))
}

fn run_wecode_args_with_env_streaming(
    app: &AppHandle,
    execution_id: &str,
    path: &PathBuf,
    args: &[&str],
    env_vars: &[StartupEnvVar],
) -> Result<WecodeCommandResult, String> {
    let command_env = env_vars
        .iter()
        .filter(|item| item.enabled && is_valid_env_key(item.key.trim()))
        .map(|item| (item.key.trim().to_string(), item.value.clone()))
        .collect::<Vec<_>>();
    run_program_streaming(app, execution_id, path, args, &command_env)
}

fn run_program_streaming(
    app: &AppHandle,
    execution_id: &str,
    path: &PathBuf,
    args: &[&str],
    env_vars: &[(String, String)],
) -> Result<WecodeCommandResult, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_command_env(&mut command);

    for (key, value) in env_vars {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to run wecode: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture wecode stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture wecode stderr".to_string())?;
    let stdout_buffer = Arc::new(Mutex::new(Vec::new()));
    let stderr_buffer = Arc::new(Mutex::new(Vec::new()));

    let stdout_thread = stream_command_output(
        app.clone(),
        execution_id.to_string(),
        "stdout",
        stdout,
        Arc::clone(&stdout_buffer),
    );
    let stderr_thread = stream_command_output(
        app.clone(),
        execution_id.to_string(),
        "stderr",
        stderr,
        Arc::clone(&stderr_buffer),
    );
    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait for wecode: {error}"))?;

    stdout_thread
        .join()
        .map_err(|_| "Failed to join stdout reader".to_string())??;
    stderr_thread
        .join()
        .map_err(|_| "Failed to join stderr reader".to_string())??;

    Ok(WecodeCommandResult {
        success: status.success(),
        code: status.code(),
        stdout: captured_output(&stdout_buffer)?,
        stderr: captured_output(&stderr_buffer)?,
    })
}

fn emit_command_output(
    app: &AppHandle,
    execution_id: &str,
    stream: &str,
    content: impl Into<String>,
) -> Result<(), String> {
    app.emit(
        "executor-command-output",
        ExecutorCommandOutput {
            execution_id: execution_id.to_string(),
            stream: stream.to_string(),
            content: content.into(),
        },
    )
    .map_err(|error| format!("Failed to emit command {stream}: {error}"))
}

fn stream_command_output<R: Read + Send + 'static>(
    app: AppHandle,
    execution_id: String,
    stream: &'static str,
    mut reader: R,
    captured: Arc<Mutex<Vec<u8>>>,
) -> std::thread::JoinHandle<Result<(), String>> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(&mut reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let bytes_read = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| format!("Failed to read command {stream}: {error}"))?;
            if bytes_read == 0 {
                break;
            }

            captured
                .lock()
                .map_err(|_| format!("Failed to lock command {stream} buffer"))?
                .write_all(&buffer)
                .map_err(|error| format!("Failed to capture command {stream}: {error}"))?;
            let content = String::from_utf8_lossy(&buffer).to_string();
            app.emit(
                "executor-command-output",
                ExecutorCommandOutput {
                    execution_id: execution_id.clone(),
                    stream: stream.to_string(),
                    content,
                },
            )
            .map_err(|error| format!("Failed to emit command {stream}: {error}"))?;
        }
        Ok(())
    })
}

fn captured_output(buffer: &Arc<Mutex<Vec<u8>>>) -> Result<String, String> {
    let bytes = buffer
        .lock()
        .map_err(|_| "Failed to lock command output buffer".to_string())?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}

fn run_command(path: &PathBuf, args: &[&str]) -> Result<WecodeCommandResult, String> {
    let mut command = Command::new(path);
    command.args(args);
    apply_command_env(&mut command);

    let output = command
        .output()
        .map_err(|error| format!("Failed to run command: {error}"))?;

    Ok(command_output_to_result(output))
}

fn run_system_command(program: &str, args: &[&str]) -> Result<WecodeCommandResult, String> {
    run_command(&PathBuf::from(program), args)
}

fn resolve_wecode_cli() -> WecodeCliStatus {
    let mut last_error: Option<String> = None;

    for path in candidate_wecode_paths() {
        match run_wecode_args(&path, &["version"]) {
            Ok(result) if result.success => {
                return WecodeCliStatus {
                    available: true,
                    path: Some(path.to_string_lossy().to_string()),
                    version: Some(first_non_empty_line(&result.stdout).unwrap_or(result.stdout)),
                    error: None,
                };
            }
            Ok(result) => {
                last_error = Some(
                    first_non_empty_line(&result.stderr)
                        .or_else(|| first_non_empty_line(&result.stdout))
                        .unwrap_or_else(|| {
                            "wecode version returned a non-zero exit code".to_string()
                        }),
                );
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    WecodeCliStatus {
        available: false,
        path: None,
        version: None,
        error: last_error,
    }
}

fn resolve_node() -> NodeStatus {
    let mut last_error: Option<String> = None;

    for path in candidate_node_paths() {
        match run_command(&path, &["--version"]) {
            Ok(result) if result.success => {
                let version = first_non_empty_line(&result.stdout).unwrap_or(result.stdout);
                let major_version = parse_node_major_version(&version);
                return NodeStatus {
                    available: true,
                    path: Some(path.to_string_lossy().to_string()),
                    version: Some(version),
                    major_version,
                    meets_minimum: major_version.is_some_and(|major| major >= 20),
                    error: None,
                };
            }
            Ok(result) => {
                last_error = Some(
                    first_non_empty_line(&result.stderr)
                        .or_else(|| first_non_empty_line(&result.stdout))
                        .unwrap_or_else(|| {
                            "node --version returned a non-zero exit code".to_string()
                        }),
                );
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    NodeStatus {
        available: false,
        path: None,
        version: None,
        major_version: None,
        meets_minimum: false,
        error: last_error,
    }
}

fn parse_node_major_version(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok())
}

fn first_non_empty_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_executor_status(
    node: NodeStatus,
    cli: WecodeCliStatus,
    result: WecodeCommandResult,
) -> ExecutorStatus {
    let output = [result.stdout.as_str(), result.stderr.as_str()]
        .iter()
        .filter(|part| !part.trim().is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    let normalized = output.to_lowercase();
    let status_line = output
        .lines()
        .map(str::trim)
        .find(|line| line.to_lowercase().starts_with("status:"))
        .unwrap_or("");
    let normalized_status = status_line.to_lowercase();

    let running = !normalized_status.contains("stopped")
        && !normalized_status.contains("not running")
        && (normalized_status.contains("running")
            || normalized_status.contains("🟢")
            || normalized_status.contains("online"));

    ExecutorStatus {
        node,
        cli,
        installed: normalized.contains("installed:")
            && (normalized.contains("installed:     yes") || normalized.contains("installed: yes")),
        running,
        pid: parse_labeled_u32(&output, "PID:"),
        version: parse_labeled_value(&output, "Version:")
            .or_else(|| parse_labeled_value(&output, "Executor Version:")),
        error: if result.success {
            None
        } else {
            Some(
                first_non_empty_line(&output)
                    .unwrap_or_else(|| "wecode executor status failed".to_string()),
            )
        },
        output,
    }
}

fn parse_labeled_u32(output: &str, label: &str) -> Option<u32> {
    parse_labeled_value(output, label).and_then(|value| value.parse::<u32>().ok())
}

fn parse_labeled_value(output: &str, label: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix(label)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn resolve_executor_process_diagnostics() -> ExecutorProcessDiagnostics {
    resolve_executor_process_diagnostics_for_port(EXECUTOR_GATEWAY_PORT)
}

fn resolve_executor_process_diagnostics_for_port(port: u16) -> ExecutorProcessDiagnostics {
    let mut errors = Vec::new();
    let processes = match list_executor_processes() {
        Ok(processes) => processes,
        Err(error) => {
            errors.push(error);
            Vec::new()
        }
    };
    let port_occupants = match list_executor_port_occupants(port, &processes) {
        Ok(occupants) => occupants,
        Err(error) => {
            errors.push(error);
            Vec::new()
        }
    };

    ExecutorProcessDiagnostics {
        processes,
        port_occupants,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("\n"))
        },
    }
}

#[cfg(not(target_os = "windows"))]
fn list_executor_processes() -> Result<Vec<LocalProcessInfo>, String> {
    let result = run_system_command("ps", &["-axo", "pid=,ppid=,command="])?;
    if !result.success {
        return Err(get_command_output(&result).unwrap_or_else(|| "ps failed".to_string()));
    }

    Ok(result
        .stdout
        .lines()
        .filter_map(parse_unix_process_line)
        .filter(|process| process.is_executor_like)
        .collect())
}

#[cfg(not(target_os = "windows"))]
fn parse_unix_process_line(line: &str) -> Option<LocalProcessInfo> {
    let mut parts = line.trim().splitn(3, char::is_whitespace);
    let pid = parts.next()?.parse::<u32>().ok()?;
    let parent_pid = parts
        .next()
        .and_then(|value| value.trim().parse::<u32>().ok());
    let command = parts.next()?.trim().to_string();
    let is_executor_like = is_executor_like_command(&command);
    Some(LocalProcessInfo {
        pid,
        parent_pid,
        command,
        is_executor_like,
    })
}

#[cfg(target_os = "windows")]
fn list_executor_processes() -> Result<Vec<LocalProcessInfo>, String> {
    let script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*wegent-executor*' -or $_.Name -like '*wegent-executor*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }";
    let result = run_system_command(
        "powershell",
        &[
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )?;
    if !result.success {
        return Err(
            get_command_output(&result).unwrap_or_else(|| "powershell ps failed".to_string())
        );
    }

    Ok(result
        .stdout
        .lines()
        .filter_map(parse_windows_process_line)
        .filter(|process| process.is_executor_like)
        .collect())
}

#[cfg(target_os = "windows")]
fn parse_windows_process_line(line: &str) -> Option<LocalProcessInfo> {
    let mut parts = line.splitn(3, '\t');
    let pid = parts.next()?.trim().parse::<u32>().ok()?;
    let parent_pid = parts
        .next()
        .and_then(|value| value.trim().parse::<u32>().ok());
    let command = parts.next().unwrap_or("").trim().to_string();
    let is_executor_like = is_executor_like_command(&command);
    Some(LocalProcessInfo {
        pid,
        parent_pid,
        command,
        is_executor_like,
    })
}

#[cfg(not(target_os = "windows"))]
fn list_executor_port_occupants(
    port: u16,
    processes: &[LocalProcessInfo],
) -> Result<Vec<PortOccupantInfo>, String> {
    let selector = format!("-iTCP:{port}");
    let result = run_system_command("lsof", &["-nP", &selector, "-sTCP:LISTEN", "-F", "pc"])?;
    if !result.success {
        return Ok(Vec::new());
    }

    Ok(parse_lsof_port_occupants(port, &result.stdout, processes))
}

#[cfg(not(target_os = "windows"))]
fn parse_lsof_port_occupants(
    port: u16,
    output: &str,
    processes: &[LocalProcessInfo],
) -> Vec<PortOccupantInfo> {
    let mut occupants = Vec::new();
    let mut pid: Option<u32> = None;
    let mut command = String::new();

    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            if let Some(current_pid) = pid.take() {
                occupants.push(port_occupant_from_process(
                    port,
                    current_pid,
                    &command,
                    processes,
                ));
                command.clear();
            }
            pid = value.parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix('c') {
            command = value.to_string();
        }
    }

    if let Some(current_pid) = pid {
        occupants.push(port_occupant_from_process(
            port,
            current_pid,
            &command,
            processes,
        ));
    }

    occupants
}

#[cfg(target_os = "windows")]
fn list_executor_port_occupants(
    port: u16,
    processes: &[LocalProcessInfo],
) -> Result<Vec<PortOccupantInfo>, String> {
    let script = format!(
        "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\"; \"$($_.OwningProcess)`t$($p.CommandLine)\" }}"
    );
    let result = run_system_command(
        "powershell",
        &[
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ],
    )?;
    if !result.success {
        return Ok(Vec::new());
    }

    Ok(result
        .stdout
        .lines()
        .filter_map(|line| parse_windows_port_line(port, line, processes))
        .collect())
}

#[cfg(target_os = "windows")]
fn parse_windows_port_line(
    port: u16,
    line: &str,
    processes: &[LocalProcessInfo],
) -> Option<PortOccupantInfo> {
    let mut parts = line.splitn(2, '\t');
    let pid = parts.next()?.trim().parse::<u32>().ok()?;
    let command = parts.next().unwrap_or("").trim();
    Some(port_occupant_from_process(port, pid, command, processes))
}

fn port_occupant_from_process(
    port: u16,
    pid: u32,
    command: &str,
    processes: &[LocalProcessInfo],
) -> PortOccupantInfo {
    let process = processes.iter().find(|item| item.pid == pid);
    let resolved_command = process
        .map(|item| item.command.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| command.to_string());
    let is_executor_like =
        process.is_some_and(|item| item.is_executor_like) || is_executor_like_command(command);

    PortOccupantInfo {
        port,
        pid,
        command: resolved_command,
        is_executor_like,
    }
}

fn executor_port_conflict_detail(
    expected_port: u16,
    current_pid: Option<u32>,
    diagnostics: &ExecutorProcessDiagnostics,
) -> Option<String> {
    diagnostics
        .port_occupants
        .iter()
        .filter(|occupant| occupant.port == expected_port && occupant.is_executor_like)
        .find(|occupant| {
            current_pid
                .map(|pid| !process_belongs_to_pid(occupant.pid, pid, &diagnostics.processes))
                .unwrap_or(true)
        })
        .map(|occupant| {
            format!(
                "Executor 端口 {} 被其他 Wegent Executor 进程占用：PID {}, {}",
                occupant.port, occupant.pid, occupant.command
            )
        })
}

fn process_belongs_to_pid(pid: u32, root_pid: u32, processes: &[LocalProcessInfo]) -> bool {
    if pid == root_pid {
        return true;
    }

    let mut current_pid = pid;
    for _ in 0..32 {
        let Some(process) = processes.iter().find(|item| item.pid == current_pid) else {
            return false;
        };
        let Some(parent_pid) = process.parent_pid else {
            return false;
        };
        if parent_pid == root_pid {
            return true;
        }
        if parent_pid == current_pid {
            return false;
        }
        current_pid = parent_pid;
    }

    false
}

fn is_executor_like_command(command: &str) -> bool {
    let Some(program) = command.split_whitespace().next() else {
        return false;
    };
    let normalized = program.trim_matches('"').trim_matches('\'');
    PathBuf::from(normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_lowercase().starts_with("wegent-executor"))
}

fn kill_executor_processes_by_pid(pids: Vec<u32>) -> Result<WecodeCommandResult, String> {
    let diagnostics = resolve_executor_process_diagnostics();
    let allowed_pids = diagnostics
        .processes
        .iter()
        .filter(|process| process.is_executor_like && pids.contains(&process.pid))
        .map(|process| process.pid)
        .collect::<Vec<_>>();

    if allowed_pids.is_empty() {
        return Ok(WecodeCommandResult {
            success: true,
            code: Some(0),
            stdout: "没有可清理的 Wegent Executor 进程".to_string(),
            stderr: String::new(),
        });
    }

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut success = true;

    for pid in allowed_pids {
        match kill_process(pid) {
            Ok(result) if result.success => {
                stdout.push(format!("已清理 Wegent Executor 进程 PID {pid}"));
            }
            Ok(result) => {
                success = false;
                stderr.push(format!(
                    "PID {pid}: {}",
                    get_command_output(&result).unwrap_or_else(|| "清理失败".to_string())
                ));
            }
            Err(error) => {
                success = false;
                stderr.push(format!("PID {pid}: {error}"));
            }
        }
    }

    Ok(WecodeCommandResult {
        success,
        code: if success { Some(0) } else { Some(1) },
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
    })
}

#[cfg(not(target_os = "windows"))]
fn kill_process(pid: u32) -> Result<WecodeCommandResult, String> {
    run_system_command("kill", &["-TERM", &pid.to_string()])
}

#[cfg(target_os = "windows")]
fn kill_process(pid: u32) -> Result<WecodeCommandResult, String> {
    run_system_command("taskkill", &["/PID", &pid.to_string(), "/T", "/F"])
}

fn env_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(dir.join("local-executor-env.json"))
}

fn runtime_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(dir.join("local-executor-runtime.json"))
}

fn executor_logs_dir() -> Result<PathBuf, String> {
    home_dir()
        .map(|home| home.join(".wecode").join("wecode-cli").join("logs"))
        .ok_or_else(|| "Failed to resolve the user home directory".to_string())
}

fn load_runtime_gateway_port(app: &AppHandle) -> u16 {
    let Ok(path) = runtime_config_path(app) else {
        return EXECUTOR_GATEWAY_PORT;
    };
    let Ok(content) = fs::read_to_string(path) else {
        return EXECUTOR_GATEWAY_PORT;
    };
    serde_json::from_str::<LocalExecutorRuntimeConfig>(&content)
        .map(|config| config.gateway_port)
        .unwrap_or(EXECUTOR_GATEWAY_PORT)
}

fn save_runtime_gateway_port(app: &AppHandle, gateway_port: u16) -> Result<(), String> {
    let path = runtime_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(&LocalExecutorRuntimeConfig { gateway_port })
        .map_err(|error| format!("Failed to serialize executor runtime config: {error}"))?;
    fs::write(path, content)
        .map_err(|error| format!("Failed to save executor runtime config: {error}"))
}

fn open_path(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");

    let status = command
        .arg(path)
        .status()
        .map_err(|error| format!("Failed to open logs directory: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to open logs directory: command exited with {status}"
        ))
    }
}

fn load_startup_env(app: &AppHandle) -> Result<Vec<StartupEnvVar>, String> {
    let path = env_config_path(app)?;
    if !path.exists() {
        return Ok(default_startup_env());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read startup env config: {error}"))?;
    serde_json::from_str::<Vec<StartupEnvVar>>(&content)
        .map_err(|error| format!("Failed to parse startup env config: {error}"))
}

fn save_startup_env_file(app: &AppHandle, env_vars: Vec<StartupEnvVar>) -> Result<(), String> {
    let path = env_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    }

    let sanitized = env_vars
        .into_iter()
        .filter(|item| is_valid_env_key(item.key.trim()))
        .map(|item| StartupEnvVar {
            key: item.key.trim().to_string(),
            value: item.value,
            enabled: item.enabled,
            sensitive: item.sensitive,
        })
        .collect::<Vec<_>>();
    let content = serde_json::to_string_pretty(&sanitized)
        .map_err(|error| format!("Failed to serialize startup env config: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Failed to save startup env config: {error}"))
}

fn prepare_executor_startup_env(
    app: &AppHandle,
    execution_id: &str,
) -> Result<Vec<StartupEnvVar>, String> {
    let mut env_vars = load_startup_env(app)?;
    let requested_port = enabled_env_value(&env_vars, "DEVICE_SESSION_GATEWAY_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(EXECUTOR_GATEWAY_PORT);

    let selected_port = if is_port_available(requested_port) {
        requested_port
    } else {
        let fallback_port = find_available_gateway_port(requested_port).ok_or_else(|| {
            format!(
                "未找到可用的 Executor Gateway 端口，已尝试 {}-{}",
                EXECUTOR_GATEWAY_PORT_RANGE_START, EXECUTOR_GATEWAY_PORT_RANGE_END
            )
        })?;
        emit_command_output(
            app,
            execution_id,
            "stdout",
            format!("默认 Gateway 端口 {requested_port} 被占用，改用端口 {fallback_port}\n"),
        )?;
        fallback_port
    };

    upsert_startup_env(
        &mut env_vars,
        "DEVICE_SESSION_GATEWAY_PORT",
        &selected_port.to_string(),
    );
    upsert_startup_env(
        &mut env_vars,
        "DEVICE_PUBLIC_BASE_URL",
        &format!("http://localhost:{selected_port}"),
    );
    save_runtime_gateway_port(app, selected_port)?;
    Ok(env_vars)
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("0.0.0.0", port)).is_ok()
}

fn find_available_gateway_port(occupied_port: u16) -> Option<u16> {
    let candidates = gateway_port_candidates(occupied_port);
    candidates.into_iter().find(|port| is_port_available(*port))
}

fn gateway_port_candidates(occupied_port: u16) -> Vec<u16> {
    let mut ports = Vec::new();
    let count = EXECUTOR_GATEWAY_PORT_RANGE_END - EXECUTOR_GATEWAY_PORT_RANGE_START + 1;
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u16)
        .unwrap_or(0);
    let start_offset = seed % count;

    for offset in 0..count {
        let port = EXECUTOR_GATEWAY_PORT_RANGE_START + ((start_offset + offset) % count);
        if port != occupied_port {
            ports.push(port);
        }
    }
    ports
}

fn upsert_startup_env(env_vars: &mut Vec<StartupEnvVar>, key: &str, value: &str) {
    if let Some(env_var) = env_vars.iter_mut().find(|item| item.key.trim() == key) {
        env_var.value = value.to_string();
        env_var.enabled = true;
        env_var.sensitive = false;
        return;
    }

    env_vars.push(StartupEnvVar {
        key: key.to_string(),
        value: value.to_string(),
        enabled: true,
        sensitive: false,
    });
}

fn default_startup_env() -> Vec<StartupEnvVar> {
    vec![
        StartupEnvVar {
            key: "WECODE_CLI_PORT".to_string(),
            value: "3456".to_string(),
            enabled: true,
            sensitive: false,
        },
        StartupEnvVar {
            key: "WECODE_NO_AUTO_UPGRADE".to_string(),
            value: "1".to_string(),
            enabled: false,
            sensitive: false,
        },
        StartupEnvVar {
            key: "CLAUDE_CODE_NPM_REGISTRY".to_string(),
            value: "https://registry.npmmirror.com".to_string(),
            enabled: false,
            sensitive: false,
        },
    ]
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|char| char == '_' || char.is_ascii_alphanumeric())
}

fn run_executor_action(
    app: &AppHandle,
    action: &str,
    execution_id: &str,
) -> Result<WecodeCommandResult, String> {
    if action == "install-cli" {
        return install_wecode_cli(app, execution_id);
    }

    let cli = resolve_wecode_cli();
    let path = cli.path.map(PathBuf::from).ok_or_else(|| {
        cli.error
            .unwrap_or_else(|| "WeCode CLI is not installed".to_string())
    })?;

    if action == "restart" {
        let stop_result = run_wecode_args_with_env_streaming(
            app,
            execution_id,
            &path,
            &["executor", "stop"],
            &[],
        )?;
        if !stop_result.success {
            return Ok(stop_result);
        }

        let env_vars = prepare_executor_startup_env(app, execution_id)?;
        let gateway_port = executor_gateway_port_from_env(&env_vars);
        let start_result = verify_executor_start_result(
            app,
            execution_id,
            &path,
            run_wecode_args_with_env_streaming(
                app,
                execution_id,
                &path,
                &["executor", "start"],
                &env_vars,
            )?,
            &env_vars,
            gateway_port,
        )?;
        return Ok(merge_command_results(stop_result, start_result));
    }

    let args: Vec<&str> = match action {
        "install" => vec!["executor", "install"],
        "start" => vec!["executor", "start"],
        "stop" => vec!["executor", "stop"],
        "upgrade" => vec!["executor", "upgrade"],
        "install-browser" => vec!["executor", "install", "browser"],
        "install-mail" => vec!["executor", "install", "mail"],
        _ => return Err("Unsupported executor action".to_string()),
    };

    let env_vars = if action == "start" || action == "upgrade" {
        prepare_executor_startup_env(app, execution_id)?
    } else {
        Vec::new()
    };
    let gateway_port = executor_gateway_port_from_env(&env_vars);

    let result = run_wecode_args_with_env_streaming(app, execution_id, &path, &args, &env_vars)?;
    Ok(if action == "start" || action == "upgrade" {
        verify_executor_start_result(app, execution_id, &path, result, &env_vars, gateway_port)?
    } else {
        result
    })
}

fn wecode_cli_download_token() -> Option<String> {
    env::var("WECODE_CLI_DOWNLOAD_TOKEN")
        .ok()
        .or_else(|| env::var("EXECUTOR_DOWNLOAD_TOKEN").ok())
        .or_else(|| option_env!("WECODE_CLI_DOWNLOAD_TOKEN").map(ToOwned::to_owned))
        .or_else(|| option_env!("EXECUTOR_DOWNLOAD_TOKEN").map(ToOwned::to_owned))
        .filter(|token| !token.trim().is_empty())
}

fn install_wecode_cli(app: &AppHandle, execution_id: &str) -> Result<WecodeCommandResult, String> {
    let token = wecode_cli_download_token().ok_or_else(|| {
        "WeCode CLI 安装凭据未配置，请在打包环境设置 WECODE_CLI_DOWNLOAD_TOKEN".to_string()
    })?;
    emit_command_output(app, execution_id, "stdout", "正在下载安装脚本...\n")?;

    #[cfg(target_os = "windows")]
    let result = {
        let script_path = env::temp_dir().join(format!("install-wecode-{execution_id}.ps1"));
        let command = PathBuf::from("pwsh");
        let args = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$headers = @{\"PRIVATE-TOKEN\"=$env:WECODE_CLI_DOWNLOAD_TOKEN; \"Cache-Control\"=\"no-cache\"}; Invoke-WebRequest -UseBasicParsing -Uri $env:WECODE_CLI_INSTALL_SCRIPT_URL -Headers $headers -OutFile $env:WECODE_CLI_INSTALL_SCRIPT; & $env:WECODE_CLI_INSTALL_SCRIPT",
        ];
        let command_env = vec![
            ("WECODE_CLI_DOWNLOAD_TOKEN".to_string(), token),
            (
                "WECODE_CLI_INSTALL_SCRIPT_URL".to_string(),
                WECODE_CLI_INSTALL_SCRIPT_WINDOWS.to_string(),
            ),
            (
                "WECODE_CLI_INSTALL_SCRIPT".to_string(),
                script_path.to_string_lossy().to_string(),
            ),
        ];
        let result = run_program_streaming(app, execution_id, &command, &args, &command_env)?;
        let _ = fs::remove_file(script_path);
        result
    };

    #[cfg(not(target_os = "windows"))]
    let result = {
        let script_path = env::temp_dir().join(format!("install-wecode-{execution_id}.sh"));
        let command = PathBuf::from("/bin/sh");
        let args = [
            "-c",
            "curl -fsSL -H \"PRIVATE-TOKEN: ${WECODE_CLI_DOWNLOAD_TOKEN}\" \"${WECODE_CLI_INSTALL_SCRIPT_URL}\" -o \"${WECODE_CLI_INSTALL_SCRIPT}\" && /bin/bash \"${WECODE_CLI_INSTALL_SCRIPT}\"",
        ];
        let command_env = vec![
            ("WECODE_CLI_DOWNLOAD_TOKEN".to_string(), token),
            (
                "WECODE_CLI_INSTALL_SCRIPT_URL".to_string(),
                WECODE_CLI_INSTALL_SCRIPT_UNIX.to_string(),
            ),
            (
                "WECODE_CLI_INSTALL_SCRIPT".to_string(),
                script_path.to_string_lossy().to_string(),
            ),
        ];
        let result = run_program_streaming(app, execution_id, &command, &args, &command_env)?;
        let _ = fs::remove_file(script_path);
        result
    };

    if result.success {
        emit_command_output(
            app,
            execution_id,
            "stdout",
            "WeCode CLI 安装完成，正在重新检测...\n",
        )?;
    }
    Ok(result)
}

fn normalize_executor_start_result(
    mut result: WecodeCommandResult,
    env_vars: &[StartupEnvVar],
) -> WecodeCommandResult {
    let Some(backend_url) = enabled_env_value(env_vars, "WEGENT_BACKEND_URL") else {
        return result;
    };

    result.stdout = replace_labeled_output(&result.stdout, "Backend URL:", backend_url);
    result
}

fn verify_executor_start_result(
    app: &AppHandle,
    execution_id: &str,
    path: &PathBuf,
    result: WecodeCommandResult,
    env_vars: &[StartupEnvVar],
    gateway_port: u16,
) -> Result<WecodeCommandResult, String> {
    let mut result = normalize_executor_start_result(result, env_vars);
    if !result.success || !looks_like_executor_start(&result) {
        return Ok(result);
    }

    emit_command_output(
        app,
        execution_id,
        "stdout",
        "正在确认 Executor 运行状态...\n",
    )?;
    let mut failure_detail: Option<String> = None;
    for _ in 0..5 {
        thread::sleep(Duration::from_millis(350));
        if let Ok(status_error) = verified_executor_status_is_running_on_port(path, gateway_port) {
            if status_error.is_none() {
                return Ok(result);
            }
            failure_detail = status_error;
        }
    }

    result.success = false;
    result.code = Some(1);
    let detail = failure_detail
        .or_else(|| executor_start_failure_detail(&result.stdout))
        .unwrap_or_else(|| "Executor 启动后未保持运行，请查看启动日志。".to_string());
    result.stderr = join_non_empty(&[result.stderr.as_str(), detail.as_str()]);
    emit_command_output(app, execution_id, "stderr", format!("{detail}\n"))?;
    Ok(result)
}

fn looks_like_executor_start(result: &WecodeCommandResult) -> bool {
    let output = join_non_empty(&[result.stdout.as_str(), result.stderr.as_str()]).to_lowercase();
    output.contains("wegent-executor started successfully")
        || output.contains("executor started successfully")
        || output.contains("starting wegent-executor")
}

fn executor_status_is_running(result: &WecodeCommandResult) -> bool {
    if !result.success {
        return false;
    }

    let output = join_non_empty(&[result.stdout.as_str(), result.stderr.as_str()]);
    let status_line = output
        .lines()
        .map(str::trim)
        .find(|line| line.to_lowercase().starts_with("status:"))
        .unwrap_or("");
    let normalized = status_line.to_lowercase();
    !normalized.contains("stopped")
        && !normalized.contains("not running")
        && (normalized.contains("running")
            || normalized.contains("online")
            || normalized.contains("🟢"))
}

fn verified_executor_status_is_running_on_port(
    path: &PathBuf,
    gateway_port: u16,
) -> Result<Option<String>, String> {
    let status_result = run_wecode_args(path, &["executor", "status"])?;
    if !executor_status_is_running(&status_result) {
        return Ok(Some(
            get_command_output(&status_result)
                .unwrap_or_else(|| "Executor 启动后未保持运行。".to_string()),
        ));
    }

    let output = join_non_empty(&[status_result.stdout.as_str(), status_result.stderr.as_str()]);
    let current_pid = parse_labeled_u32(&output, "PID:");
    let diagnostics = resolve_executor_process_diagnostics_for_port(gateway_port);
    Ok(executor_port_conflict_detail(
        gateway_port,
        current_pid,
        &diagnostics,
    ))
}

fn executor_start_failure_detail(start_output: &str) -> Option<String> {
    let log_path = parse_labeled_value(start_output, "Log File:")
        .map(PathBuf::from)
        .or_else(latest_executor_startup_log)?;
    let tail = read_log_tail(&log_path, 60).ok()?;
    let detail = first_relevant_log_error(&tail)
        .or_else(|| first_non_empty_line(&tail))
        .unwrap_or_else(|| "Executor 启动后未保持运行。".to_string());
    Some(format!(
        "Executor 启动后退出：{detail}\nLog File: {}",
        log_path.to_string_lossy()
    ))
}

fn latest_executor_startup_log() -> Option<PathBuf> {
    let logs_dir = executor_logs_dir().ok()?;
    let entries = fs::read_dir(logs_dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("executor-startup-") && name.ends_with(".log"))
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn read_log_tail(path: &PathBuf, max_lines: usize) -> Result<String, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read executor startup log: {error}"))?;
    let mut lines = content.lines().rev().take(max_lines).collect::<Vec<_>>();
    lines.reverse();
    Ok(lines.join("\n"))
}

fn first_relevant_log_error(output: &str) -> Option<String> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| {
            let normalized = line.to_lowercase();
            normalized.contains("error")
                || normalized.contains("address already in use")
                || normalized.contains("errno")
                || normalized.contains("traceback")
        })
        .map(ToOwned::to_owned)
}

fn join_non_empty(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn get_command_output(result: &WecodeCommandResult) -> Option<String> {
    let output = join_non_empty(&[result.stdout.as_str(), result.stderr.as_str()]);
    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

fn enabled_env_value<'a>(env_vars: &'a [StartupEnvVar], key: &str) -> Option<&'a str> {
    env_vars
        .iter()
        .find(|item| item.enabled && item.key.trim() == key)
        .map(|item| item.value.trim())
        .filter(|value| !value.is_empty())
}

fn executor_gateway_port_from_env(env_vars: &[StartupEnvVar]) -> u16 {
    enabled_env_value(env_vars, "DEVICE_SESSION_GATEWAY_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(EXECUTOR_GATEWAY_PORT)
}

fn replace_labeled_output(output: &str, label: &str, value: &str) -> String {
    let mut replaced = false;
    let mut lines = output
        .lines()
        .map(|line| {
            if !replaced && line.trim_start().starts_with(label) {
                replaced = true;
                let indentation = &line[..line.len() - line.trim_start().len()];
                format!("{indentation}{label} {value}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();

    if !replaced {
        lines.push(format!("{label} {value}"));
    }

    lines.join("\n")
}

fn merge_command_results(
    stop_result: WecodeCommandResult,
    start_result: WecodeCommandResult,
) -> WecodeCommandResult {
    WecodeCommandResult {
        success: start_result.success,
        code: start_result.code,
        stdout: join_command_output("stop", &stop_result.stdout, "start", &start_result.stdout),
        stderr: join_command_output("stop", &stop_result.stderr, "start", &start_result.stderr),
    }
}

fn join_command_output(
    first_label: &str,
    first_output: &str,
    second_label: &str,
    second_output: &str,
) -> String {
    [(first_label, first_output), (second_label, second_output)]
        .into_iter()
        .filter(|(_, output)| !output.trim().is_empty())
        .map(|(label, output)| format!("[{label}]\n{}", output.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn detect_wecode_cli() -> WecodeCliStatus {
    resolve_wecode_cli()
}

#[tauri::command]
pub fn get_executor_status(app: AppHandle) -> ExecutorStatus {
    let node = resolve_node();
    let cli = resolve_wecode_cli();
    let gateway_port = load_runtime_gateway_port(&app);
    let Some(path) = cli.path.clone().map(PathBuf::from) else {
        return ExecutorStatus {
            node,
            cli,
            installed: false,
            running: false,
            pid: None,
            version: None,
            output: String::new(),
            error: Some("WeCode CLI is not installed".to_string()),
        };
    };

    match run_wecode_args(&path, &["executor", "status"]) {
        Ok(result) => {
            verify_executor_status_health(parse_executor_status(node, cli, result), gateway_port)
        }
        Err(error) => ExecutorStatus {
            node,
            cli,
            installed: false,
            running: false,
            pid: None,
            version: None,
            output: String::new(),
            error: Some(error),
        },
    }
}

fn verify_executor_status_health(mut status: ExecutorStatus, gateway_port: u16) -> ExecutorStatus {
    let diagnostics = resolve_executor_process_diagnostics_for_port(gateway_port);
    if let Some(detail) = executor_port_conflict_detail(gateway_port, status.pid, &diagnostics) {
        status.running = false;
        status.error = Some(detail);
    }
    status
}

#[tauri::command]
pub fn get_startup_env(app: AppHandle) -> Result<Vec<StartupEnvVar>, String> {
    load_startup_env(&app)
}

#[tauri::command]
pub fn save_startup_env(
    app: AppHandle,
    env_vars: Vec<StartupEnvVar>,
) -> Result<Vec<StartupEnvVar>, String> {
    save_startup_env_file(&app, env_vars)?;
    load_startup_env(&app)
}

#[tauri::command]
pub async fn run_executor_command(
    app: AppHandle,
    action: String,
    execution_id: String,
) -> Result<WecodeCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_executor_action(&app, &action, &execution_id))
        .await
        .map_err(|error| format!("Executor command task failed: {error}"))?
}

#[tauri::command]
pub async fn open_executor_logs_directory() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = executor_logs_dir()?;
        fs::create_dir_all(&path)
            .map_err(|error| format!("Failed to create logs directory: {error}"))?;
        open_path(&path)
    })
    .await
    .map_err(|error| format!("Open logs task failed: {error}"))?
}

#[tauri::command]
pub async fn get_executor_process_diagnostics(
    app: AppHandle,
) -> Result<ExecutorProcessDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gateway_port = load_runtime_gateway_port(&app);
        resolve_executor_process_diagnostics_for_port(gateway_port)
    })
    .await
    .map_err(|error| format!("Process diagnostics task failed: {error}"))
}

#[tauri::command]
pub async fn kill_executor_processes(pids: Vec<u32>) -> Result<WecodeCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || kill_executor_processes_by_pid(pids))
        .await
        .map_err(|error| format!("Kill process task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::replace_labeled_output;

    #[test]
    fn replaces_hardcoded_backend_url_in_cli_output() {
        let output = "Started successfully\n   Backend URL: https://default.example.com/";

        assert_eq!(
            replace_labeled_output(output, "Backend URL:", "http://localhost:9100"),
            "Started successfully\n   Backend URL: http://localhost:9100"
        );
    }

    #[test]
    fn appends_backend_url_when_cli_output_omits_it() {
        assert_eq!(
            replace_labeled_output(
                "Started successfully",
                "Backend URL:",
                "http://localhost:9100"
            ),
            "Started successfully\nBackend URL: http://localhost:9100"
        );
    }
}
