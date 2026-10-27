// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    binary: String,
    directory: tempfile::TempDir,
    _environment: LaunchEnvironment,
}

impl Fixture {
    fn new() -> Self {
        let environment = LaunchEnvironment::new();
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("codex");
        fs::write(
            &binary,
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CODEX_HOME/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"skills/config/write"'*)
      printf '%s\n' written > "$CODEX_HOME/skill-written"
      printf '{"id":%s,"result":{"effectiveEnabled":false}}\n' "$id" ;;
    *'"method":"config/batchWrite"'*)
      mode=success
      if [ -f "$CODEX_HOME/reload-mode" ]; then
        IFS= read -r mode < "$CODEX_HOME/reload-mode"
      fi
      case "$mode" in
        failure) printf '{"id":%s,"error":{"code":-32603,"message":"skill reload rejected"}}\n' "$id" ;;
        blocked) ;;
        *) printf '{"id":%s,"result":{"status":"ok"}}\n' "$id" ;;
      esac ;;
  esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            binary: resolve_codex_binary(&binary.to_string_lossy()),
            directory,
            _environment: environment,
        }
    }

    fn client(&self, name: &str) -> CodexAppServerClient {
        CodexAppServerClient::isolated_for_test(&self.binary, self.directory.path().join(name))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let states = {
            let mut registry = shared_codex_app_server_states().lock().unwrap();
            let keys = registry
                .keys()
                .filter(|(binary, _)| binary == &self.binary)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| registry.remove(&key))
                .collect::<Vec<_>>()
        };
        for state in states {
            state.try_lock().unwrap().process.take();
        }
    }
}

fn requests(home: &Path) -> Vec<Value> {
    let content = match fs::read_to_string(home.join("requests.jsonl")) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => panic!("read fake child requests: {error}"),
    };
    content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn pid(client: &CodexAppServerClient) -> u32 {
    client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .child
        .id()
        .unwrap()
}

#[tokio::test]
async fn skill_write_and_reload_preserve_the_process_and_capability_revision() {
    let fixture = Fixture::new();
    let client = fixture.client("updated");
    client.ensure_started().await.unwrap();
    let original_pid = pid(&client).await;
    let activation = crate::services::capability_activation::activate().await;
    let revision = crate::services::capability_activation::revision();

    let response = client
        .write_skill_configuration(json!({"name":"test-skill","enabled":false}), &activation)
        .await
        .unwrap();

    assert_eq!(response["effectiveEnabled"], false);
    assert_eq!(crate::services::capability_activation::revision(), revision);
    assert_eq!(pid(&client).await, original_pid);
    let calls = requests(client.home.as_deref().unwrap());
    let update = calls
        .iter()
        .position(|call| call["method"] == "skills/config/write")
        .unwrap();
    assert_eq!(calls[update + 1]["method"], "config/batchWrite");
    assert_eq!(calls[update + 1]["params"]["reloadUserConfig"], true);
}

#[tokio::test]
async fn failed_reload_invalidates_the_already_written_skill_configuration() {
    let fixture = Fixture::new();
    let client = fixture.client("failed");
    client.ensure_started().await.unwrap();
    let home = client.home.as_deref().unwrap();
    fs::write(home.join("reload-mode"), "failure\n").unwrap();
    let activation = crate::services::capability_activation::activate().await;
    let revision = crate::services::capability_activation::revision();

    let result = client
        .write_skill_configuration(json!({"name":"test-skill","enabled":false}), &activation)
        .await;

    assert!(result.unwrap_err().contains("skill reload rejected"));
    assert!(home.join("skill-written").is_file());
    assert_eq!(
        crate::services::capability_activation::revision(),
        revision + 1
    );
}

#[tokio::test]
async fn cancelled_reload_invalidates_the_already_written_skill_configuration() {
    let fixture = Fixture::new();
    let client = fixture.client("cancelled");
    client.ensure_started().await.unwrap();
    let home = client.home.as_deref().unwrap();
    fs::write(home.join("reload-mode"), "blocked\n").unwrap();
    let activation = crate::services::capability_activation::activate().await;
    let revision = crate::services::capability_activation::revision();
    let mut update = Box::pin(
        client.write_skill_configuration(json!({"name":"test-skill","enabled":false}), &activation),
    );
    tokio::select! {
        result = &mut update => panic!("blocked reload unexpectedly completed: {result:?}"),
        result = timeout(Duration::from_secs(5), async {
            while !requests(home).iter().any(|call| call["method"] == "config/batchWrite") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }) => result.expect("fake child did not receive skill reload"),
    }
    assert!(requests(home)
        .iter()
        .any(|call| call["method"] == "config/batchWrite"));
    assert!(home.join("skill-written").is_file());

    drop(update);

    assert_eq!(
        crate::services::capability_activation::revision(),
        revision + 1
    );
}

#[tokio::test]
async fn reload_only_visits_running_processes_in_the_matching_home() {
    let fixture = Fixture::new();
    let matching = CodexAppServerClient::new(&fixture.binary);
    let unrelated = matching
        .for_home(fixture.directory.path().join("unrelated"))
        .unwrap();
    let cold = matching
        .for_home(fixture.directory.path().join("cold"))
        .unwrap();
    matching.ensure_started().await.unwrap();
    unrelated.ensure_started().await.unwrap();
    let original_pid = pid(&matching).await;
    let unrelated_pid = pid(&unrelated).await;
    // Finish a round trip so startup notifications are consumed before comparing.
    unrelated.reload_user_skills().await.unwrap();
    let unrelated_before = requests(unrelated.home.as_deref().unwrap());
    let _activation = crate::services::capability_activation::activate().await;

    assert_eq!(
        reload_skill_configuration(&wework_codex_home())
            .await
            .unwrap(),
        1
    );
    assert_eq!(pid(&matching).await, original_pid);
    assert!(requests(&wework_codex_home())
        .iter()
        .any(|call| call["method"] == "config/batchWrite"));
    assert_eq!(pid(&unrelated).await, unrelated_pid);
    assert_eq!(
        requests(unrelated.home.as_deref().unwrap()),
        unrelated_before
    );
    assert_eq!(
        reload_skill_configuration(cold.home.as_deref().unwrap())
            .await
            .unwrap(),
        0
    );
    assert!(cold.state.lock().await.process.is_none());
    assert!(requests(cold.home.as_deref().unwrap()).is_empty());
}
