// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn concurrent_work_coalesces_mcp_reload_and_later_work_can_retry() {
    let fixture = Fixture::with_script(
        r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$(dirname "$0")/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"test/fail-mcp"'*)
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"one","name":"calendar","status":"ready"}}'
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"two","name":"mail","status":"failed"}}'
      result='{}' ;;
    *'"method":"mcpServerStatus/list"'*)
      case "$line" in
        *'"serverName":"calendar"'*) result='{"data":[{"name":"calendar","runtimeStatus":"failed"}]}' ;;
        *) result='{"data":[{"name":"mail","runtimeStatus":"failed"}]}' ;;
      esac ;;
    *'"method":"config/mcpServer/reload"'*)
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"one","name":"calendar","status":"starting"}}'
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"one","name":"calendar","status":"failed"}}'
      result='{}' ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#,
    );
    fixture
        .client
        .request("test/fail-mcp", json!({}))
        .await
        .unwrap();
    // Reply prediction may resume the source thread before the next work turn.
    fixture
        .client
        .request("thread/resume", json!({"threadId":"one"}))
        .await
        .unwrap();
    let passive = fs::read_to_string(fixture._directory.path().join("requests.jsonl")).unwrap();
    assert!(!passive.contains("mcpServerStatus/list"));
    assert!(!passive.contains("config/mcpServer/reload"));
    let (one, two) = tokio::join!(fixture.resume_work("one"), fixture.resume_work("two"),);
    one.unwrap();
    two.unwrap();
    fixture.resume_work("one").await.unwrap();
    let requests: Vec<Value> = fs::read_to_string(fixture._directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "config/mcpServer/reload")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "initialize")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "thread/resume")
            .count(),
        4
    );
    assert!(!requests
        .iter()
        .any(|r| r["method"] == "turn/start" || r["method"] == "mcpServer/tool/call"));
    let reload = requests
        .iter()
        .position(|r| r["method"] == "config/mcpServer/reload")
        .unwrap();
    let resume = requests
        .iter()
        .enumerate()
        .filter(|(_, r)| r["method"] == "thread/resume" && r["params"]["threadId"] == "one")
        .nth(1)
        .map(|(index, _)| index)
        .unwrap();
    assert!(reload < resume);
    fixture.client.restart().await;
}

#[tokio::test]
async fn authentication_required_mcp_does_not_trigger_native_reload() {
    let fixture = Fixture::with_script(
        r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$(dirname "$0")/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"test/fail-mcp"'*)
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"one","name":"mail","status":"failed"}}'
      result='{}' ;;
    *'"method":"mcpServerStatus/list"'*) result='{"data":[{"name":"mail","runtimeStatus":"authenticationRequired"}]}' ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#,
    );
    fixture
        .client
        .request("test/fail-mcp", json!({}))
        .await
        .unwrap();
    for _ in 0..2 {
        fixture.resume_work("one").await.unwrap();
    }
    let requests: Vec<Value> = fs::read_to_string(fixture._directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "mcpServerStatus/list")
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|r| r["method"] == "config/mcpServer/reload"));
    fixture.client.restart().await;
}

#[tokio::test]
async fn failed_mcp_status_query_preserves_the_next_work_admission() {
    let fixture = Fixture::with_script(
        r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$(dirname "$0")/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"test/fail-mcp"'*)
      printf '%s\n' '{"method":"mcpServer/startupStatus/updated","params":{"threadId":"one","name":"calendar","status":"failed"}}'
      result='{}' ;;
    *'"method":"mcpServerStatus/list"'*)
      marker="$(dirname "$0")/status-attempted"
      if [ ! -f "$marker" ]; then
        touch "$marker"
        printf '{"id":%s,"error":{"code":-32000,"message":"status unavailable"}}\n' "$id"
        continue
      fi
      result='{"data":[{"name":"calendar","runtimeStatus":"failed"}]}' ;;
    *) result='{}' ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#,
    );
    fixture
        .client
        .request("test/fail-mcp", json!({}))
        .await
        .unwrap();
    assert!(fixture
        .resume_work("one")
        .await
        .unwrap_err()
        .contains("status unavailable"));
    fixture.resume_work("one").await.unwrap();
    let requests: Vec<Value> = fs::read_to_string(fixture._directory.path().join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "config/mcpServer/reload")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "thread/resume")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "initialize")
            .count(),
        1
    );
    fixture.client.restart().await;
}
