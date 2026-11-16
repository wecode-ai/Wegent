use super::*;
use std::{os::unix::fs::PermissionsExt, path::Path};

const CASE_ENV: &str = "WEGENT_GITHUB_CONTEXT_TEST_CASE";
const FIXTURE_ENV: &str = "WEGENT_GITHUB_CONTEXT_FIXTURE";

async fn wait_for_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut interval = tokio::time::interval(Duration::from_millis(10));
        while !path.exists() {
            interval.tick().await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        let root = path.parent().unwrap();
        panic!(
            "CLI fixture must reach its synchronization barrier: {error:?}; entered={}, calls={}",
            path.exists(),
            root.join("calls").exists()
        )
    });
}

fn publish_sync(root: &Path) -> PathBuf {
    let managed = root.join("home/.wegent/workbench/git-auth/current/gh");
    fs::create_dir_all(&managed).unwrap();
    fs::write(managed.join("active"), "review-user").unwrap();
    fs::write(managed.join("ready"), "synthetic-account").unwrap();
    managed
}

async fn verify_case(case: &str, root: &Path) {
    let native = root.join("native");
    let managed = root.join("home/.wegent/workbench/git-auth/current/gh");
    let result = if case == "initial_health" {
        fs::write(native.join("ready"), "synthetic-native-account").unwrap();
        let mut operation = tokio::spawn(start());
        let entered = root.join("entered");
        tokio::select! {
            _ = wait_for_file(&entered) => {}
            result = &mut operation => panic!("Health finished before its barrier: {result:?}"),
        }
        publish_sync(root);
        fs::write(root.join("release"), "").unwrap();
        operation.await.unwrap().unwrap()
    } else if case == "logout" {
        fs::write(native.join("active"), "review-user").unwrap();
        let operation = tokio::spawn(logout());
        wait_for_file(&root.join("entered")).await;
        publish_sync(root);
        fs::write(root.join("release"), "").unwrap();
        operation.await.unwrap().unwrap()
    } else {
        let started = start().await.unwrap();
        assert_eq!(started["status"], "preparing");
        if case == "login_start" {
            // On this current-thread runtime the spawned login has not run yet.
            publish_sync(root);
        } else if case == "login_verification" {
            wait_for_file(&root.join("entered")).await;
            publish_sync(root);
            fs::write(root.join("release"), "").unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut interval = tokio::time::interval(Duration::from_millis(10));
            loop {
                interval.tick().await;
                let result = super::super::poll(json!({
                    "pluginKey": "github", "connectorSlug": SLUG,
                    "sessionId": started["sessionId"],
                }))
                .await
                .unwrap();
                if matches!(result["status"].as_str(), Some("ok" | "error")) {
                    break result;
                }
            }
        })
        .await
        .unwrap()
    };
    if case == "stable_login" {
        assert_eq!(result["status"], "ok");
        assert!(native.join("ready").exists());
    } else {
        assert_eq!(result["errorCode"], "gh_auth_managed");
        assert!(!managed.join("login-written").exists());
        assert!(!managed.join("logout-written").exists());
        assert_eq!(
            fs::read_to_string(managed.join("active")).unwrap(),
            "review-user"
        );
    }
    if case == "logout" {
        assert!(native.join("logout-written").exists());
        assert!(!native.join("active").exists());
    } else if case == "initial_health" {
        assert!(!native.join("login-written").exists());
    } else {
        assert!(native.join("login-written").exists());
    }
    let calls = fs::read_to_string(root.join("calls")).unwrap();
    for call in calls.lines() {
        assert_eq!(call.split_once('|').unwrap().1, native.to_str().unwrap());
    }
}

#[tokio::test]
async fn authentication_operations_keep_their_initial_profile_during_sync() {
    if let Ok(case) = env::var(CASE_ENV) {
        verify_case(&case, Path::new(&env::var(FIXTURE_ENV).unwrap())).await;
        return;
    }
    for case in [
        "stable_login",
        "initial_health",
        "login_start",
        "login_verification",
        "logout",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(root.join("native")).unwrap();
        let gh = bin.join("gh");
        fs::write(&gh, r#"#!/bin/sh
root=$WEGENT_GITHUB_CONTEXT_FIXTURE
printf '%s|%s\n' "$1 $2" "$GH_CONFIG_DIR" >> "$root/calls"
barrier() {
  : > "$root/entered"
  while [ ! -f "$root/release" ]; do sleep 0.01; done
}
case "$1 $2" in
  'api user')
    if [ "$WEGENT_GITHUB_CONTEXT_TEST_CASE" = initial_health ]; then barrier; fi
    test -f "$GH_CONFIG_DIR/ready" || exit 4 ;;
  'config get')
    if [ ! -f "$GH_CONFIG_DIR/active" ]; then
      printf 'could not find key "user"\n' >&2; exit 1
    fi
    if [ "$WEGENT_GITHUB_CONTEXT_TEST_CASE" = logout ] && [ ! -f "$root/entered" ]; then barrier; fi
    printf 'review-user\n'
    ;;
  'auth logout')
    rm "$GH_CONFIG_DIR/active"
    : > "$GH_CONFIG_DIR/logout-written"
    ;;
  'auth login')
    printf '! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n' >&2
    if [ "$WEGENT_GITHUB_CONTEXT_TEST_CASE" = login_verification ]; then
      barrier
    else
      : > "$GH_CONFIG_DIR/ready"
    fi
    : > "$GH_CONFIG_DIR/login-written"
    ;;
  *) exit 99 ;;
esac
"#).unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(env::current_exe().unwrap());
        child
            .args(["--exact", "runtime_work::local_connector_auth::github_cli::context_tests::authentication_operations_keep_their_initial_profile_during_sync"])
            .env_clear()
            .env(CASE_ENV, case)
            .env(FIXTURE_ENV, root)
            .env("HOME", root.join("home"))
            .env("GH_CONFIG_DIR", root.join("native"))
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("WEGENT_WORKBENCH_HOME", root.join("home/.wegent/workbench"))
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(15), child.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{case}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
