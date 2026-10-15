use super::*;

fn health_plugin(script: &str) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join(".codex-plugin")).unwrap();
    fs::create_dir_all(root.path().join("scripts")).unwrap();
    fs::write(root.path().join("scripts/health.sh"), script).unwrap();
    fs::write(
        root.path().join(".codex-plugin/plugin.json"),
        json!({
            "name": "health-timeout-test",
            "connectors": [{
                "slug": "test",
                "localAuth": {
                    "kind": "local_qr",
                    "health": ["scripts/health.sh"],
                    "start": ["scripts/health.sh"],
                    "poll": ["scripts/health.sh"]
                }
            }]
        })
        .to_string(),
    )
    .unwrap();
    root
}

fn health_payload(root: &Path) -> Value {
    json!({
        "pluginKey": "health-timeout-test",
        "connectorSlug": "test",
        "pluginRoot": root
    })
}

#[tokio::test]
async fn slow_health_command_times_out_after_three_seconds() {
    let root = health_plugin("#!/bin/sh\nexec sleep 30\n");
    let started = std::time::Instant::now();

    let error = tokio::time::timeout(Duration::from_secs(6), health(health_payload(root.path())))
        .await
        .expect("Health check exceeded its three-second command budget")
        .unwrap_err();

    assert_eq!(error.code, "local_auth_timeout");
    assert!(started.elapsed() >= Duration::from_secs(3));
}

#[tokio::test]
async fn fast_health_command_preserves_login_status() {
    for status in ["ok", "need_login"] {
        let root = health_plugin(&format!(
            "#!/bin/sh\nprintf '%s' '{{\"status\":\"{status}\"}}'\n"
        ));

        let result = health(health_payload(root.path())).await.unwrap();

        assert_eq!(result["status"], status);
    }
}
