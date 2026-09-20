// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn codex_stdout_log_streams_before_completion_and_appends_on_retry() {
    let _lock = env_lock().await;
    let _debug = EnvGuard::set("WEGENT_DEBUG_CLAUDE_STDOUT", "1");
    let fixture = Fixture::new("stream");
    let request = fixture.request("debug-stream");
    let path = stdout_path(&request);
    let engine = fixture.engine();
    let (sink, mut events) = event_channel();
    let mut run = engine.run_with_events(request.clone(), sink, builder(&request));
    let mut collected = Vec::new();
    tokio::time::timeout(TIMEOUT, async {
        loop {
            tokio::select! {
                outcome = &mut run => panic!("completed before release: {outcome:?}"),
                event = events.recv() => {
                    collected.push(event.expect("stream must remain open"));
                    if has_streamed_content(&collected) { break; }
                }
            }
        }
    })
    .await
    .unwrap();
    let streamed = read_stdout(&path);
    assert!(streamed
        .iter()
        .any(|line| line["method"] == "item/reasoning/summaryTextDelta"));
    assert!(streamed
        .iter()
        .any(|line| line["result"]["protocolVersion"] == 1));
    assert!(!streamed
        .iter()
        .any(|line| line["method"] == "turn/completed"));
    for line in &streamed {
        chrono::DateTime::parse_from_rfc3339(line["received_at"].as_str().unwrap()).unwrap();
    }
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    assert_completed(tokio::time::timeout(TIMEOUT, run).await.unwrap());
    let completed = read_stdout(&path);
    assert!(completed
        .iter()
        .any(|line| line["method"] == "turn/completed"));

    assert_completed(execute(&engine, request).await.0);
    let retried = read_stdout(&path);
    assert!(retried.len() > completed.len());
    assert_eq!(&retried[..completed.len()], completed.as_slice());
    fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn codex_stdout_log_is_optional_and_write_failure_does_not_break_execution() {
    let _lock = env_lock().await;
    let _debug = EnvGuard::set("WEGENT_DEBUG_CLAUDE_STDOUT", "0");
    let fixture = Fixture::new("stream");
    let request = fixture.request("disabled-debug");
    let path = stdout_path(&request);
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    assert_completed(execute(&fixture.engine(), request.clone()).await.0);
    assert!(!path.exists());

    let _debug = EnvGuard::set("WEGENT_DEBUG_CLAUDE_STDOUT", "1");
    fs::create_dir(&path).unwrap();
    assert_completed(execute(&fixture.engine(), request).await.0);
    fs::remove_dir(path).unwrap();
}

fn stdout_path(request: &ExecutionRequest) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-codex-stdout-{}-{}.jsonl",
        request.task_id, request.subtask_id
    ))
}

fn read_stdout(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
