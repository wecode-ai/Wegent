//! Execute commands from the selected local connector package.
use super::*;
use std::{env, process::Stdio};
use tokio::process::Command;

pub(super) async fn run_plugin_command(
    plugin_root: &Path,
    args: &[String],
    tool: Option<&Path>,
    timeout_seconds: u64,
) -> Result<Value, AppIpcError> {
    let mut invocation = diagnostics::Invocation::new(plugin_root);
    let result = async {
        let (requires_python, selected) = python::prepare_command(plugin_root, args, tool).await?;
        run_plugin_command_inner(
            plugin_root,
            args,
            tool,
            timeout_seconds,
            requires_python,
            selected.as_ref(),
            &invocation,
        )
        .await
    }
    .await;
    invocation.finish(result.as_ref().err().map(|error| error.code.as_str()));
    result
}

async fn run_plugin_command_inner(
    plugin_root: &Path,
    args: &[String],
    tool: Option<&Path>,
    timeout_seconds: u64,
    requires_python: bool,
    selected: Option<&crate::python_runtime::PluginPythonInterpreter>,
    invocation: &diagnostics::Invocation,
) -> Result<Value, AppIpcError> {
    if args.is_empty() {
        return Err(AppIpcError::new(
            "local_auth_invalid",
            "Command arguments are required",
        ));
    }
    let program = resolve_program(plugin_root, &args[0])?;
    let rest = &args[1..];
    let direct = crate::python_runtime::is_python_program(&args[0]);
    let mut command = if let Some(selected) = selected.filter(|_| direct) {
        let mut command = Command::new(&selected.path);
        selected
            .configure(&mut command)
            .map_err(|message| AppIpcError::new("python_runtime_unavailable", message))?;
        if program
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
        {
            command.arg(&program);
        }
        command.args(rest);
        command
    } else {
        plugin_command(&program, rest)?
    };
    command
        .current_dir(plugin_root)
        .envs(crate::plugin_account_auth::broker::environment())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if requires_python {
        let result = if let Some(selected) = selected.filter(|_| !direct) {
            selected.configure(&mut command)
        } else if selected.is_some() {
            Ok(())
        } else {
            crate::python_runtime::isolate_python_environment(&mut command)
        };
        result.map_err(|message| AppIpcError::new("python_runtime_unavailable", message))?;
    }
    if let Some(tool) = tool {
        command.env("WEGENT_LOCAL_AUTH_TOOL", tool);
    }
    let mut child = command
        .spawn()
        .map_err(|error| AppIpcError::new("local_auth_failed", error.to_string()))?;
    let mut stdout_pipe = child.stdout.take().expect("piped stdout");
    let stderr_pipe = child.stderr.take().expect("piped stderr");
    let collect = async {
        use tokio::io::AsyncReadExt;
        let stdout = async {
            let mut bytes = Vec::new();
            stdout_pipe.read_to_end(&mut bytes).await?;
            Ok(bytes)
        };
        let (stdout, stderr, status) = tokio::try_join!(
            stdout,
            diagnostics::read_stderr(stderr_pipe, |event| invocation.emit(event)),
            child.wait()
        )?;
        Ok::<_, std::io::Error>(std::process::Output {
            stdout,
            stderr,
            status,
        })
    };
    let output = tokio::time::timeout(Duration::from_secs(timeout_seconds), collect)
        .await
        .map_err(|_| AppIpcError::new("local_auth_timeout", "localAuth command timed out"))?
        .map_err(|error| AppIpcError::new("local_auth_failed", error.to_string()))?;

    invocation.emit(json!({"stage": "process_exit", "status": if output.status.success() { "ok" } else { "failed" }, "exit_code": output.status.code()}));
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stdout.is_empty() {
        return Err(AppIpcError::new(
            "local_auth_failed",
            if stderr.is_empty() {
                "localAuth command returned empty output".to_owned()
            } else {
                redact_secrets(&stderr)
            },
        ));
    }
    let parsed: Value = serde_json::from_str(&stdout).map_err(|error| {
        AppIpcError::new(
            "local_auth_invalid_json",
            format!(
                "localAuth command returned invalid JSON: {}; stderr={}",
                error,
                redact_secrets(&stderr)
            ),
        )
    })?;
    // Non-zero exit is allowed for need_login/health failures when JSON is present.
    let _ = output.status;
    Ok(parsed)
}

pub(super) fn plugin_command(program: &Path, rest: &[String]) -> Result<Command, AppIpcError> {
    let search_paths = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let system_root = env::var_os("SystemRoot")
        .or_else(|| env::var_os("WINDIR"))
        .map(PathBuf::from);
    plugin_command_for_platform(
        program,
        rest,
        cfg!(windows),
        &search_paths,
        system_root.as_deref(),
    )
}

pub(super) fn plugin_command_for_platform(
    program: &Path,
    rest: &[String],
    windows: bool,
    search_paths: &[PathBuf],
    system_root: Option<&Path>,
) -> Result<Command, AppIpcError> {
    if looks_like_shell_script(program) {
        let mut cmd = Command::new("sh");
        cmd.arg(program);
        for arg in rest {
            cmd.arg(arg);
        }
        Ok(cmd)
    } else if program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"))
    {
        let powershell_program = if windows {
            resolve_windows_powershell_program(search_paths, system_root)?
        } else {
            PathBuf::from("pwsh")
        };
        Ok(powershell_command(program, rest, &powershell_program))
    } else {
        let mut cmd = Command::new(program);
        for arg in rest {
            cmd.arg(arg);
        }
        Ok(cmd)
    }
}

pub(super) fn powershell_command(
    program: &Path,
    rest: &[String],
    powershell_program: &Path,
) -> Command {
    let mut cmd = Command::new(powershell_program);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    cmd.arg(program);
    for arg in rest {
        cmd.arg(arg);
    }
    cmd
}

pub(super) fn resolve_windows_powershell_program(
    search_paths: &[PathBuf],
    system_root: Option<&Path>,
) -> Result<PathBuf, AppIpcError> {
    if let Some(pwsh) = search_paths
        .iter()
        .map(|directory| directory.join("pwsh.exe"))
        .find_map(|candidate| {
            if candidate.is_file() {
                candidate.canonicalize().ok()
            } else {
                None
            }
        })
    {
        return Ok(pwsh);
    }

    let windows_powershell = system_root
        .unwrap_or_else(|| Path::new(r"C:\Windows"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if windows_powershell.is_file() {
        return Ok(windows_powershell);
    }

    Err(AppIpcError::new(
        "local_auth_powershell_missing",
        "PowerShell was not found. Install PowerShell 7 (pwsh.exe) or enable Windows PowerShell 5.1 (powershell.exe).",
    ))
}

fn resolve_program(plugin_root: &Path, arg: &str) -> Result<PathBuf, AppIpcError> {
    resolve_program_for_platform(plugin_root, arg, cfg!(windows))
}

pub(super) fn resolve_program_for_platform(
    plugin_root: &Path,
    arg: &str,
    windows: bool,
) -> Result<PathBuf, AppIpcError> {
    validate_relative_arg(arg)?;
    let candidate = plugin_root.join(arg);
    if windows
        && candidate
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("sh")
    {
        let powershell = candidate.with_extension("ps1");
        if powershell.is_file() {
            return Ok(powershell);
        }
    }
    if candidate.exists() {
        return Ok(candidate);
    }
    // Allow bare interpreter names such as python3 only when no path separators.
    if !arg.contains('/') && !arg.contains('\\') {
        return Ok(PathBuf::from(arg));
    }
    Err(AppIpcError::new(
        "local_auth_command_missing",
        format!("Command not found in plugin: {arg}"),
    ))
}

fn looks_like_shell_script(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("sh") | Some("bash")
    )
}
