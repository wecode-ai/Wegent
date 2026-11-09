use super::*;

#[cfg(unix)]
fn fixture(directory: &std::path::Path) -> HashMap<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join("gh");
    std::fs::write(
        &path,
        r#"#!/bin/sh
if [ "$1" = '--version' ]; then printf 'gh fixture\n'; exit 0; fi
# Any old all-host auth status probe returns the opposite result on purpose.
if [ "$1 $2" = 'auth status' ]; then exit 0; fi
if [ "$*" != 'api user --silent --hostname github.com' ]; then exit 99; fi
if [ -f "$GH_CONFIG_DIR/ready" ]; then exit 0; fi
case "$GH_CONFIG_DIR" in
  */ready) exit 0 ;;
  */forbidden) printf 'HTTP 403 SECRET' >&2; exit 1 ;;
  */network) printf 'connection timeout SECRET' >&2; exit 1 ;;
  */unavailable) printf 'gh: command not found' >&2; exit 127 ;;
  *) exit 4 ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    HashMap::from([
        ("PATH".into(), directory.to_string_lossy().into_owned()),
        ("GH_TOKEN".into(), String::new()),
        ("GITHUB_TOKEN".into(), String::new()),
    ])
}

#[cfg(unix)]
#[tokio::test]
async fn hosting_and_plugin_probes_agree_for_the_effective_profile_and_error_class() {
    let directory = tempfile::tempdir().unwrap();
    let mut environment = fixture(directory.path());
    for (profile, status, error) in [
        ("ready", "ok", None),
        ("empty", "need_login", None),
        ("forbidden", "error", Some("gh_health_failed")),
        ("network", "error", Some("gh_health_failed")),
        ("unavailable", "error", Some("gh_health_failed")),
    ] {
        environment.insert(
            "GH_CONFIG_DIR".into(),
            directory.path().join(profile).display().to_string(),
        );
        let health = health(&environment, Duration::from_secs(5), "test").await;
        let hosting = crate::local::git_commands::hosting_cli_status("gh", &environment, 5.0).await;
        assert_eq!(health["status"], status);
        assert_eq!(hosting.stdout["authenticated"], status == "ok");
        assert_eq!(hosting.stdout["detectionError"].as_str(), error);
        assert!(!serde_json::to_string(&hosting).unwrap().contains("SECRET"));
    }
}

#[test]
fn login_logout_and_probe_commands_use_the_supplied_effective_directory() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path();
    let root = home.join(".wegent/workbench");
    std::fs::create_dir_all(root.join("git-auth/current")).unwrap();
    let managed = super::super::git_credentials::environment_for(&root, home, false);
    let mut environment = HashMap::from([("GH_CONFIG_DIR".into(), "/native/gh".into())]);
    environment.extend(managed);
    for args in [HEALTH_ARGS, &["auth", "login"][..], &["auth", "logout"][..]] {
        let command = command(args, &environment);
        let configured = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "GH_CONFIG_DIR")
            .and_then(|(_, value)| value)
            .unwrap();
        assert_eq!(configured, root.join("git-auth/current/gh"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn github_cli_synced_context_is_consistent_and_read_only() {
    if std::env::var_os("WEGENT_GITHUB_CLI_TEST_CHILD").is_some() {
        let payload = json!({"pluginKey":"github", "connectorSlug":"wework-github-cli"});
        let api = &payload;
        let environment = crate::process_environment::process_env(&[]);
        assert_ne!(
            environment["GH_CONFIG_DIR"],
            std::env::var("GH_CONFIG_DIR").unwrap()
        );
        assert_eq!(
            crate::runtime_work::local_connector_auth::health(api.clone())
                .await
                .unwrap()["status"],
            "need_login"
        );
        for result in [
            crate::runtime_work::local_connector_auth::start(api.clone())
                .await
                .unwrap(),
            crate::runtime_work::local_connector_auth::logout(api.clone())
                .await
                .unwrap(),
        ] {
            assert_eq!(result["errorCode"], "gh_auth_managed");
        }
        let config = std::path::Path::new(&environment["GH_CONFIG_DIR"]);
        assert!(
            !config.exists(),
            "Interactive auth must not write the managed store"
        );
        // A subsequent device sync becomes visible without restarting the process.
        std::fs::create_dir_all(config).unwrap();
        std::fs::write(config.join("ready"), "fixture account").unwrap();
        assert_eq!(
            crate::runtime_work::local_connector_auth::health(api.clone())
                .await
                .unwrap()["status"],
            "ok"
        );
        let hosting =
            crate::local::git_commands::hosting_cli_status("gh", &HashMap::new(), 5.0).await;
        assert_eq!(hosting.stdout["authenticated"], true);
        assert_eq!(
            crate::runtime_work::local_connector_auth::start(api.clone())
                .await
                .unwrap()["status"],
            "ok"
        );
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let environment = fixture(directory.path());
    let workbench = directory.path().join("workbench");
    std::fs::create_dir_all(workbench.join("git-auth/current/glab")).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "services::github_cli::tests::github_cli_synced_context_is_consistent_and_read_only",
        ])
        .env_clear()
        .envs(environment)
        .env("HOME", directory.path())
        .env("GH_CONFIG_DIR", directory.path().join("ready"))
        .env("WEGENT_WORKBENCH_HOME", workbench)
        .env("WEGENT_GITHUB_CLI_TEST_CHILD", "1")
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(15), child.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.status.success(),
        "isolated credential-context regression failed: {}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
