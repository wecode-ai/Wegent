// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::{io::Cursor, sync::Arc};
use tokio::sync::Semaphore;

fn records(payloads: impl IntoIterator<Item = Value>) -> Vec<u8> {
    payloads
        .into_iter()
        .map(|payload| format!("{}\n", json!({"type":"event_msg","payload":payload})))
        .collect::<String>()
        .into_bytes()
}

fn page(
    records: &[u8],
    cursor: Option<&str>,
    direction: CodexTranscriptDirection,
) -> CodexTranscriptPage {
    let cursor = cursor.map(|cursor| {
        serde_json::from_str::<LegacySearchCursor>(cursor.strip_prefix(PAGE_CURSOR_PREFIX).unwrap())
            .unwrap()
    });
    read_page(
        Cursor::new(records),
        cursor.as_ref(),
        direction,
        5,
        &Cancellation::new(),
    )
    .unwrap()
}

#[test]
fn a_long_legacy_turn_pages_losslessly_with_synthetic_ids_and_completion_metadata() {
    let bytes = records(
        [
            json!({"type":"task_started","turn_id":"legacy"}),
            json!({"type":"user_message","message":"question","client_id":"request-1"}),
        ]
        .into_iter()
        .chain((0..230).map(|index| {
            json!({"type":"agent_message","message":format!("完整正文🙂-{index}"),"phase":"commentary"})
        }))
        .chain([json!({"type":"task_complete","turn_id":"legacy","completed_at":123})]),
    );
    let mut cursor = None;
    let mut ids = HashSet::new();
    let mut pages = 0;
    loop {
        let page = page(
            &bytes,
            cursor.as_deref(),
            CodexTranscriptDirection::Descending,
        );
        let turn = &page.thread["turns"][0];
        assert_eq!(turn["status"], "completed");
        assert_eq!(turn["completedAt"], 123);
        assert_eq!(turn["timelineCompleted"], true);
        let items = turn["items"].as_array().unwrap();
        assert!(items.len() <= CONTEXT_PAGE_SIZE);
        for item in items {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
            if item["type"] == "userMessage" {
                assert_eq!(item["clientId"], "request-1");
                assert_eq!(item["content"][0]["text"], "question");
            } else {
                assert!(item["text"].as_str().unwrap().starts_with("完整正文🙂-"));
                assert_eq!(item["phase"], "commentary");
            }
        }
        pages += 1;
        cursor = page.before_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(ids.len(), 231);
    assert!(ids.contains("item-1"));
    assert!(ids.contains("item-231"));
}

#[test]
fn forward_pages_and_byte_budgets_retain_an_indivisible_large_body() {
    let text = "文".repeat(PAGE_BYTES / 2);
    let bytes = records([
        json!({"type":"task_started","turn_id":"legacy"}),
        json!({"type":"user_message","message":"older"}),
        json!({"type":"agent_message","message":text}),
        json!({"type":"agent_message","message":"newer"}),
        json!({"type":"task_complete","turn_id":"legacy"}),
    ]);
    for direction in [
        CodexTranscriptDirection::Ascending,
        CodexTranscriptDirection::Descending,
    ] {
        let first = page(&bytes, None, direction);
        assert_eq!(
            first.thread["turns"][0]["items"].as_array().unwrap().len(),
            1
        );
        let cursor = if direction == CodexTranscriptDirection::Ascending {
            first.after_cursor
        } else {
            first.before_cursor
        };
        let middle = page(&bytes, cursor.as_deref(), direction);
        assert_eq!(
            middle.thread["turns"][0]["items"].as_array().unwrap().len(),
            1
        );
        assert_eq!(middle.thread["turns"][0]["items"][0]["text"], text);
        let cursor = if direction == CodexTranscriptDirection::Ascending {
            middle.after_cursor
        } else {
            middle.before_cursor
        };
        let last = page(&bytes, cursor.as_deref(), direction);
        assert_eq!(
            last.thread["turns"][0]["items"].as_array().unwrap().len(),
            1
        );
        assert!(if direction == CodexTranscriptDirection::Ascending {
            last.after_cursor.is_none()
        } else {
            last.before_cursor.is_none()
        });
    }
}

#[test]
fn legacy_terminal_status_and_rollback_follow_the_shared_projection() {
    let bytes = records([
        json!({"type":"task_started","turn_id":"failed"}),
        json!({"type":"user_message","message":"failed question"}),
        json!({"type":"agent_message","message":"failed answer"}),
        json!({"type":"task_complete","turn_id":"failed","error":{"message":"provider failed"}}),
        json!({"type":"task_started","turn_id":"removed"}),
        json!({"type":"user_message","message":"rolled back"}),
        json!({"type":"thread_rolled_back","num_turns":1}),
        json!({"type":"task_started","turn_id":"interrupted"}),
        json!({"type":"user_message","message":"interrupted question"}),
        json!({"type":"turn_aborted","turn_id":"interrupted","completed_at":456}),
    ]);
    let page = page(&bytes, None, CodexTranscriptDirection::Descending);
    let turns = page.thread["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["id"], "failed");
    assert_eq!(turns[0]["status"], "failed");
    assert_eq!(turns[0]["error"]["message"], "provider failed");
    assert_eq!(turns[1]["id"], "interrupted");
    assert_eq!(turns[1]["status"], "interrupted");
    assert_eq!(turns[1]["completedAt"], 456);
    assert_eq!(turns[1]["items"][0]["id"], "item-3");
    assert!(!serde_json::to_string(&page.thread)
        .unwrap()
        .contains("rolled back"));
}

#[test]
fn initial_pages_follow_a_rollback_while_a_removed_cursor_is_rejected() {
    let original = [
        json!({"type":"task_started","turn_id":"old"}),
        json!({"type":"user_message","message":"old question"}),
        json!({"type":"agent_message","message":"old answer"}),
        json!({"type":"task_complete","turn_id":"old"}),
    ];
    let first = page(
        &records(original.clone()),
        None,
        CodexTranscriptDirection::Descending,
    );
    let anchor = LegacySearchCursor {
        turn_id: "old".into(),
        item_id: "item-1".into(),
        byte_offset: first.thread["turns"][0]["items"][0]["position"]
            .as_u64()
            .unwrap(),
        reply_source_turn_id: None,
    };
    let replaced = records(original.into_iter().chain([
        json!({"type":"thread_rolled_back","num_turns":1}),
        json!({"type":"task_started","turn_id":"new"}),
        json!({"type":"user_message","message":"new question"}),
        json!({"type":"task_complete","turn_id":"new"}),
    ]));
    for direction in [
        CodexTranscriptDirection::Ascending,
        CodexTranscriptDirection::Descending,
    ] {
        let page = page(&replaced, None, direction);
        assert_eq!(page.thread["turns"].as_array().unwrap().len(), 1);
        assert_eq!(page.thread["turns"][0]["id"], "new");
        assert_eq!(
            page.thread["turns"][0]["items"][0]["content"][0]["text"],
            "new question"
        );
        let result = read_page(
            Cursor::new(&replaced),
            Some(&anchor),
            direction,
            5,
            &Cancellation::new(),
        );
        assert!(matches!(result, Err(error) if error.code == "codex_error"));
    }
}

struct HeldReader {
    reader: Cursor<Vec<u8>>,
    entered: Option<tokio::sync::oneshot::Sender<()>>,
    release: std::sync::mpsc::Receiver<()>,
}

impl std::io::Read for HeldReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.reader.read(buffer)
    }
}

impl BufRead for HeldReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
            self.release.recv().unwrap();
        }
        self.reader.fill_buf()
    }

    fn consume(&mut self, amount: usize) {
        self.reader.consume(amount);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_a_legacy_scan_stops_the_worker_before_processing_the_next_record() {
    let workers = Arc::new(Semaphore::new(1));
    let (entered, entered_rx) = tokio::sync::oneshot::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let (finished, finished_rx) = tokio::sync::oneshot::channel();
    let scope_workers = workers.clone();
    let task = tokio::spawn(async move {
        transcript_work::with_test_workers(
            scope_workers,
            transcript_work::run(move |cancellation| {
                let result = read_page(
                    HeldReader {
                        reader: Cursor::new(records([
                            json!({"type":"user_message","message":"question"}),
                        ])),
                        entered: Some(entered),
                        release: release_rx,
                    },
                    None,
                    CodexTranscriptDirection::Descending,
                    5,
                    cancellation,
                );
                finished
                    .send(result.as_ref().err().map(|error| error.code.clone()))
                    .unwrap();
                result
            }),
        )
        .await
    });
    entered_rx.await.unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_eq!(workers.available_permits(), 0);
    release.send(()).unwrap();
    assert_eq!(
        finished_rx.await.unwrap().as_deref(),
        Some("request_cancelled")
    );
    let permit = workers.acquire_owned().await.unwrap();
    drop(permit);
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_legacy_history_uses_rollout_without_requesting_the_unsupported_item_api() {
    use crate::agents::CodexAppServerClient;
    use crate::runtime_work::codex_transcript_page::{
        load_codex_transcript, CodexTranscriptRequest,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let _capabilities = crate::services::capability_activation::begin_execution().await;
    let directory = tempfile::tempdir().unwrap();
    let rollout = directory.path().join("legacy.jsonl");
    fs::write(
        &rollout,
        records([
            json!({"type":"task_started","turn_id":"legacy"}),
            json!({"type":"user_message","message":"question"}),
            json!({"type":"agent_message","message":"answer","phase":"final_answer"}),
            json!({"type":"task_complete","turn_id":"legacy","completed_at":123}),
        ]),
    )
    .unwrap();
    let metadata = directory.path().join("metadata.json");
    fs::write(
        &metadata,
        json!({"thread":{
            "id":"thread-1","historyMode":"legacy","path":rollout
        }})
        .to_string(),
    )
    .unwrap();
    let log = directory.path().join("requests.jsonl");
    let binary = directory.path().join("app-server");
    let script = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__LOG__'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) result='{}' ;;
    *'"method":"initialized"'*) continue ;;
    *'"method":"thread/read"'*) result=$(cat '__METADATA__') ;;
    *) printf '{"id":%s,"error":{"code":-32601,"message":"unsupported legacy API"}}\n' "$id"; continue ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
    fs::write(
        &binary,
        crate::agents::CodexLaunchEnvironment::with_bundled_catalog(script)
            .replace("__LOG__", &log.to_string_lossy())
            .replace("__METADATA__", &metadata.to_string_lossy()),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let request = serde_json::from_value(json!({
        "user_name":"synthetic","team_namespace":"default","team_name":"legacy",
        "team_id":12,"bot":[{"id":31,"shell_type":"Codex"}]
    }))
    .unwrap();
    let client = CodexAppServerClient::new(binary.to_string_lossy())
        .for_request(&request)
        .unwrap();
    let page = load_codex_transcript(
        &client,
        CodexTranscriptRequest {
            thread_id: "thread-1",
            cursor: None,
            limit: 5,
            direction: CodexTranscriptDirection::Descending,
            full_content: false,
            bounded_items: true,
            prefer_rollout_history: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        page.thread["turns"][0]["items"][0]["content"][0]["text"],
        "question"
    );
    assert_eq!(page.thread["turns"][0]["items"][1]["text"], "answer");
    let calls = fs::read_to_string(log).unwrap();
    assert!(!calls.contains("thread/items/list"));
    assert!(!calls.contains("thread/turns/list"));
}
