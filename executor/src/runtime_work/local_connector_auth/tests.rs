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
