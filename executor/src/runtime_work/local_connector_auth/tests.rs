use super::*;

fn write_plugin_manifest(plugin_root: &Path) {
    fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"desktop-e2e-plugin","version":"0.1.0"}"#,
    )
    .unwrap();
}

#[test]
fn force_nonblocking_poll_args() {
    let mut command = vec![
        "scripts/run-weibo-wiki.sh".to_owned(),
        "auth".to_owned(),
        "status".to_owned(),
        "--wait-seconds".to_owned(),
        "120".to_owned(),
    ];
    ensure_wait_seconds_zero(&mut command);
    assert_eq!(command.last().map(String::as_str), Some("0"));

    let mut missing = vec![
        "scripts/run.sh".to_owned(),
        "auth".to_owned(),
        "status".to_owned(),
    ];
    ensure_wait_seconds_zero(&mut missing);
    assert!(missing
        .windows(2)
        .any(|pair| pair == ["--wait-seconds", "0"]));
}

#[tokio::test]
async fn reuses_active_browser_auth_session_state() {
    let plugin_key = format!("plugin-{}", Uuid::new_v4());
    let connector_slug = "browser-auth".to_owned();
    let session_id = Uuid::new_v4().to_string();
    let state = Arc::new(tokio::sync::Mutex::new(browser_session_state(
        "waiting_browser",
        "Complete authorization in the browser",
        &session_id,
    )));
    let task = tokio::spawn(async { std::future::pending::<()>().await });
    browser_auth_sessions().lock().await.insert(
        session_id.clone(),
        BrowserAuthSession {
            plugin_key: plugin_key.clone(),
            connector_slug: connector_slug.clone(),
            state,
            task,
        },
    );

    let reused = active_browser_auth_state(&plugin_key, &connector_slug)
        .await
        .expect("active session");

    assert_eq!(
        reused.get("sessionId").and_then(Value::as_str),
        Some(session_id.as_str())
    );
    let session = browser_auth_sessions()
        .lock()
        .await
        .remove(&session_id)
        .expect("inserted session");
    session.task.abort();
}

#[test]
fn reject_absolute_and_parent_paths() {
    assert!(validate_relative_arg("scripts/run.sh").is_ok());
    assert!(validate_relative_arg("/tmp/evil").is_err());
    assert!(validate_relative_arg("../escape").is_err());
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

#[test]
fn normalize_ok_status() {
    let spec = LocalAuthSpec {
        connector_slug: "test".into(),
        account_auth: AccountAuth::None,
        kind: "local_qr".to_owned(),
        health: vec![],
        start: vec![],
        poll: vec![],
        logout: vec![],
        qr_field: "qr_path".to_owned(),
        status_field: "status".to_owned(),
        ok_values: vec!["ok".to_owned()],
        timeout_seconds: 45,
        tool: None,
    };
    let result = normalize_status_response(&json!({"status": "ok", "hint": "ready"}), &spec, None);
    assert_eq!(result.get("status").and_then(Value::as_str), Some("ok"));
    assert_eq!(result.get("rawStatus").and_then(Value::as_str), Some("ok"));
}

#[test]
fn resolve_plugin_root_scans_all_marketplace_caches() {
    let temp = tempfile::tempdir().unwrap();
    let executor_home = temp.path().join("executor-home");
    let plugin_root =
        executor_home.join("codex/plugins/cache/desktop-e2e-marketplace/desktop-e2e-plugin/0.1.0");
    write_plugin_manifest(&plugin_root);

    let candidates = installed_plugin_root_candidates("desktop-e2e-plugin", &executor_home, &[])
        .expect("candidates");
    assert_eq!(candidates, vec![plugin_root]);
}

#[test]
fn resolve_executor_home_uses_runtime_path_without_platform_home() {
    let executor_home = PathBuf::from("runtime/executor-home");

    let resolved = resolve_executor_home(Some(executor_home.clone()), None).unwrap();

    assert_eq!(resolved, executor_home);
}

#[test]
fn resolve_plugin_root_prefers_newest_version_directory() {
    let temp = tempfile::tempdir().unwrap();
    let executor_home = temp.path().join("executor-home");
    let older = executor_home.join("codex/plugins/cache/wegent/demo-plugin/0.1.0");
    let newer = executor_home.join("codex/plugins/cache/wegent/demo-plugin/0.2.0");
    write_plugin_manifest(&older);
    write_plugin_manifest(&newer);

    let candidates =
        installed_plugin_root_candidates("demo-plugin", &executor_home, &[]).expect("candidates");
    assert_eq!(candidates.first(), Some(&newer));
}

#[test]
fn reject_unsafe_plugin_key() {
    assert!(!is_safe_plugin_key("../escape"));
    assert!(!is_safe_plugin_key("/tmp/evil"));
    assert!(is_safe_plugin_key("desktop-e2e-plugin"));
}
