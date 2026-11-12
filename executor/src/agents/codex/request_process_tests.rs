// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    client: CodexAppServerClient,
    _directory: tempfile::TempDir,
    _environment: LaunchEnvironment,
}

impl Fixture {
    fn new() -> Self {
        Self::with_script(
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/goal/set"'*|*'"method":"thread/goal/get"'*)
      printf '{"id":%s,"result":{"goal":{"status":"active"},"pid":%s}}\n' "$id" "$$" ;;
    *'"method":"thread/goal/clear"'*)
      printf '{"id":%s,"result":{"goal":null,"pid":%s}}\n' "$id" "$$" ;;
    *) printf '{"id":%s,"result":{"turnId":"turn-2","status":"unsubscribed","pid":%s}}\n' "$id" "$$" ;;
  esac
done
"#,
        )
    }

    fn with_script(script: &str) -> Self {
        let environment = LaunchEnvironment::new();
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("codex");
        fs::write(&binary, script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexAppServerClient::isolated_for_test(
            binary.to_str().unwrap(),
            directory.path().join("native-home"),
        );
        Self {
            client,
            _directory: directory,
            _environment: environment,
        }
    }
}

#[tokio::test]
async fn native_close_notification_does_not_admit_a_resume_before_teardown_finishes() {
    let fixture = Fixture::with_script(
        r#"#!/bin/sh
attempts=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$(dirname "$0")/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/resume"'*)
      attempts=$((attempts + 1))
      if [ "$attempts" -eq 1 ]; then
        printf '%s\n' '{"method":"thread/closed","params":{"threadId":"thread-1"}}'
      fi
      if [ "$attempts" -lt 3 ]; then
        printf '{"id":%s,"error":{"code":-32600,"message":"thread thread-1 is closing; retry thread/resume after the thread is closed"}}\n' "$id"
      else
        printf '{"id":%s,"result":{"thread":{"id":"thread-1"},"pid":%s}}\n' "$id" "$$"
      fi ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#,
    );
    let params = json!({
        "threadId":"thread-1",
        "permissions":":read-only",
        "approvalsReviewer":"user",
        "config":{"mcp_servers.test.http_headers.context":"current-batch"}
    });
    let result = fixture
        .client
        .request_for_launch_config(
            "thread/resume",
            params.clone(),
            &CodexLaunchConfig::default(),
        )
        .await
        .unwrap();
    assert_eq!(result["thread"]["id"], "thread-1");
    assert_eq!(result["pid"], pid(&fixture.client).await);
    let requests: Vec<Value> = fs::read_to_string(fixture._directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let resumes: Vec<_> = requests
        .iter()
        .filter(|request| request["method"] == "thread/resume")
        .collect();
    assert_eq!(resumes.len(), 3);
    assert!(resumes.iter().all(|request| request["params"] == params));
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "initialize")
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|request| request["method"] == "turn/start"));
    fixture.client.restart().await;
}

impl Drop for Fixture {
    fn drop(&mut self) {
        shared_codex_app_server_states()
            .lock()
            .unwrap()
            .remove(&(self.client.binary.clone(), self.client.home.clone()));
        self.client.state.try_lock().unwrap().process.take();
    }
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
async fn existing_control_requests_keep_the_original_process_after_capability_change() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    let _activation = crate::services::capability_activation::activate().await;
    client.ensure_started().await.unwrap();
    let original_pid = pid(client).await;
    let environment = client.state.lock().await.process_environment.clone();
    assert!(client.state.lock().await.active_threads.is_empty());

    // Publish after startup to reproduce the native-continuation control race.
    crate::services::capability_activation::mark_changed();
    let revision = crate::services::capability_activation::revision().to_string();
    assert_ne!(environment["WEGENT_CAPABILITY_REVISION"], revision);

    assert_eq!(
        client
            .steer_turn("thread-1", "turn-2", None, json!([]), None)
            .await
            .unwrap(),
        "turn-2"
    );
    interrupt_shared_turn(client, "thread-1", "turn-2")
        .await
        .unwrap();
    assert_eq!(
        client.request_thread_unsubscribe("thread-1").await.unwrap()["pid"],
        original_pid
    );
    client.reload_user_skills().await.unwrap();
    assert_eq!(pid(client).await, original_pid);
    assert_eq!(client.state.lock().await.process_environment, environment);

    let refreshed = client
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_ne!(pid(client).await, original_pid);
    assert_eq!(refreshed["pid"], pid(client).await);
    assert_eq!(
        client.state.lock().await.process_environment["WEGENT_CAPABILITY_REVISION"],
        revision
    );
    client.restart().await;
}

#[tokio::test]
async fn existing_control_request_does_not_start_a_missing_process() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    let result = client
        .steer_turn("thread-1", "turn-2", None, json!([]), None)
        .await;
    assert_eq!(result.unwrap_err(), "codex app-server is not running");
    assert!(client.state.lock().await.process.is_none());
}

#[tokio::test]
async fn existing_control_request_cleans_up_an_exited_process_without_replacement() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    {
        let mut state = client.state.lock().await;
        let child = &mut state.process.as_mut().unwrap().child;
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
    let result = client
        .steer_turn("thread-1", "turn-2", None, json!([]), None)
        .await;
    assert_eq!(result.unwrap_err(), "codex app-server is not running");
    assert!(client.state.lock().await.process.is_none());
}

#[tokio::test]
async fn native_continuation_protects_idle_paths_after_local_request_ownership_ends() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    let _activation = crate::services::capability_activation::activate().await;
    client.ensure_started().await.unwrap();
    let original_pid = pid(client).await;
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    client.run_thread_action("thread-1", async {
        hub.send(json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-2"}}})).await;
        assert_eq!(client.state.lock().await.active_threads_snapshot().get("thread-1"), Some(&1));
    }).await;
    assert!(client.state.lock().await.active_threads.is_empty());
    crate::services::capability_activation::mark_changed();

    client.ensure_started().await.unwrap();
    assert_eq!(
        client
            .request("thread/read", json!({"threadId":"thread-1"}))
            .await
            .unwrap()["pid"],
        original_pid
    );
    client
        .mutate_thread_goal("thread/goal/clear", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_eq!(client.restart_if_idle().await, Err((1, 0)));
    let mutation = client
        .mutate_auth_if_idle(|| panic!("A running native turn must block configuration mutation"))
        .await;
    assert_eq!(
        mutation,
        Err(CodexIdleMutationError::Busy {
            active_turn_count: 1,
            pending_request_count: 0
        })
    );
    client
        .configure_runtime_proxy(Some("http://127.0.0.1:7890"))
        .await
        .unwrap();
    let generation = client.state.lock().await.thread_generations["thread-1"];
    assert!(!client
        .request_thread_unsubscribe_if_idle("thread-1", generation)
        .await
        .unwrap());
    assert_eq!(pid(client).await, original_pid);

    hub.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","status":"completed"}}})).await;
    client
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_ne!(pid(client).await, original_pid);
    client.restart().await;
}

#[tokio::test]
async fn native_completion_wakes_a_resume_waiting_for_thread_admission() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    hub.send(
        json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-2"}}}),
    )
    .await;
    client
        .state
        .lock()
        .await
        .thread_context_configurations
        .insert("thread-1".into(), Map::new());
    let plan = CodexThreadPlan {
        start: CodexThreadStart::Request {
            operation: "thread/resume",
            params: json!({"threadId":"thread-1"}),
        },
        resume_requested: true,
        fork_requested: false,
    };
    let request = ExecutionRequest::default();
    let launch = CodexLaunchConfig::default();
    let mut admission = Box::pin(client.prepare_thread_admission(&plan, &request, &launch));
    assert!(futures_util::poll!(&mut admission).is_pending());
    hub.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","status":"completed"}}})).await;
    let admitted = timeout(Duration::from_secs(1), admission)
        .await
        .unwrap()
        .unwrap();
    drop(admitted);
    client.finish_thread_activity("thread-1", false).await;
    client.restart().await;
}

#[tokio::test]
async fn an_active_goal_without_a_live_turn_does_not_block_resume_admission() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    hub.send(json!({"method":"thread/goal/updated","params":{
        "threadId":"thread-1","turnId":null,"goal":{"status":"active"}
    }}))
    .await;
    client
        .state
        .lock()
        .await
        .thread_context_configurations
        .insert("thread-1".into(), Map::new());
    assert_eq!(client.restart_if_idle().await, Err((1, 0)));

    let plan = CodexThreadPlan {
        start: CodexThreadStart::Request {
            operation: "thread/resume",
            params: json!({"threadId":"thread-1"}),
        },
        resume_requested: true,
        fork_requested: false,
    };
    let request = ExecutionRequest::default();
    let launch = CodexLaunchConfig::default();
    let admitted = timeout(
        Duration::from_secs(1),
        client.prepare_thread_admission(&plan, &request, &launch),
    )
    .await;
    client.restart().await;
    drop(
        admitted
            .expect("An active Goal must not wait for its own recovery to start")
            .unwrap(),
    );
}

#[tokio::test]
async fn goal_resume_waits_for_local_and_native_turns_but_not_continuation_eligibility() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    let plan = CodexThreadPlan {
        start: CodexThreadStart::Request {
            operation: "thread/resume",
            params: json!({"threadId":"thread-1"}),
        },
        resume_requested: true,
        fork_requested: false,
    };
    let request = ExecutionRequest::default();
    let launch = CodexLaunchConfig::default();
    for local_owner in [true, false] {
        hub.send(json!({"method":"thread/goal/updated","params":{
            "threadId":"thread-1","goal":{"status":"active"}
        }}))
        .await;
        client
            .state
            .lock()
            .await
            .thread_context_configurations
            .insert("thread-1".into(), Map::new());
        if local_owner {
            client.mark_thread_active("thread-1").await;
        } else {
            hub.send(json!({"method":"turn/started","params":{
                "threadId":"thread-1","turn":{"id":"live","status":"inProgress"}
            }}))
            .await;
        }
        let mut admission = Box::pin(client.prepare_thread_admission(&plan, &request, &launch));
        assert!(futures_util::poll!(&mut admission).is_pending());
        if local_owner {
            client.finish_thread_activity("thread-1", true).await;
        } else {
            hub.send(json!({"method":"turn/completed","params":{
                "threadId":"thread-1","turn":{"id":"live","status":"completed"}
            }}))
            .await;
        }
        let admitted = timeout(Duration::from_secs(1), admission).await;
        if admitted.is_err() {
            client.restart().await;
        }
        drop(
            admitted
                .expect("Goal eligibility cannot retain a completed turn's admission")
                .unwrap(),
        );
        client.finish_thread_activity("thread-1", true).await;
        assert_eq!(client.restart_if_idle().await, Err((1, 0)));
    }
    client.restart().await;
}

#[tokio::test]
async fn active_goal_resume_still_waits_for_configuration_teardown() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    client.ensure_started().await.unwrap();
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    hub.send(json!({"method":"thread/goal/updated","params":{
        "threadId":"thread-1","goal":{"status":"active"}
    }}))
    .await;
    let original_pid = pid(client).await;
    let plan = CodexThreadPlan {
        start: CodexThreadStart::Request {
            operation: "thread/resume",
            params: json!({"threadId":"thread-1","config":{
                "mcp_servers.test.http_headers.context":"new-authority"
            }}),
        },
        resume_requested: true,
        fork_requested: false,
    };
    let request = ExecutionRequest::default();
    let launch = CodexLaunchConfig::default();
    let mut admission = Box::pin(client.prepare_thread_admission(&plan, &request, &launch));
    assert!(futures_util::poll!(&mut admission).is_pending());
    // The single native response reader processes unsubscribe before this read.
    client
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert!(
        futures_util::poll!(&mut admission).is_pending(),
        "Goal recovery must not overtake native MCP teardown"
    );
    hub.send(json!({"method":"thread/closed","params":{"threadId":"thread-1"}}))
        .await;
    let admitted = timeout(Duration::from_secs(1), admission).await;
    if admitted.is_err() {
        client.restart().await;
    }
    drop(
        admitted
            .expect("Native close must admit Goal recovery without clearing its metadata")
            .unwrap(),
    );
    assert_eq!(pid(client).await, original_pid);
    assert_eq!(
        client
            .request("thread/goal/get", json!({"threadId":"thread-1"}))
            .await
            .unwrap()["goal"]["status"],
        "active"
    );
    client.finish_thread_activity("thread-1", false).await;
    client.restart().await;
}

#[tokio::test]
async fn reading_a_persisted_goal_does_not_block_its_recovery_admission() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    let response = client
        .request("thread/goal/get", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_eq!(response["goal"]["status"], "active");
    assert!(client.state.lock().await.active_threads.is_empty());
    client
        .state
        .lock()
        .await
        .thread_context_configurations
        .insert("thread-1".into(), Map::new());
    let plan = CodexThreadPlan {
        start: CodexThreadStart::Request {
            operation: "thread/resume",
            params: json!({"threadId":"thread-1"}),
        },
        resume_requested: true,
        fork_requested: false,
    };
    let request = ExecutionRequest::default();
    let launch = CodexLaunchConfig::default();
    let admitted = timeout(
        Duration::from_secs(1),
        client.prepare_thread_admission(&plan, &request, &launch),
    )
    .await
    .expect("A persisted active Goal must be admitted before native work starts")
    .unwrap();
    let resumed = client
        .request("thread/resume", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_eq!(resumed["pid"], response["pid"]);
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    hub.send(
        json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"recovered"}}}),
    )
    .await;
    drop(admitted);
    client.finish_thread_activity("thread-1", false).await;
    hub.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"recovered","status":"completed"}}})).await;
    assert_eq!(client.restart_if_idle().await, Err((1, 0)));
    client
        .mutate_thread_goal("thread/goal/clear", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert!(client
        .state
        .lock()
        .await
        .active_threads_snapshot()
        .is_empty());
    client.restart().await;
}

#[tokio::test]
async fn native_rpc_responses_protect_the_gap_before_turn_and_goal_notifications() {
    let fixture = Fixture::new();
    let client = &fixture.client;
    let _activation = crate::services::capability_activation::activate().await;
    client
        .request("turn/start", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    let original_pid = pid(client).await;
    let hub = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .clone();
    assert_eq!(client.restart_if_idle().await, Err((1, 0)));
    crate::services::capability_activation::mark_changed();
    client.ensure_started().await.unwrap();
    assert_eq!(pid(client).await, original_pid);
    client
        .mutate_thread_goal("thread/goal/set", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    hub.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","status":"completed"}}})).await;
    assert_eq!(client.restart_if_idle().await, Err((1, 0)));
    client
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_eq!(pid(client).await, original_pid);
    client
        .mutate_thread_goal("thread/goal/clear", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    client
        .request("thread/read", json!({"threadId":"thread-1"}))
        .await
        .unwrap();
    assert_ne!(pid(client).await, original_pid);
    client.restart().await;
}
