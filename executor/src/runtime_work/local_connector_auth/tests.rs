#[cfg(windows)]
use super::commands::plugin_command_for_platform;
use super::commands::{
    plugin_command, powershell_command, resolve_program_for_platform,
    resolve_windows_powershell_program,
};
use super::*;
use std::env;

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
            marketplace_id: None,
            plugin_root: None,
            state,
            task,
        },
    );

    let state = {
        let sessions = browser_auth_sessions().lock().await;
        active_browser_auth_state(&sessions, &plugin_key, &connector_slug, None, None)
            .expect("active session")
    };
    let reused = state.lock().await;

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

#[cfg(unix)]
#[tokio::test]
async fn marketplace_uninstall_uses_only_opted_in_connectors_from_the_installed_package() {
    let package = tempfile::tempdir().unwrap();
    fs::write(
        package.path().join("logout.sh"),
        "#!/bin/sh\nrm -- \"$1\"\nprintf '{\"status\":\"ok\"}\\n'\n",
    )
    .unwrap();
    let connector = |slug, opted_in| {
        json!({"slug": slug, "localAuth": {
            "kind": "browser_oauth",
            "health": ["logout.sh"],
            "start": ["logout.sh"],
            "logout": ["logout.sh", slug],
            "logoutOnUninstall": opted_in,
        }})
    };
    for marker in ["clear-auth", "keep-auth"] {
        fs::write(package.path().join(marker), "authorized").unwrap();
    }
    let manifest = json!({"connectors": [
        connector("clear-auth", true),
        connector("keep-auth", false),
    ]});

    logout_before_plugin_uninstall(package.path(), &manifest).await;

    assert!(!package.path().join("clear-auth").exists());
    assert_eq!(
        fs::read_to_string(package.path().join("keep-auth")).unwrap(),
        "authorized"
    );
}

#[tokio::test]
async fn logout_with_explicit_root_preserves_same_name_session_at_another_root() {
    let home = tempfile::tempdir().unwrap();
    let first_root = home.path().join("first");
    let other_root = home.path().join("other");
    let plugin_key = format!("plugin-{}", Uuid::new_v4());
    let connector_slug = "browser-auth";
    let manifest = json!({"name": plugin_key, "connectors": [{
        "slug": connector_slug, "localAuth": {
            "kind": "browser_oauth", "health": ["auth.sh"], "start": ["auth.sh"]
        }
    }]});
    for root in [&first_root, &other_root] {
        write_plugin_manifest(root);
        fs::write(root.join(".codex-plugin/plugin.json"), manifest.to_string()).unwrap();
    }
    let request = |root: &Path| json!({"pluginKey": plugin_key, "connectorSlug": connector_slug, "pluginRoot": root});
    let mut ids = Vec::new();
    for root in [&first_root, &other_root] {
        let id = Uuid::new_v4().to_string();
        browser_auth_sessions().lock().await.insert(
            id.clone(),
            BrowserAuthSession {
                plugin_key: plugin_key.clone(),
                connector_slug: connector_slug.into(),
                marketplace_id: None,
                plugin_root: Some(root.canonicalize().unwrap()),
                state: Arc::new(Mutex::new(browser_session_state(
                    "waiting_browser",
                    "",
                    &id,
                ))),
                task: tokio::spawn(std::future::pending()),
            },
        );
        ids.push(id);
    }

    assert_eq!(logout(request(&first_root)).await.unwrap()["status"], "ok");
    let mut first_poll = request(&first_root);
    first_poll["sessionId"] = json!(ids[0]);
    let mut other_poll = request(&other_root);
    other_poll["sessionId"] = json!(ids[1]);
    assert_eq!(
        poll(first_poll).await.unwrap_err().code,
        "local_auth_session_missing"
    );
    let unaffected = poll(other_poll.clone()).await;
    cancel(other_poll).await.unwrap();
    assert_eq!(unaffected.unwrap()["status"], "waiting_browser");
}

#[tokio::test]
async fn marketplace_uninstall_cancels_and_blocks_auth_only_in_that_market() {
    let home = tempfile::tempdir().unwrap();
    let cache = home.path().canonicalize().unwrap().join("plugins/cache");
    let plugin_key = format!("plugin-{}", Uuid::new_v4());
    let removing_market = cache.join("custom");
    let removed_package = removing_market.join(&plugin_key);
    let current_root = removed_package.join("10.0.0");
    let other_root = cache.join("other").join(&plugin_key).join("9.0.0");
    let connector_slug = "same-connector";
    let manifest = json!({
        "name": plugin_key,
        "connectors": [{
            "slug": connector_slug,
            "localAuth": {
                "kind": "browser_oauth",
                "start": ["auth.sh"],
                "health": ["auth.sh"]
            }
        }]
    });
    for root in [&current_root, &other_root] {
        write_plugin_manifest(root);
        fs::write(root.join(".codex-plugin/plugin.json"), manifest.to_string()).unwrap();
    }
    let payload = |root: &Path| {
        json!({
            "pluginKey": plugin_key,
            "connectorSlug": connector_slug,
            "pluginRoot": root
        })
    };
    let old_id = Uuid::new_v4().to_string();
    let other_id = Uuid::new_v4().to_string();
    let session = |id, root| BrowserAuthSession {
        plugin_key: plugin_key.clone(),
        connector_slug: connector_slug.into(),
        marketplace_id: None,
        plugin_root: Some(root),
        state: Arc::new(Mutex::new(browser_session_state("waiting_browser", "", id))),
        task: tokio::spawn(std::future::pending()),
    };
    let old = session(&old_id, removed_package.join("9.0.0"));
    let old_task = old.task.abort_handle();
    {
        let mut sessions = browser_auth_sessions().lock().await;
        sessions.insert(old_id.clone(), old);
        sessions.insert(other_id.clone(), session(&other_id, other_root.clone()));
    }

    let active = {
        let sessions = browser_auth_sessions().lock().await;
        active_browser_auth_state(
            &sessions,
            &plugin_key,
            connector_slug,
            Some(&other_root),
            None,
        )
        .expect("the other market's session")
    };
    assert_eq!(active.lock().await["sessionId"], other_id);
    let _removal = MarketplaceRemoval::begin(removing_market).unwrap();
    cancel_marketplace_plugin_sessions(&removed_package).await;

    let blocked = start(payload(&current_root)).await.unwrap_err();
    assert_eq!(blocked.code, "marketplace_removal_in_progress");
    let unaffected = start(payload(&other_root)).await.unwrap();
    assert_eq!(unaffected["sessionId"], other_id);

    let mut sessions = browser_auth_sessions().lock().await;
    assert!(!sessions.contains_key(&old_id));
    assert!(old_task.is_finished());
    let other = sessions
        .remove(&other_id)
        .expect("same-name session in the other marketplace");
    assert!(!other.task.is_finished());
    other.task.abort();
}

#[tokio::test]
async fn marketplace_uninstall_waits_for_qr_and_rejects_new_start_and_poll() {
    let home = tempfile::tempdir().unwrap();
    let cache = home.path().canonicalize().unwrap().join("plugins/cache");
    let market = cache.join("custom");
    let package = market.join("qr-plugin/1.0.0");
    let peer = cache.join("other/qr-plugin/1.0.0");
    write_plugin_manifest(&package);
    fs::create_dir_all(&peer).unwrap();
    let manifest = json!({"name": "qr-plugin", "connectors": [{
        "slug": "qr", "localAuth": {
            "kind": "local_qr", "start": ["auth.sh"], "poll": ["auth.sh"],
            "health": ["auth.sh"]
        }
    }]});
    fs::write(
        package.join(".codex-plugin/plugin.json"),
        manifest.to_string(),
    )
    .unwrap();
    let payload = json!({"pluginKey": "qr-plugin", "connectorSlug": "qr", "pluginRoot": package});

    let inflight = QrAuthOperation::begin(&package).unwrap();
    let other = QrAuthOperation::begin(&peer).unwrap();
    let removal = MarketplaceRemoval::begin(market).unwrap();
    for result in [start(payload.clone()).await, poll(payload).await] {
        assert_eq!(result.unwrap_err().code, "marketplace_removal_in_progress");
    }
    let drain = removal.wait_for_qr_auth(tokio::time::Instant::now() + Duration::from_secs(2));
    tokio::pin!(drain);
    assert!(futures_util::poll!(&mut drain).is_pending());
    drop(inflight);
    drain.await.unwrap();
    drop(other);
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
        account_auth: false,
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

fn active_plugin_inventory(version: &str) -> Value {
    json!({"marketplaces":[{"name":"wework-personal","plugins":[{
        "id":"demo@wework-personal","name":"demo","installed":true,
        "enabled":true,"localVersion":version
    }]}]})
}

fn write_auth_plugin(root: &Path, auth: bool) {
    fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    let connectors = if auth {
        json!([{"slug":"account","localAuth":{
            "kind":"browser_oauth","health":["health"],"start":["login"]
        }}])
    } else {
        json!([])
    };
    fs::write(
        root.join(".codex-plugin/plugin.json"),
        json!({"name":"demo","connectors":connectors}).to_string(),
    )
    .unwrap();
}

#[test]
fn resolve_plugin_root_uses_current_installation_including_downgrades() {
    let home = tempfile::tempdir().unwrap();
    let cache = home.path().join("plugins/cache/wework-personal/demo");
    for version in ["0.1.9", "0.1.10"] {
        write_auth_plugin(&cache.join(version), true);
    }
    let payload =
        json!({"pluginKey":"demo","marketplaceId":"wework-personal","connectorSlug":"account"});
    for current in ["0.1.10", "0.1.9"] {
        let (root, spec) = resolution::resolve_installed_request(
            &payload,
            &active_plugin_inventory(current),
            home.path(),
        )
        .unwrap();
        assert_eq!(root, cache.join(current).canonicalize().unwrap());
        assert_eq!(spec.connector_slug, "account");
    }
}

#[test]
fn current_installation_without_auth_cannot_use_a_retained_package() {
    let home = tempfile::tempdir().unwrap();
    let cache = home.path().join("plugins/cache/wework-personal/demo");
    write_auth_plugin(&cache.join("0.1.9"), true);
    write_auth_plugin(&cache.join("0.1.10"), false);
    let payload =
        json!({"pluginKey":"demo","marketplaceId":"wework-personal","connectorSlug":"account"});
    let result = resolution::resolve_installed_request(
        &payload,
        &active_plugin_inventory("0.1.10"),
        home.path(),
    );
    assert_eq!(result.unwrap_err().code, "local_auth_missing");
}

#[test]
fn current_local_source_and_disabled_installation_remain_manageable() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("author-source");
    write_auth_plugin(&source, true);
    let mut inventory = active_plugin_inventory("0.1.10");
    let plugin = &mut inventory["marketplaces"][0]["plugins"][0];
    plugin["enabled"] = json!(false);
    plugin["localVersion"] = Value::Null;
    plugin["source"] = json!({"type":"local","path":source});
    let payload = json!({"pluginKey":"demo","marketplaceId":"wework-personal"});
    let (root, _) =
        resolution::resolve_installed_request(&payload, &inventory, home.path()).unwrap();
    assert_eq!(root, source.canonicalize().unwrap());
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(source.join(".codex-plugin/plugin.json")).unwrap())
            .unwrap();
    manifest["name"] = json!("Demo Tool");
    fs::write(
        source.join(".codex-plugin/plugin.json"),
        manifest.to_string(),
    )
    .unwrap();
    let mut displayed = inventory.clone();
    displayed["marketplaces"][0]["plugins"][0]["name"] = json!("demo-tool");
    assert!(resolution::resolve_installed_request(
        &json!({"pluginKey":"demo-tool"}),
        &displayed,
        home.path()
    )
    .is_ok());
    inventory["marketplaces"][0]["plugins"][0]["installed"] = json!(false);
    assert!(resolution::resolve_installed_request(&payload, &inventory, home.path()).is_err());
}

#[test]
fn reject_unsafe_plugin_key() {
    for key in ["../escape", "/tmp/evil"] {
        let payload = json!({"pluginKey":key,"marketplaceId":"wework-personal"});
        let result = resolution::resolve_installed_request(
            &payload,
            &active_plugin_inventory("0.1.10"),
            Path::new("/unused"),
        );
        assert_eq!(result.unwrap_err().code, "bad_request");
    }
}
