// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

const DISCOVERY_SERVER: &str = r#"#!/bin/sh
discovered=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$(dirname "$0")/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/start"'*)
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"new-thread","name":"wework_space","status":"starting"}}'
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"new-thread","name":"optional-server","status":"starting"}}'
      printf '{"id":%s,"result":{"thread":{"id":"new-thread","modelProvider":"~"}}}\n' "$id" ;;
    *'"method":"mcpServerStatus/list"'*)
      discovered=1
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"new-thread","name":"wework_space","status":"ready"}}'
      printf '{"id":%s,"result":{"data":[{"name":"wework_space","runtimeStatus":"connected","tools":{"get_current_context":{}}}]}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      if [ "$discovered" -eq 0 ]; then
        printf '{"id":%s,"error":{"code":-32603,"message":"model turn started before required MCP discovery completed"}}\n' "$id"
      else
        printf '{"id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
        printf '%s\n' '{"method":"turn/completed","params":{"threadId":"new-thread","turn":{"id":"turn-1","status":"completed"}}}'
      fi ;;
    *'"method":"thread/goal/set"'*)
      if [ "$discovered" -eq 0 ]; then
        printf '{"id":%s,"error":{"code":-32603,"message":"goal activated before required MCP discovery completed"}}\n' "$id"
      else
        printf '{"id":%s,"result":{"goal":{"status":"active"}}}\n' "$id"
        printf '%s\n' '{"method":"turn/started","params":{"threadId":"new-thread","turn":{"id":"goal-turn"}}}'
        printf '%s\n' '{"method":"thread/goal/updated","params":{"threadId":"new-thread","goal":{"status":"complete"}}}'
        printf '%s\n' '{"method":"turn/completed","params":{"threadId":"new-thread","turn":{"id":"goal-turn","status":"completed"}}}'
      fi ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#;

fn project_request() -> ExecutionRequest {
    let mut request = ExecutionRequest {
        task_id: "required-space-discovery".into(),
        bot: json!([{"shell_type":"Codex"}]),
        model_config: json!({"model_id":"gpt-test","base_url":"http://synthetic.invalid/v1","api_key":"synthetic-key"}),
        ..ExecutionRequest::default()
    };
    request
        .extra
        .insert("cloudProjectId".into(), json!("project-1"));
    request
}

fn recorded_requests(fixture: &Fixture) -> Vec<Value> {
    fs::read_to_string(fixture._directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn first_turn_waits_for_required_space_discovery_without_waiting_optional_servers() {
    let fixture = Fixture::with_script(DISCOVERY_SERVER);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        fixture
            .client
            .run_turn_with_cancel(project_request(), CodexAppServerTurnOptions::default()),
    )
    .await
    .unwrap();
    fixture.client.restart().await;
    assert!(
        result.is_ok(),
        "First model turn must use the completed native discovery: {result:?}"
    );
    let requests = recorded_requests(&fixture);
    let snapshots: Vec<_> = requests
        .iter()
        .filter(|r| r["method"] == "mcpServerStatus/list")
        .collect();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0]["params"]["serverName"], "wework_space");
    assert_eq!(snapshots[0]["params"]["detail"], "toolsAndAuthOnly");
    let discovery = requests
        .iter()
        .position(|r| r["method"] == "mcpServerStatus/list")
        .unwrap();
    let turn = requests
        .iter()
        .position(|r| r["method"] == "turn/start")
        .unwrap();
    assert!(discovery < turn);
}

#[tokio::test]
async fn initial_goal_waits_for_required_discovery_before_activation() {
    let fixture = Fixture::with_script(DISCOVERY_SERVER);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        fixture.client.run_turn_with_cancel(
            project_request(),
            CodexAppServerTurnOptions {
                initial_thread_goal: Some(json!({"objective":"Complete the project task"})),
                ..CodexAppServerTurnOptions::default()
            },
        ),
    )
    .await
    .unwrap();
    fixture.client.restart().await;
    assert!(result.is_ok(), "Goal activation failed: {result:?}");
    let requests = recorded_requests(&fixture);
    let discovery = requests
        .iter()
        .position(|r| r["method"] == "mcpServerStatus/list")
        .unwrap();
    let activation = requests
        .iter()
        .position(|r| r["method"] == "thread/goal/set")
        .unwrap();
    assert!(discovery < activation);
}

#[tokio::test]
async fn unbound_tasks_start_while_optional_servers_are_unavailable() {
    let script = DISCOVERY_SERVER
        .replace("if [ \"$discovered\" -eq 0 ]; then", "if false; then")
        .replace(
            "\"name\":\"optional-server\",\"status\":\"starting\"",
            "\"name\":\"optional-server\",\"status\":\"failed\"",
        );
    let fixture = Fixture::with_script(&script);
    let mut request = project_request();
    request.extra.remove("cloudProjectId");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        fixture
            .client
            .run_turn_with_cancel(request, CodexAppServerTurnOptions::default()),
    )
    .await
    .unwrap();
    fixture.client.restart().await;
    assert!(
        result.is_ok(),
        "Optional MCP must not block unrelated work: {result:?}"
    );
    assert!(!recorded_requests(&fixture)
        .iter()
        .any(|r| r["method"] == "mcpServerStatus/list"));
}

#[tokio::test]
async fn failed_required_discovery_prevents_turn_dispatch() {
    let script = DISCOVERY_SERVER.replace(
        "\"runtimeStatus\":\"connected\"",
        "\"runtimeStatus\":\"failed\"",
    );
    let fixture = Fixture::with_script(&script);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        fixture
            .client
            .run_turn_with_cancel(project_request(), CodexAppServerTurnOptions::default()),
    )
    .await
    .unwrap();
    fixture.client.restart().await;
    assert_eq!(
        result.unwrap_err(),
        "required project-space capability failed to connect (failed)"
    );
    assert!(!recorded_requests(&fixture)
        .iter()
        .any(|r| r["method"] == "turn/start"));
}
