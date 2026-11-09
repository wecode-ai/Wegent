// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use crate::{logging::log_executor_event, services::turn_file_changes::failed_file_change_summary};

use super::NAMESPACE;

// Match backend/app/core/socketio.py. Count the Engine.IO / Socket.IO prefix
// and the serialized [event, payload], including JSON string escaping.
const MAX_PACKET_BYTES: usize = 1_000_000;
const SNAPSHOT_KEYS: [&str; 2] = ["file_changes", "task_file_changes"];

struct InlineDiff {
    key: &'static str,
    text: String,
    truncated: Option<Value>,
}

pub(super) fn fit_completed_event(
    event: &str,
    mut payload: Value,
) -> Result<(&str, Value), String> {
    if event != "response.completed" || packet_bytes(event, &payload)? <= MAX_PACKET_BYTES {
        return Ok((event, payload));
    }

    let mut diffs = take_inline_diffs(&mut payload)?;
    // Start with the smallest valid inline representation. Only degrade file
    // metadata when it cannot fit even before allocating optional diff text.
    let degraded = fit_metadata(event, &mut payload)?;
    diffs.retain(|diff| !degraded.contains(&diff.key));
    if packet_bytes(event, &payload)? > MAX_PACKET_BYTES {
        return Ok(("error", oversized_completion_error(&payload)));
    }

    // Metadata is final now. Restore the cumulative diff first, then spend any
    // remaining bytes on the per-turn diff without reviving degraded snapshots.
    for diff in diffs.into_iter().rev() {
        restore_inline_diff(event, &mut payload, diff)?;
    }
    Ok((event, payload))
}

fn fit_metadata(event: &str, payload: &mut Value) -> Result<Vec<&'static str>, String> {
    if packet_bytes(event, payload)? <= MAX_PACKET_BYTES {
        return Ok(Vec::new());
    }
    // Prefer retaining cumulative metadata, but do not discard a usable turn
    // snapshot when only the cumulative file list is too large.
    for key in SNAPSHOT_KEYS {
        if let Some(original) = degrade_snapshot(payload, key) {
            if packet_bytes(event, payload)? <= MAX_PACKET_BYTES {
                return Ok(vec![key]);
            }
            *payload
                .pointer_mut(&format!("/data/response/{key}"))
                .unwrap() = original;
        }
    }
    Ok(SNAPSHOT_KEYS
        .into_iter()
        .filter(|key| degrade_snapshot(payload, key).is_some())
        .collect())
}

fn degrade_snapshot(payload: &mut Value, key: &str) -> Option<Value> {
    let summary = payload.pointer_mut(&format!("/data/response/{key}"))?;
    let mut failed = failed_file_change_summary();
    if let Some(artifact) = summary.get("artifact_id") {
        failed["artifact_id"] = artifact.clone();
    }
    Some(std::mem::replace(summary, failed))
}

fn take_inline_diffs(payload: &mut Value) -> Result<Vec<InlineDiff>, String> {
    let mut diffs = Vec::new();
    let empty_bytes = encoded_bytes(&json!({"diff": "", "diff_truncated": true}))?;
    for key in SNAPSHOT_KEYS {
        let Some(summary) = payload.pointer_mut(&format!("/data/response/{key}")) else {
            continue;
        };
        let Some(text) = summary.get("diff").and_then(Value::as_str) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let truncated = summary.get("diff_truncated").cloned();
        let mut original = json!({"diff": text});
        if let Some(flag) = &truncated {
            original["diff_truncated"] = flag.clone();
        }
        // A short full diff with no flag can be smaller than empty + true.
        // Keep that full representation instead of needlessly degrading files.
        if encoded_bytes(&original)? <= empty_bytes {
            continue;
        }
        let Value::String(text) = summary["diff"].take() else {
            unreachable!("diff was checked to be a non-empty string");
        };
        summary["diff"] = Value::String(String::new());
        summary["diff_truncated"] = Value::Bool(true);
        diffs.push(InlineDiff {
            key,
            text,
            truncated,
        });
    }
    Ok(diffs)
}

fn restore_inline_diff(event: &str, payload: &mut Value, diff: InlineDiff) -> Result<(), String> {
    let path = format!("/data/response/{}", diff.key);
    let summary = payload.pointer_mut(&path).expect("retained snapshot");
    summary["diff"] = Value::String(diff.text);
    match diff.truncated {
        Some(flag) => summary["diff_truncated"] = flag,
        None => {
            summary.as_object_mut().unwrap().remove("diff_truncated");
        }
    }
    if packet_bytes(event, payload)? <= MAX_PACKET_BYTES {
        return Ok(());
    }

    let summary = payload.pointer_mut(&path).unwrap();
    let Value::String(mut text) = summary["diff"].take() else {
        unreachable!("restored diff is a string");
    };
    summary["diff"] = Value::String(String::new());
    summary["diff_truncated"] = Value::Bool(true);
    let available = MAX_PACKET_BYTES.saturating_sub(packet_bytes(event, payload)?);
    let end = prefix_within_json_budget(&text, available)?;
    if end == text.len() {
        // false is one byte longer than true. A full prefix that fits only with
        // true still needs an actual truncation to keep the flag truthful.
        text.pop();
    } else {
        text.truncate(end);
    }
    payload.pointer_mut(&path).unwrap()["diff"] = Value::String(text);
    Ok(())
}

fn oversized_completion_error(payload: &Value) -> Value {
    log_executor_event(
        "device callback exceeds transport limit",
        &[
            ("task_id", payload["task_id"].to_string()),
            ("subtask_id", payload["subtask_id"].to_string()),
            ("code", "device_callback_too_large".to_owned()),
        ],
    );
    let mut error = json!({
        "event_type": "error",
        "task_id": payload["task_id"],
        "subtask_id": payload["subtask_id"],
        "data": {
            "type": "error",
            "code": "device_callback_too_large",
            "message": "Task output exceeded the device callback limit",
        },
    });
    if let Some(message_id) = payload.get("message_id") {
        error["message_id"] = message_id.clone();
    }
    error
}

fn prefix_within_json_budget(text: &str, available: usize) -> Result<usize, String> {
    let mut low = 0;
    let mut high = text.len();
    while low < high {
        let mut end = low + (high - low).div_ceil(2);
        while !text.is_char_boundary(end) {
            end += 1;
        }
        // The empty string's two quotes are already in the packet budget.
        if encoded_bytes(&text[..end])?.saturating_sub(2) <= available {
            low = end;
        } else {
            high = end - 1;
            while !text.is_char_boundary(high) {
                high -= 1;
            }
        }
    }
    Ok(low)
}

fn packet_bytes(event: &str, payload: &Value) -> Result<usize, String> {
    Ok(2 + NAMESPACE.len() + 1 + encoded_bytes(&(event, payload))?)
}

fn encoded_bytes(value: &(impl serde::Serialize + ?Sized)) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| format!("Device event serialization failed: {error}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn escaped_strings_and_multibyte_characters_fit_the_actual_packet_budget() {
        let text = "\"\\\n\r\t\u{0001}中🙂".repeat(70_000);
        let mut payload = json!({"data": {"response": {
            "status": "completed",
            "output": [{"text": "final output"}],
            "file_changes": {"status":"active", "files":[{"path":"a.txt"}],
                "diff":text, "diff_truncated":false},
            "task_file_changes": {"status":"active", "files":[{"path":"b.txt"}],
                "diff":text, "diff_truncated":false}
        }}});
        assert!(packet_bytes("response.completed", &payload).unwrap() > MAX_PACKET_BYTES);
        let original = payload.clone();
        let (event, bounded) = fit_completed_event("response.completed", payload).unwrap();
        assert_eq!(event, "response.completed");
        payload = bounded;
        assert!(packet_bytes("response.completed", &payload).unwrap() <= MAX_PACKET_BYTES);
        assert_eq!(
            payload["data"]["response"]["output"],
            original["data"]["response"]["output"]
        );
        // The maximal cumulative prefix leaves four encoded bytes. Reassign
        // those bytes to the turn's leading quote and backslash as well.
        let turn_prefix = text.chars().take(2).collect::<String>();
        assert_eq!(
            payload["data"]["response"]["file_changes"]["diff"],
            turn_prefix
        );
        let task = &payload["data"]["response"]["task_file_changes"];
        assert_eq!(task["diff_truncated"], true);
        let prefix = task["diff"].as_str().unwrap();
        assert!(!prefix.is_empty());
        assert!(text.starts_with(prefix));
        assert_eq!(
            task["files"],
            original["data"]["response"]["task_file_changes"]["files"]
        );
        for key in SNAPSHOT_KEYS {
            let prefix = payload["data"]["response"][key]["diff"].as_str().unwrap();
            assert!(text.starts_with(prefix));
            assert_eq!(payload["data"]["response"][key]["diff_truncated"], true);
            let next = text[prefix.len()..].chars().next().unwrap();
            let mut expanded = payload.clone();
            expanded["data"]["response"][key]["diff"] = json!(format!("{prefix}{next}"));
            assert!(packet_bytes("response.completed", &expanded).unwrap() > MAX_PACKET_BYTES);
        }
        assert_eq!(
            fit_completed_event("response.completed", payload.clone())
                .unwrap()
                .1,
            payload
        );
    }

    #[test]
    fn oversized_file_lists_report_an_error_and_keep_the_turn_artifact() {
        let files = (0..20_000)
            .map(|index| {
                json!({"path": format!("nested-folder/changed-file-{index}.txt"),
                "additions": 1, "deletions": 0})
            })
            .collect::<Vec<_>>();
        let payload = json!({"data": {"response": {
            "status": "completed", "output": [{"text":"done"}],
            "file_changes": {"status":"active", "artifact_id":"turn-file-changes/1/2",
                "files":files, "diff":""},
            "task_file_changes": {"status":"active", "files":[{"path":"b.txt"}],
                "diff":"+small\n", "diff_truncated":false}
        }}});
        let (event, bounded) = fit_completed_event("response.completed", payload).unwrap();
        assert_eq!(event, "response.completed");
        assert!(packet_bytes("response.completed", &bounded).unwrap() <= MAX_PACKET_BYTES);
        let response = &bounded["data"]["response"];
        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["text"], "done");
        assert_eq!(response["file_changes"]["status"], "error");
        assert_eq!(
            response["file_changes"]["artifact_id"],
            "turn-file-changes/1/2"
        );
        assert_eq!(response["task_file_changes"]["status"], "active");
        assert_eq!(response["task_file_changes"]["diff"], "+small\n");
        assert_eq!(response["task_file_changes"]["diff_truncated"], false);
    }

    #[test]
    fn oversized_final_text_reports_an_explicit_failure_with_or_without_diffs() {
        for fields in [
            json!({}),
            json!({"file_changes": {"status":"active", "files":[], "diff":"+text"}}),
        ] {
            let mut response = json!({
                "status":"completed", "output":[{"text":"中".repeat(340_000)}],
            });
            response
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            let payload = json!({"event_type":"response.completed", "task_id":11,
                "subtask_id":112, "message_id":113, "data":{"response":response}});
            let (event, error) = fit_completed_event("response.completed", payload).unwrap();
            assert_eq!(event, "error");
            assert!(packet_bytes(event, &error).unwrap() <= MAX_PACKET_BYTES);
            assert_eq!(error["event_type"], "error");
            assert_eq!(error["task_id"], 11);
            assert_eq!(error["subtask_id"], 112);
            assert_eq!(error["message_id"], 113);
            assert_eq!(error["data"]["code"], "device_callback_too_large");
            assert_eq!(error["data"]["type"], "error");
        }
    }

    #[test]
    fn exact_packet_boundaries_preserve_flags_and_utf8() {
        for flag in [None, Some(json!(false)), Some(json!(true))] {
            let mut summary = json!({"status":"active", "files":[{"path":"a.txt"}],
                "diff": if flag == Some(json!(false)) { "中".to_owned() } else { "🙂".repeat(10) }});
            if let Some(flag) = &flag {
                summary["diff_truncated"] = flag.clone();
            }
            let mut payload = json!({"task_id":1,"subtask_id":2,"data":{"response":{
                "status":"completed", "output":[{"text":""}], "task_file_changes":summary
            }}});
            fill_packet(&mut payload, MAX_PACKET_BYTES);
            let (event, exact) =
                fit_completed_event("response.completed", payload.clone()).unwrap();
            assert_eq!(event, "response.completed");
            assert_eq!(exact, payload);

            fill_packet(&mut payload, MAX_PACKET_BYTES + 1);
            let (event, bounded) =
                fit_completed_event("response.completed", payload.clone()).unwrap();
            assert_eq!(event, "response.completed");
            assert!(packet_bytes(event, &bounded).unwrap() <= MAX_PACKET_BYTES);
            let changes = &bounded["data"]["response"]["task_file_changes"];
            let prefix = changes["diff"].as_str().unwrap();
            let original = summary["diff"].as_str().unwrap();
            assert!(prefix.len() < original.len());
            assert!(original.starts_with(prefix));
            assert_eq!(changes["diff_truncated"], true);
            assert_eq!(changes["files"], summary["files"]);
            assert_eq!(changes["status"], "active");
            assert_eq!(
                bounded["data"]["response"]["output"],
                payload["data"]["response"]["output"]
            );
            assert_eq!(
                fit_completed_event(event, bounded.clone()).unwrap().1,
                bounded
            );
        }
    }

    #[test]
    fn short_diff_without_a_flag_does_not_force_metadata_degradation() {
        let task = json!({"status":"active", "files":[{"path":"a.txt"}], "diff":"x"});
        let mut payload = json!({"task_id":1,"subtask_id":2,"data":{"response":{
            "status":"completed", "output":[{"text":""}], "task_file_changes":task,
            "file_changes":{"status":"active", "files":[{"path":"b.txt"}],
                "diff":"y".repeat(128), "diff_truncated":false}
        }}});
        fill_packet(&mut payload, MAX_PACKET_BYTES + 1);
        let (event, bounded) = fit_completed_event("response.completed", payload).unwrap();
        assert_eq!(event, "response.completed");
        assert!(packet_bytes(event, &bounded).unwrap() <= MAX_PACKET_BYTES);
        assert_eq!(bounded["data"]["response"]["task_file_changes"], task);
        let turn = &bounded["data"]["response"]["file_changes"];
        assert_eq!(turn["status"], "active");
        assert_eq!(turn["files"][0]["path"], "b.txt");
        assert_eq!(turn["diff_truncated"], true);
        assert!(!turn["diff"].as_str().unwrap().is_empty());
        assert!(turn["diff"].as_str().unwrap().len() < 128);
        assert_eq!(
            fit_completed_event(event, bounded.clone()).unwrap().1,
            bounded
        );
    }

    #[test]
    fn empty_diffs_keep_their_flags_when_other_metadata_is_degraded() {
        let files = (0..20_000)
            .map(|index| {
                json!({"path": format!("nested-folder/changed-file-{index}.txt"),
                "additions":1, "deletions":0})
            })
            .collect::<Vec<_>>();
        for flag in [None, Some(json!(false)), Some(json!(true))] {
            let mut task = json!({"status":"active", "files":[], "diff":""});
            if let Some(flag) = flag {
                task["diff_truncated"] = flag;
            }
            let payload = json!({"data":{"response":{"status":"completed",
                "task_file_changes": task, "file_changes":{"status":"active",
                    "files":files, "diff":"+large file list\n", "diff_truncated":false}
            }}});
            let (event, bounded) = fit_completed_event("response.completed", payload).unwrap();
            assert_eq!(event, "response.completed");
            assert!(packet_bytes(event, &bounded).unwrap() <= MAX_PACKET_BYTES);
            assert_eq!(bounded["data"]["response"]["task_file_changes"], task);
            assert_eq!(
                bounded["data"]["response"]["file_changes"]["status"],
                "error"
            );
            assert_eq!(
                fit_completed_event(event, bounded.clone()).unwrap().1,
                bounded
            );
        }
    }

    fn fill_packet(payload: &mut Value, target: usize) {
        payload["data"]["response"]["output"][0]["text"] = json!("");
        let base = packet_bytes("response.completed", payload).unwrap();
        assert!(target > base);
        payload["data"]["response"]["output"][0]["text"] = json!("x".repeat(target - base));
        assert_eq!(packet_bytes("response.completed", payload).unwrap(), target);
    }
}
