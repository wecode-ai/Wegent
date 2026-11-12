// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, MutexGuard, OnceLock},
};

use serde_json::Value;
#[cfg(unix)]
use std::{
    io::{Seek, Write},
    process::{Command, Stdio},
};
use wegent_executor::local::command::{build_env, CommandHandler, CommandRequest};

#[tokio::test]
#[cfg(unix)]
async fn directory_commands_do_not_require_child_programs() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("visible")).unwrap();
    fs::create_dir(root.path().join(".hidden")).unwrap();
    fs::write(root.path().join("file.txt"), "content").unwrap();
    std::os::unix::fs::symlink(root.path().join("visible"), root.path().join("link")).unwrap();
    for (key, argv, expected) in [
        (
            "home_dir",
            vec!["printenv", "HOME"],
            format!("{}\n", root.path().display()),
        ),
        (
            "ls_dirs",
            vec!["ls", "-a", "-p"],
            "../\n./\n.hidden/\nfile.txt\nlink\nvisible/\n".to_owned(),
        ),
    ] {
        let result = CommandHandler
            .execute(CommandRequest::from_value(serde_json::json!({
                "command_key": key, "command": argv.join(" "), "argv": argv,
                "cwd": root.path(), "env": { "PATH": root.path(), "HOME": root.path() }
            })))
            .await;
        assert!(result.success, "{key}: {result:?}");
        assert_eq!(result.stdout, expected, "{key}");
    }
}

#[tokio::test]
async fn native_directory_commands_preserve_limits_and_invalid_paths() {
    let root = tempfile::tempdir().unwrap();
    let request = serde_json::json!({
        "command_key": "ls_dirs", "command": "ls -a -p", "argv": ["ls", "-a", "-p"],
        "cwd": root.path(), "max_output_bytes": 2
    });
    let result = CommandHandler
        .execute(CommandRequest::from_value(request.clone()))
        .await;
    assert!(result.success);
    assert!(result.stdout_truncated);
    assert_eq!(result.stdout.as_str().unwrap().len(), 2);
    let mut missing = request;
    missing["cwd"] = serde_json::json!(root.path().join("missing"));
    let result = CommandHandler
        .execute(CommandRequest::from_value(missing))
        .await;
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("Working directory does not exist"));
}

#[tokio::test]
#[cfg(not(windows))]
async fn native_directory_queries_do_not_override_custom_commands() {
    let result = CommandHandler
        .execute(CommandRequest::from_value(serde_json::json!({
            "command_key": "home_dir", "command": "custom-home-command",
            "argv": ["missing-custom-home-command"]
        })))
        .await;
    assert!(
        !result.success,
        "The explicit command must not become a native HOME lookup"
    );
}

#[tokio::test]
async fn forwarded_git_branch_queries_use_portable_commands() {
    let root = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let mut command = std::process::Command::new("git");
        wegent_executor::local::native_git::clear_local_git_env(&mut command);
        let output = command
            .args(args)
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init"]);
    git(&["symbolic-ref", "HEAD", "refs/heads/feature/portable"]);
    let execute = |key: &'static str, command: &'static str, argv: Vec<&'static str>| {
        let path = root.path();
        async move {
            CommandHandler
                .execute(CommandRequest::from_value(serde_json::json!({
                    "command_key": key, "command": command, "argv": argv, "cwd": path
                })))
                .await
        }
    };
    let current = execute(
        "git_branch",
        "git branch --show-current",
        vec!["git", "branch", "--show-current"],
    )
    .await;
    assert!(current.success, "{current:?}");
    assert_eq!(current.stdout, "feature/portable\n");
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "seed",
    ]);
    for argv in [vec![], vec!["git", "branch", "--format=%(refname:short)"]] {
        let branches = execute(
            "git_branch_list",
            "git branch --format=%(refname:short)",
            argv,
        )
        .await;
        assert!(branches.success, "{branches:?}");
        assert_eq!(branches.stdout, "feature/portable\n");
    }
    git(&["checkout", "--detach"]);
    let detached = execute("git_branch", "git branch --show-current", vec![]).await;
    assert!(detached.success, "{detached:?}");
    assert_eq!(detached.stdout, "");
    let custom = execute("git_branch", "git --version", vec!["git", "--version"]).await;
    assert!(custom.success, "{custom:?}");
    assert!(custom.stdout.as_str().unwrap().starts_with("git version "));
}

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn build_env_removes_pyinstaller_runtime_variables() {
    let _lock = env_lock();
    let _archive = EnvGuard::set("_PYI_ARCHIVE_FILE", "/tmp/wegent-executor");
    let _parent = EnvGuard::set("_PYI_PARENT_PROCESS_LEVEL", "0");
    let _application = EnvGuard::set("_PYI_APPLICATION_HOME_DIR", "/tmp/_MEI123");
    let _meipass = EnvGuard::set("_MEIPASS", "/tmp/_MEI456");
    let _mei_custom = EnvGuard::set("_MEI_CUSTOM", "/tmp/_MEI789");
    let _home = EnvGuard::set("WECODE_HOME", "/tmp/wecode");

    let env = build_env(&HashMap::from([
        ("EXTRA_ENV".to_owned(), "ok".to_owned()),
        ("NULL_ENV".to_owned(), String::new()),
        ("_PYI_EXTRA".to_owned(), "bad".to_owned()),
        ("_MEI_EXTRA".to_owned(), "bad".to_owned()),
    ]));

    assert_eq!(env.get("WECODE_HOME"), Some(&"/tmp/wecode".to_owned()));
    assert_eq!(env.get("EXTRA_ENV"), Some(&"ok".to_owned()));
    assert_eq!(env.get("NULL_ENV"), Some(&String::new()));
    assert!(env.keys().all(|key| !key.starts_with("_PYI_")));
    assert!(env.keys().all(|key| !key.starts_with("_MEI_")));
    assert!(!env.contains_key("_MEIPASS"));
}

#[tokio::test]
async fn execute_command_uses_argv_and_cwd() {
    let workdir = unique_dir("argv-cwd");
    fs::create_dir_all(&workdir).unwrap();
    fs::write(workdir.join("target.txt"), "ok").unwrap();

    #[cfg(unix)]
    let argv = vec!["cat".to_owned(), "target.txt".to_owned()];
    #[cfg(windows)]
    let argv = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::Write([IO.File]::ReadAllText('target.txt'))",
    ]
    .map(str::to_owned)
    .to_vec();
    let result = CommandHandler
        .execute(CommandRequest {
            command_key: None,
            command: argv[0].clone(),
            argv,
            cwd: Some(workdir.display().to_string()),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success, "{result:?}");
    assert_eq!(result.stdout, Value::String("ok".to_owned()));
}

#[tokio::test]
async fn execute_command_argv_does_not_invoke_shell() {
    #[cfg(unix)]
    let argv = ["printf", "%s", "hello; echo hacked"]
        .map(str::to_owned)
        .to_vec();
    #[cfg(windows)]
    let fixture = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    let argv = {
        let script = fixture.path().join("literal argument.ps1");
        fs::write(&script, "param([string]$Value)\n[Console]::Write($Value)").unwrap();
        vec![
            "powershell.exe".to_owned(),
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-ExecutionPolicy".to_owned(),
            "Bypass".to_owned(),
            "-File".to_owned(),
            script.display().to_string(),
            "hello; echo hacked".to_owned(),
        ]
    };
    let result = CommandHandler
        .execute(CommandRequest {
            command_key: None,
            command: argv[0].clone(),
            argv,
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success, "{result:?}");
    assert_eq!(
        result.stdout,
        Value::String("hello; echo hacked".to_owned())
    );
}

#[tokio::test]
async fn execute_command_returns_completed_process_result() {
    #[cfg(unix)]
    let script = "printf 'hello'";
    #[cfg(windows)]
    let script = "<nul set /p =hello& exit /b 0";
    let result = CommandHandler
        .execute(CommandRequest {
            command_key: None,
            command: script.to_owned(),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success, "{result:?}");
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.stdout, Value::String("hello".to_owned()));
    assert_eq!(result.stderr, "");
    assert!(result.duration >= 0.0);
    assert!(!result.timed_out);
}

#[cfg(unix)]
#[test]
fn execute_command_child_does_not_inherit_executor_stdin_contract() {
    // Prepare readable input before spawning: the isolated child can exit before
    // a parent writes to a pipe, which would turn success into a BrokenPipe race.
    let mut input = tempfile::tempfile().unwrap();
    input.write_all(b"app-ipc-protocol-frame\n").unwrap();
    input.rewind().unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "execute_command_child_does_not_inherit_executor_stdin",
            "--nocapture",
        ])
        .env("WEGENT_TEST_COMMAND_STDIN_CHILD", "1")
        .stdin(Stdio::from(input))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn execute_command_child_does_not_inherit_executor_stdin() {
    if std::env::var("WEGENT_TEST_COMMAND_STDIN_CHILD").as_deref() != Ok("1") {
        return;
    }

    let result = CommandHandler
        .execute(CommandRequest {
            command_key: None,
            command: "cat".to_owned(),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success);
    assert_eq!(result.stdout, Value::String(String::new()));
}

#[tokio::test]
async fn execute_command_times_out_and_returns_error() {
    #[cfg(unix)]
    let script = "sleep 2";
    #[cfg(windows)]
    let script = "powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2\"";
    let result = CommandHandler
        .execute(CommandRequest {
            command_key: None,
            command: script.to_owned(),
            timeout_seconds: 0.1,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(!result.success);
    assert_eq!(result.exit_code, None, "{result:?}");
    assert!(result.timed_out, "{result:?}");
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("timed out"));
}

#[tokio::test]
async fn execute_command_missing_cwd_returns_error() {
    let missing_cwd = unique_dir("missing-cwd");

    let result = CommandHandler
        .execute(CommandRequest {
            command_key: None,
            command: "pwd".to_owned(),
            cwd: Some(missing_cwd.display().to_string()),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(!result.success);
    assert_eq!(result.exit_code, None);
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Working directory does not exist"));
}

#[cfg(windows)]
#[tokio::test]
async fn execute_windows_pwd_builtin_uses_requested_cwd() {
    let workdir = tempfile::tempdir().unwrap();
    let requested_cwd = workdir.path().display().to_string();

    let result = CommandHandler
        .execute(CommandRequest {
            command_key: Some("pwd".to_owned()),
            command: "pwd".to_owned(),
            cwd: Some(requested_cwd.clone()),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success);
    assert_eq!(result.stdout, Value::String(requested_cwd));
}

#[cfg(windows)]
#[tokio::test]
async fn execute_windows_pwd_builtin_rejects_missing_cwd() {
    let missing_cwd = unique_dir("missing-windows-pwd-cwd");

    let result = CommandHandler
        .execute(CommandRequest {
            command_key: Some("pwd".to_owned()),
            command: "pwd".to_owned(),
            cwd: Some(missing_cwd.display().to_string()),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(!result.success);
    assert_eq!(result.exit_code, None);
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Working directory does not exist"));
}

fn unique_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-local-command-{label}-{}",
        std::process::id()
    ))
}
