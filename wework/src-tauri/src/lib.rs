use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(not(target_os = "windows"))]
const WECODE_CLI_INSTALL_SCRIPT_UNIX: &str = "https://git.intra.weibo.com/api/v4/projects/weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/repository/files/scripts%2Finstall.sh/raw?ref=master";
#[cfg(target_os = "windows")]
const WECODE_CLI_INSTALL_SCRIPT_WINDOWS: &str = "https://git.intra.weibo.com/api/v4/projects/weibo_rd%2Fcommon%2Fwecode%2Fwecode-cli-cc/repository/files/scripts%2Finstall.ps1/raw?ref=master";

#[derive(Serialize)]
struct WecodeCommandResult {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Serialize)]
struct ExecutorCommandOutput {
    execution_id: String,
    stream: String,
    content: String,
}

#[derive(Serialize)]
struct WecodeCliStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct NodeStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    major_version: Option<u32>,
    meets_minimum: bool,
    error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct StartupEnvVar {
    key: String,
    value: String,
    enabled: bool,
    sensitive: bool,
}

#[derive(Serialize)]
struct ExecutorStatus {
    node: NodeStatus,
    cli: WecodeCliStatus,
    installed: bool,
    running: bool,
    pid: Option<u32>,
    version: Option<String>,
    output: String,
    error: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
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
    let output = Command::new(path)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to run command: {error}"))?;

    Ok(command_output_to_result(output))
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

fn env_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(dir.join("local-executor-env.json"))
}

fn executor_logs_dir() -> Result<PathBuf, String> {
    home_dir()
        .map(|home| home.join(".wecode").join("wegent-executor").join("logs"))
        .ok_or_else(|| "Failed to resolve the user home directory".to_string())
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

        let env_vars = load_startup_env(app)?;
        let start_result = normalize_executor_start_result(
            run_wecode_args_with_env_streaming(
                app,
                execution_id,
                &path,
                &["executor", "start"],
                &env_vars,
            )?,
            &env_vars,
        );
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

    let env_vars = if action == "start" {
        load_startup_env(app)?
    } else {
        Vec::new()
    };

    let result = run_wecode_args_with_env_streaming(app, execution_id, &path, &args, &env_vars)?;
    Ok(if action == "start" {
        normalize_executor_start_result(result, &env_vars)
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

fn enabled_env_value<'a>(env_vars: &'a [StartupEnvVar], key: &str) -> Option<&'a str> {
    env_vars
        .iter()
        .find(|item| item.enabled && item.key.trim() == key)
        .map(|item| item.value.trim())
        .filter(|value| !value.is_empty())
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
fn detect_wecode_cli() -> WecodeCliStatus {
    resolve_wecode_cli()
}

#[tauri::command]
fn get_executor_status() -> ExecutorStatus {
    let node = resolve_node();
    let cli = resolve_wecode_cli();
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
        Ok(result) => parse_executor_status(node, cli, result),
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

#[tauri::command]
fn get_startup_env(app: AppHandle) -> Result<Vec<StartupEnvVar>, String> {
    load_startup_env(&app)
}

#[tauri::command]
fn save_startup_env(
    app: AppHandle,
    env_vars: Vec<StartupEnvVar>,
) -> Result<Vec<StartupEnvVar>, String> {
    save_startup_env_file(&app, env_vars)?;
    load_startup_env(&app)
}

#[tauri::command]
async fn run_executor_command(
    app: AppHandle,
    action: String,
    execution_id: String,
) -> Result<WecodeCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_executor_action(&app, &action, &execution_id))
        .await
        .map_err(|error| format!("Executor command task failed: {error}"))?
}

#[tauri::command]
async fn open_executor_logs_directory() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = executor_logs_dir()?;
        fs::create_dir_all(&path)
            .map_err(|error| format!("Failed to create logs directory: {error}"))?;
        open_path(&path)
    })
    .await
    .map_err(|error| format!("Open logs task failed: {error}"))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_wecode_cli,
            get_executor_status,
            get_startup_env,
            save_startup_env,
            run_executor_command,
            open_executor_logs_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
