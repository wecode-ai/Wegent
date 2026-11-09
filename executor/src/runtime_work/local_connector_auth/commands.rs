//! Execute plugin authentication commands with a consistent JSON transport.

use super::{diagnostics, python, redact_secrets, validate_relative_arg, AppIpcError};
use serde_json::{json, Value};
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
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
    // Apply the JSON transport encoding after managed Python environment isolation.
    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
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
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err(AppIpcError::new(
            "local_auth_failed",
            if stderr.is_empty() {
                "localAuth command returned empty output".to_owned()
            } else {
                redact_secrets(&stderr)
            },
        ));
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
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

fn plugin_command(program: &Path, rest: &[String]) -> Result<Command, AppIpcError> {
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

fn plugin_command_for_platform(
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

fn powershell_command(program: &Path, rest: &[String], powershell_program: &Path) -> Command {
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

fn resolve_windows_powershell_program(
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

fn resolve_program_for_platform(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn plugin_commands_preserve_unicode_json_and_reject_invalid_utf8() {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let (name, script) = (
            "auth.ps1",
            r#"param([string]$Action)
if ($Action -eq 'invalid') {
    $bytes = [byte[]](123,34,104,105,110,116,34,58,34,255,34,125)
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} else {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $hint = -join ([char[]](0x7B49,0x5F85,0x626B,0x7801,0x3002))
    @{status='waiting_scan';hint=$hint;encoding=$env:PYTHONIOENCODING;utf8=$env:PYTHONUTF8} | ConvertTo-Json -Compress
}
"#,
        );
        #[cfg(not(windows))]
        let (name, script) = (
            "auth.sh",
            r#"if [ "$1" = invalid ]; then
    printf '{"hint":"\377"}'
else
    printf '{"status":"waiting_scan","hint":"等待扫码。","encoding":"%s","utf8":"%s"}' "$PYTHONIOENCODING" "$PYTHONUTF8"
fi
"#,
        );
        fs::write(temp.path().join(name), script).unwrap();

        let result = run_plugin_command(temp.path(), &[name.into(), "valid".into()], None, 10)
            .await
            .unwrap();
        assert_eq!(result["status"], "waiting_scan");
        assert_eq!(result["hint"], "等待扫码。");
        assert_eq!(result["encoding"], "utf-8");
        assert_eq!(result["utf8"], "1");

        let error = run_plugin_command(temp.path(), &[name.into(), "invalid".into()], None, 10)
            .await
            .unwrap_err();
        assert_eq!(error.code, "local_auth_invalid_json");
    }

    #[test]
    fn shell_script_command_uses_sh_with_unchanged_arguments() {
        let command = plugin_command(
            Path::new("plugin with spaces/scripts/local-auth.sh"),
            &["login".to_owned(), "中文".to_owned()],
        )
        .unwrap();
        let command = command.as_std();
        assert_eq!(command.get_program(), "sh");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["plugin with spaces/scripts/local-auth.sh", "login", "中文"]
        );
    }

    #[test]
    fn powershell_command_uses_process_scoped_execution_policy_bypass() {
        let command = powershell_command(
            Path::new("plugin with spaces/scripts/local-auth.ps1"),
            &["login".to_owned(), "中文".to_owned()],
            Path::new("pwsh"),
        );
        let command = command.as_std();
        assert_eq!(command.get_program(), "pwsh");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "plugin with spaces/scripts/local-auth.ps1",
                "login",
                "中文"
            ]
        );
    }

    #[test]
    fn windows_powershell_prefers_pwsh_from_path() {
        let temp = tempfile::tempdir().unwrap();
        let tools = temp.path().join("tools");
        let system_root = temp.path().join("Windows");
        fs::create_dir_all(&tools).unwrap();
        fs::write(tools.join("pwsh.exe"), "").unwrap();
        let windows_powershell = system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        fs::create_dir_all(windows_powershell.parent().unwrap()).unwrap();
        fs::write(&windows_powershell, "").unwrap();

        assert_eq!(
            resolve_windows_powershell_program(std::slice::from_ref(&tools), Some(&system_root))
                .unwrap(),
            tools.join("pwsh.exe").canonicalize().unwrap()
        );
    }

    #[test]
    fn windows_powershell_makes_relative_path_entry_absolute() {
        let current_dir = env::current_dir().unwrap();
        let temp = tempfile::tempdir_in(&current_dir).unwrap();
        let relative_temp = temp.path().strip_prefix(&current_dir).unwrap();
        let tools = relative_temp.join("tools");
        let pwsh = tools.join("pwsh.exe");
        fs::create_dir_all(&tools).unwrap();
        fs::write(&pwsh, "").unwrap();

        assert!(tools.is_relative());
        assert_eq!(
            resolve_windows_powershell_program(&[tools], None).unwrap(),
            pwsh.canonicalize().unwrap()
        );
    }

    #[test]
    fn windows_powershell_falls_back_to_system_51() {
        let temp = tempfile::tempdir().unwrap();
        let system_root = temp.path().join("Windows");
        let windows_powershell = system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        fs::create_dir_all(windows_powershell.parent().unwrap()).unwrap();
        fs::write(&windows_powershell, "").unwrap();

        assert_eq!(
            resolve_windows_powershell_program(&[], Some(&system_root)).unwrap(),
            windows_powershell
        );
    }

    #[test]
    fn windows_powershell_reports_clear_error_when_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let error = resolve_windows_powershell_program(&[], Some(temp.path())).unwrap_err();

        assert_eq!(error.code, "local_auth_powershell_missing");
        assert!(error.message.contains("PowerShell 7"));
        assert!(error.message.contains("PowerShell 5.1"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_system_powershell_runs_local_auth_lifecycle_without_pwsh() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_root = temp.path().join("plugin");
        let scripts = plugin_root.join("scripts");
        let executor_home = temp.path().join("executor-home");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(&executor_home).unwrap();
        fs::write(scripts.join("local-auth.sh"), "#!/bin/sh\n").unwrap();
        fs::write(
            scripts.join("local-auth.ps1"),
            r#"param([string]$Action = 'health')
$marker = Join-Path $env:WEGENT_EXECUTOR_HOME 'windows-powershell-51-auth'
switch ($Action) {
  'health' {
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
      Write-Output '{"status":"ok"}'
    } else {
      Write-Output '{"status":"need_login"}'
    }
  }
  'login' {
    Set-Content -LiteralPath $marker -Value 'ready'
    Write-Output '{"status":"ok"}'
  }
  'logout' {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Write-Output '{"status":"ok"}'
  }
}
"#,
        )
        .unwrap();

        let system_root = env::var_os("SystemRoot")
            .or_else(|| env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let program =
            resolve_program_for_platform(&plugin_root, "scripts/local-auth.sh", true).unwrap();

        for (action, expected_status) in [
            ("health", "need_login"),
            ("login", "ok"),
            ("health", "ok"),
            ("logout", "ok"),
        ] {
            let mut command = plugin_command_for_platform(
                &program,
                &[action.to_owned()],
                true,
                &[],
                Some(&system_root),
            )
            .unwrap();
            assert_eq!(
                command.as_std().get_program(),
                system_root
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            );
            let output = command
                .current_dir(&plugin_root)
                .env("WEGENT_EXECUTOR_HOME", &executor_home)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "Windows PowerShell local-auth {action} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                result.get("status").and_then(Value::as_str),
                Some(expected_status)
            );
        }
    }

    #[test]
    fn windows_resolves_shell_manifest_entry_to_powershell_sibling() {
        let temp = tempfile::tempdir().unwrap();
        let scripts = temp.path().join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        let shell = scripts.join("local-auth.sh");
        let powershell = scripts.join("local-auth.ps1");
        fs::write(&shell, "#!/bin/sh").unwrap();
        fs::write(&powershell, "Write-Output ok").unwrap();

        assert_eq!(
            resolve_program_for_platform(temp.path(), "scripts/local-auth.sh", true).unwrap(),
            powershell
        );
        assert_eq!(
            resolve_program_for_platform(temp.path(), "scripts/local-auth.sh", false).unwrap(),
            shell
        );
    }
}
