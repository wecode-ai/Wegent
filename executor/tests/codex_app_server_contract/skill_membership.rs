// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::io::{Cursor, Write};
use std::pin::Pin;
use std::time::Duration;
use tokio::time::timeout;
use wegent_executor::local::capabilities::{
    CapabilityPackageProvider, CapabilitySyncError, CapabilitySyncHandler, GlobalCapabilityStore,
    SkillSyncSpec,
};

struct Fixture {
    client: CodexAppServerClient,
    home: PathBuf,
    _environment: Vec<EnvGuard>,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("codex");
        fs::create_dir_all(&home).unwrap();
        let mut environment = Vec::new();
        for (key, path) in [
            ("HOME", directory.path().join("home")),
            ("WEGENT_EXECUTOR_HOME", directory.path().join("executor")),
            ("WEGENT_WORKBENCH_HOME", directory.path().join("workbench")),
            (
                "WEGENT_CAPABILITIES_HOME",
                directory.path().join("capabilities"),
            ),
            ("WEGENT_CODEX_HOME", home.clone()),
            ("CODEX_HOME", home.clone()),
        ] {
            fs::create_dir_all(&path).unwrap();
            environment.push(EnvGuard::set(key, path.to_str().unwrap()));
        }
        let binary = directory.path().join("codex-fake");
        fs::write(&binary, wegent_executor_test_support::with_codex_bundled_catalog(r#"#!/bin/sh
printf '%s\n' "$$" > "$CODEX_HOME/child.pid"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CODEX_HOME/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"config/batchWrite"'*)
      mode=success
      if [ -f "$CODEX_HOME/reload-mode" ]; then IFS= read -r mode < "$CODEX_HOME/reload-mode"; fi
      case "$mode" in
        failure) printf '{"id":%s,"error":{"code":-32603,"message":"skill reload rejected"}}\n' "$id" ;;
        blocked) ;;
        *) printf '{"id":%s,"result":{"status":"ok"}}\n' "$id" ;;
      esac ;;
  esac
done
"#)).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexAppServerClient::new(binary.to_string_lossy().to_string());
        Self {
            client,
            home,
            _environment: environment,
            _directory: directory,
        }
    }

    fn pid(&self) -> u32 {
        fs::read_to_string(self.home.join("child.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let client = self.client.clone();
        shared_test_runtime().spawn(async move { client.restart().await });
    }
}

fn requests(home: &Path) -> Vec<Value> {
    fs::read_to_string(home.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[derive(Clone)]
struct Package(Vec<u8>);
impl CapabilityPackageProvider for Package {
    fn stage_skill<'a>(
        &'a self,
        _spec: &'a SkillSyncSpec,
        _target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { panic!("Standalone skill staging is not expected") })
    }
    fn download_plugin<'a>(
        &'a self,
        _path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { Ok(self.0.clone()) })
    }
}
fn package() -> Package {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, text) in [
        (
            ".codex-plugin/plugin.json",
            r#"{"name":"hot-skill","skills":"./skills/"}"#,
        ),
        (
            "skills/feature/SKILL.md",
            "---\nname: feature\ndescription: Hot skill\n---\nUse the newly installed skill.",
        ),
    ] {
        archive
            .start_file(name, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(text.as_bytes()).unwrap();
    }
    Package(archive.finish().unwrap().into_inner())
}

fn store(home: &Path) -> GlobalCapabilityStore {
    GlobalCapabilityStore::new(
        home.join("capabilities/manifest-v2.json"),
        home.join("claude/skills"),
    )
    .with_plugins_dir(home.join("claude/plugins"))
    .with_codex_skills_dir(home.join("skills"))
    .with_codex_plugins_dir(home.join("plugins"))
    .with_workbench_root(home.join("workbench"))
}

fn membership_sync(home: &Path) -> (CapabilitySyncHandler<Package>, Value) {
    let provider = package();
    let checksum = format!("sha256:{:x}", Sha256::digest(&provider.0));
    let payload = json!({"scope":"plugins", "mode":"replace", "plugins":[{
        "name":"hot-skill", "marketplace":"wegent", "version":"1.0", "enabled":true,
        "installed_plugin_id":10, "download_path":"/package", "checksum":checksum,
    }]});
    (
        CapabilitySyncHandler::with_package_provider(
            "",
            store(home),
            provider,
            std::sync::Arc::new(wegent_executor::agents::CodexSkillConfigurationReloader),
        ),
        payload,
    )
}

shared_runtime_tests! {
async fn pure_skill_install_and_uninstall_preserve_pid_and_send_one_reload_per_commit() {
    let _lock = env_lock().await;
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let home = fixture.home.as_path();
    let original_pid = fixture.pid();
    let revision = wegent_executor::services::capability_activation::revision();
    let (handler, mut payload) = membership_sync(home);
    for installed in [true, false] {
        if !installed {
            payload["plugins"] = json!([]);
        }
        let response = handler.apply_sync(payload.clone()).await.unwrap();
        assert_eq!(response["success"], true);
        assert_eq!(response["changed"], true);
        assert_eq!(response["requires_restart"], false, "{response}");
        client.ensure_started().await.unwrap();
        assert_eq!(fixture.pid(), original_pid);
        assert_eq!(wegent_executor::services::capability_activation::revision(), revision);
        let config: Value =
            toml_edit::de::from_str(&fs::read_to_string(home.join("config.toml")).unwrap())
                .unwrap();
        assert_eq!(
            config["plugins"].get("hot-skill@wegent").is_some(),
            installed
        );
    }
    let calls = requests(home);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "initialize")
            .count(),
        1
    );
    let reloads = calls
        .iter()
        .filter(|call| call["method"] == "config/batchWrite")
        .collect::<Vec<_>>();
    assert_eq!(reloads.len(), 2);
    assert!(reloads
        .iter()
        .all(|call| call["params"] == json!({"edits":[],"reloadUserConfig":true})));
}

async fn failed_install_reload_does_not_acknowledge_a_live_process_with_old_skills() {
    let _lock = env_lock().await;
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let home = fixture.home.as_path();
    let original_pid = fixture.pid();
    fs::write(home.join("reload-mode"), "failure\n").unwrap();
    let (handler, payload) = membership_sync(home);
    let revision = wegent_executor::services::capability_activation::revision();
    let error = handler.apply_sync(payload).await.unwrap_err();
    assert!(error.to_string().contains("skill reload rejected"));
    assert_eq!(wegent_executor::services::capability_activation::revision(), revision + 1);
    let calls = requests(home);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "config/batchWrite")
            .count(),
        1
    );
    client.ensure_started().await.unwrap();
    assert_ne!(fixture.pid(), original_pid);
}

async fn cancelled_membership_reload_invalidates_the_partially_published_process() {
    let _lock = env_lock().await;
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let original_pid = fixture.pid();
    let home = fixture.home.as_path();
    fs::write(home.join("reload-mode"), "blocked\n").unwrap();
    let (handler, payload) = membership_sync(home);
    let revision = wegent_executor::services::capability_activation::revision();
    let mut sync = Box::pin(handler.apply_sync(payload));
    tokio::select! {
        result = &mut sync => panic!("Blocked reload unexpectedly completed: {result:?}"),
        result = timeout(Duration::from_secs(5), async {
            while !requests(home).iter().any(|call| call["method"] == "config/batchWrite") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }) => result.expect("Fake child did not receive skill membership reload"),
    }
    assert!(store(home).manifest.load().unwrap()["plugins"]["hot-skill@wegent"].is_object());
    drop(sync);
    assert_eq!(wegent_executor::services::capability_activation::revision(), revision + 1);
    client.ensure_started().await.unwrap();
    assert_ne!(fixture.pid(), original_pid);
}
}
