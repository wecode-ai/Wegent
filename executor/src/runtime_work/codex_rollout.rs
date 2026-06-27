// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use serde_json::{json, Value};

use super::util::{
    codex_wrapped_item_payload, extract_text, item_type, now_ms, string_field, timestamp_ms_field,
};

const ROLLOUT_STATUS_TAIL_BYTES: u64 = 64 * 1024;

pub(crate) fn thread_with_rollout_turns(thread: &Value) -> Option<Value> {
    let Some(path) = string_field(thread, "path") else {
        return thread
            .get("turns")
            .and_then(Value::as_array)
            .is_some_and(|turns| !turns.is_empty())
            .then(|| thread.clone());
    };
    let turns = rollout_path_turns(Path::new(&path), thread);
    if turns.is_empty() {
        return thread
            .get("turns")
            .and_then(Value::as_array)
            .is_some_and(|turns| !turns.is_empty())
            .then(|| thread.clone());
    }

    let mut next_thread = thread.clone();
    let object = next_thread.as_object_mut()?;
    object.insert("turns".to_owned(), Value::Array(turns));
    Some(next_thread)
}

pub(crate) fn thread_with_turns(thread: &Value, turns: Vec<Value>) -> Value {
    let mut next_thread = thread.clone();
    if let Some(object) = next_thread.as_object_mut() {
        object.insert("turns".to_owned(), Value::Array(turns));
    }
    next_thread
}

pub(crate) fn rollout_turns(thread: &Value) -> Option<Vec<Value>> {
    thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .filter(|turns| !turns.is_empty())
}

pub(crate) struct RolloutAppend {
    pub turns: Vec<Value>,
    pub changed_start: Option<usize>,
}

pub(crate) fn append_rollout_turns_from_offset(
    thread: &Value,
    mut turns: Vec<Value>,
    offset: u64,
) -> Option<RolloutAppend> {
    let path = string_field(thread, "path")?;
    let mut file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if metadata.len() < offset {
        return None;
    }
    if metadata.len() == offset {
        return Some(RolloutAppend {
            turns,
            changed_start: None,
        });
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let reader = BufReader::new(file);
    let fallback_started_at = timestamp_ms_field(thread, "createdAt").unwrap_or_else(now_ms);
    let mut changed_start = None;

    for line in reader.lines().map_while(Result::ok) {
        let Ok(item) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        apply_rollout_item_to_turns(&mut turns, &mut changed_start, item, fallback_started_at);
    }

    for index in changed_start.unwrap_or(turns.len())..turns.len() {
        dedupe_turn_items(&mut turns[index]);
    }
    Some(RolloutAppend {
        turns,
        changed_start,
    })
}

pub(crate) fn thread_with_rollout_running_status(thread: &Value) -> Value {
    if !rollout_tail_is_running(thread) {
        return thread.clone();
    }

    let mut next_thread = thread.clone();
    if let Some(object) = next_thread.as_object_mut() {
        object.insert("status".to_owned(), Value::String("running".to_owned()));
    }
    next_thread
}

fn rollout_tail_is_running(thread: &Value) -> bool {
    let Some(path) = string_field(thread, "path") else {
        return false;
    };
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let file_len = metadata.len();
    let start = file_len.saturating_sub(ROLLOUT_STATUS_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }

    let mut tail_bytes = Vec::new();
    if file.read_to_end(&mut tail_bytes).is_err() {
        return false;
    }
    let tail = String::from_utf8_lossy(&tail_bytes);
    let tail = if start > 0 {
        tail.split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or(tail.as_ref())
    } else {
        tail.as_ref()
    };

    let mut running = false;
    for line in tail.lines() {
        let Ok(item) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if is_turn_start_item(&item) {
            running = true;
            continue;
        }
        if is_turn_completion_item(&item) {
            running = false;
            continue;
        }
        if rollout_transcript_item(&item).is_some() || is_rollout_activity_item(&item) {
            running = true;
        }
    }
    running
}

fn rollout_path_turns(path: &Path, thread: &Value) -> Vec<Value> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut turns = Vec::new();
    let mut current = RolloutTurn::default();
    let fallback_started_at = timestamp_ms_field(thread, "createdAt").unwrap_or_else(now_ms);

    for line in reader.lines().map_while(Result::ok) {
        let Ok(item) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if is_turn_start_item(&item) {
            push_rollout_turn(&mut turns, &mut current, fallback_started_at);
            current = RolloutTurn::started(
                turns.len(),
                rollout_turn_id(&item, turns.len()),
                item_timestamp_ms(&item).unwrap_or(fallback_started_at),
            );
            continue;
        }

        if is_turn_completion_item(&item) {
            if current.has_activity() {
                current.status = rollout_completion_status(&item);
                current.completed_at = item_timestamp_ms(&item).or(Some(fallback_started_at));
                push_rollout_turn(&mut turns, &mut current, fallback_started_at);
            }
            continue;
        }

        let Some(transcript_item) = rollout_transcript_item(&item) else {
            if is_rollout_activity_item(&item) {
                current.ensure_started(turns.len(), fallback_started_at);
                current.has_activity = true;
            }
            continue;
        };
        current.ensure_started(turns.len(), fallback_started_at);
        current.has_activity = true;
        current.items.push(transcript_item);
    }

    push_rollout_turn(&mut turns, &mut current, fallback_started_at);
    turns
}

#[derive(Default)]
struct RolloutTurn {
    id: String,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    status: String,
    has_activity: bool,
    items: Vec<Value>,
}

impl RolloutTurn {
    fn started(index: usize, id: String, started_at: i64) -> Self {
        Self {
            id,
            started_at: Some(started_at),
            status: "running".to_owned(),
            ..Self::default()
        }
        .with_default_id(index)
    }

    fn ensure_started(&mut self, index: usize, fallback_started_at: i64) {
        if self.started_at.is_none() {
            self.id = format!("rollout-turn-{}", index + 1);
            self.started_at = Some(fallback_started_at);
            self.status = "running".to_owned();
        }
    }

    fn has_activity(&self) -> bool {
        self.has_activity || !self.items.is_empty()
    }

    fn with_default_id(mut self, index: usize) -> Self {
        if self.id.is_empty() {
            self.id = format!("rollout-turn-{}", index + 1);
        }
        self
    }
}

fn push_rollout_turn(turns: &mut Vec<Value>, current: &mut RolloutTurn, fallback_started_at: i64) {
    if !current.has_activity() {
        *current = RolloutTurn::default();
        return;
    }
    current.ensure_started(turns.len(), fallback_started_at);
    let id = std::mem::take(&mut current.id);
    let items = dedupe_rollout_text_events(std::mem::take(&mut current.items));
    let status = std::mem::take(&mut current.status);
    let started_at = current.started_at.unwrap_or(fallback_started_at);
    let completed_at = current.completed_at;
    let mut turn = json!({
        "id": id,
        "createdAt": started_at,
        "startedAt": started_at,
        "status": status,
        "items": items,
    });
    if let Some(completed_at) = completed_at {
        if let Some(object) = turn.as_object_mut() {
            object.insert("completedAt".to_owned(), json!(completed_at));
        }
    }
    turns.push(turn);
    *current = RolloutTurn::default();
}

fn apply_rollout_item_to_turns(
    turns: &mut Vec<Value>,
    changed_start: &mut Option<usize>,
    item: Value,
    fallback_started_at: i64,
) {
    if is_turn_start_item(&item) {
        let index = turns.len();
        turns.push(new_rollout_turn(
            index,
            rollout_turn_id(&item, index),
            item_timestamp_ms(&item).unwrap_or(fallback_started_at),
        ));
        mark_changed(changed_start, index);
        return;
    }

    if is_turn_completion_item(&item) {
        let index = turns.len().saturating_sub(1);
        if let Some(turn) = turns.last_mut() {
            set_turn_completion(turn, &item, fallback_started_at);
            mark_changed(changed_start, index);
        }
        return;
    }

    let Some(transcript_item) = rollout_transcript_item(&item) else {
        if is_rollout_activity_item(&item) {
            let index = ensure_append_turn(turns, fallback_started_at);
            mark_changed(changed_start, index);
        }
        return;
    };

    let index = ensure_append_turn(turns, fallback_started_at);
    if let Some(items) = turns[index].get_mut("items").and_then(Value::as_array_mut) {
        items.push(transcript_item);
        mark_changed(changed_start, index);
    }
}

fn mark_changed(changed_start: &mut Option<usize>, index: usize) {
    *changed_start = Some(changed_start.map_or(index, |current| current.min(index)));
}

fn ensure_append_turn(turns: &mut Vec<Value>, fallback_started_at: i64) -> usize {
    if turns.last().map(turn_is_terminal).unwrap_or(true) {
        let index = turns.len();
        turns.push(new_rollout_turn(
            index,
            format!("rollout-turn-{}", index + 1),
            fallback_started_at,
        ));
    }
    turns.len().saturating_sub(1)
}

fn new_rollout_turn(index: usize, id: String, started_at: i64) -> Value {
    json!({
        "id": if id.is_empty() {
            format!("rollout-turn-{}", index + 1)
        } else {
            id
        },
        "createdAt": started_at,
        "startedAt": started_at,
        "status": "running",
        "items": [],
    })
}

fn set_turn_completion(turn: &mut Value, item: &Value, fallback_started_at: i64) {
    let completed_at = item_timestamp_ms(item).unwrap_or(fallback_started_at);
    if let Some(object) = turn.as_object_mut() {
        object.insert(
            "status".to_owned(),
            Value::String(rollout_completion_status(item)),
        );
        object.insert("completedAt".to_owned(), json!(completed_at));
    }
}

fn turn_is_terminal(turn: &Value) -> bool {
    string_field(turn, "status")
        .map(|status| {
            matches!(
                status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
                "completed" | "complete" | "done" | "failed" | "error" | "interrupted"
            )
        })
        .unwrap_or(false)
}

fn dedupe_turn_items(turn: &mut Value) {
    let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
        return;
    };
    let deduped = dedupe_rollout_text_events(std::mem::take(items));
    *items = deduped;
}

fn rollout_transcript_item(item: &Value) -> Option<Value> {
    match item_type(item).as_str() {
        "responseitem" => Some(item.clone()),
        "eventmsg" if rollout_event_is_transcript_item(item) => Some(item.clone()),
        _ => None,
    }
}

fn is_rollout_activity_item(item: &Value) -> bool {
    match item_type(item).as_str() {
        "responseitem" => true,
        "eventmsg" => codex_payload_type(item)
            .as_deref()
            .is_some_and(|payload_type| !matches!(payload_type, "token_count" | "tokencount")),
        _ => false,
    }
}

fn rollout_event_is_transcript_item(item: &Value) -> bool {
    codex_payload_type(item)
        .as_deref()
        .is_some_and(|payload_type| {
            !matches!(
                payload_type,
                "token_count"
                    | "tokencount"
                    | "taskstarted"
                    | "taskcomplete"
                    | "turncomplete"
                    | "turncompleted"
                    | "turnaborted"
            )
        })
}

fn dedupe_rollout_text_events(items: Vec<Value>) -> Vec<Value> {
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if event_text_signature(item).is_some_and(|event_signature| {
                items
                    .iter()
                    .enumerate()
                    .any(|(candidate_index, candidate)| {
                        candidate_index != index
                            && response_text_signature(candidate).as_ref().is_some_and(
                                |response_signature| {
                                    text_signatures_match(&event_signature, response_signature)
                                },
                            )
                    })
            }) {
                return None;
            }
            Some(item.clone())
        })
        .collect()
}

#[derive(Clone)]
struct TextSignature {
    role: String,
    phase: Option<String>,
    text: String,
}

fn event_text_signature(item: &Value) -> Option<TextSignature> {
    if item_type(item) != "eventmsg" {
        return None;
    }
    let payload = codex_wrapped_item_payload(item)?;
    match item_type(payload).as_str() {
        "usermessage" => text_signature(payload, "user"),
        "agentmessage" => text_signature(payload, "assistant"),
        _ => None,
    }
}

fn response_text_signature(item: &Value) -> Option<TextSignature> {
    if item_type(item) != "responseitem" {
        return None;
    }
    let payload = codex_wrapped_item_payload(item)?;
    match item_type(payload).as_str() {
        "message" => {
            let role = string_field(payload, "role")?;
            text_signature(payload, &role)
        }
        "usermessage" => text_signature(payload, "user"),
        "agentmessage" => text_signature(payload, "assistant"),
        _ => None,
    }
}

fn text_signature(item: &Value, role: &str) -> Option<TextSignature> {
    let text = extract_text(item)?;
    Some(TextSignature {
        role: role.to_ascii_lowercase(),
        phase: string_field(item, "phase").map(normalized_phase),
        text,
    })
}

fn text_signatures_match(event: &TextSignature, response: &TextSignature) -> bool {
    event.role == response.role
        && event.text == response.text
        && phases_match(event.phase.as_deref(), response.phase.as_deref())
}

fn phases_match(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    }
}

fn normalized_phase(phase: String) -> String {
    phase.replace(['_', '-'], "").to_ascii_lowercase()
}

fn is_turn_start_item(item: &Value) -> bool {
    codex_payload_type(item)
        .as_deref()
        .is_some_and(|payload_type| matches!(payload_type, "taskstarted"))
}

fn is_turn_completion_item(item: &Value) -> bool {
    codex_payload_type(item)
        .as_deref()
        .is_some_and(|payload_type| {
            matches!(
                payload_type,
                "taskcomplete" | "turncomplete" | "turncompleted" | "turnaborted"
            )
        })
}

fn rollout_completion_status(item: &Value) -> String {
    if codex_payload_type(item).as_deref() == Some("turnaborted") {
        "interrupted".to_owned()
    } else {
        "completed".to_owned()
    }
}

fn rollout_turn_id(item: &Value, index: usize) -> String {
    codex_wrapped_item_payload(item)
        .and_then(|payload| {
            string_field(payload, "turn_id").or_else(|| string_field(payload, "id"))
        })
        .or_else(|| string_field(item, "turn_id").or_else(|| string_field(item, "id")))
        .unwrap_or_else(|| format!("rollout-turn-{}", index + 1))
}

fn item_timestamp_ms(item: &Value) -> Option<i64> {
    timestamp_ms_field(item, "timestamp")
        .or_else(|| timestamp_ms_field(item, "createdAt"))
        .or_else(|| timestamp_ms_field(item, "created_at"))
        .or_else(|| {
            codex_wrapped_item_payload(item).and_then(|payload| {
                timestamp_ms_field(payload, "timestamp")
                    .or_else(|| timestamp_ms_field(payload, "createdAt"))
                    .or_else(|| timestamp_ms_field(payload, "created_at"))
                    .or_else(|| timestamp_ms_field(payload, "completed_at"))
                    .or_else(|| timestamp_ms_field(payload, "completedAt"))
            })
        })
}

fn codex_payload_type(item: &Value) -> Option<String> {
    codex_wrapped_item_payload(item).map(item_type)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    #[test]
    fn detects_active_turn_when_rollout_has_activity_after_last_task_complete() {
        let path = temp_rollout_path("active");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string(),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"continue"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"reasoning","summary":[]}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"working"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");
        assert_eq!(hydrated["turns"][0]["status"], "running");
        let items = hydrated["turns"][0]["items"]
            .as_array()
            .expect("items should exist");
        assert!(items
            .iter()
            .any(|item| item["payload"]["message"] == "working"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_inactive_turn_when_rollout_ends_with_task_complete() {
        let path = temp_rollout_path("complete");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"user_message","message":"fix"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");
        assert_eq!(hydrated["turns"][0]["status"], "completed");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_inactive_turn_when_rollout_ends_with_turn_aborted() {
        let path = temp_rollout_path("aborted");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"user_message","message":"fix"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command"}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");
        assert_eq!(hydrated["turns"][0]["status"], "interrupted");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn drops_duplicate_text_events_when_response_items_are_present() {
        let path = temp_rollout_path("dedupe");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"user_message","message":"fix"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix"}]}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"done"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");
        let items = hydrated["turns"][0]["items"]
            .as_array()
            .expect("items should exist");

        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item["type"] == "response_item"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn prefers_rollout_turns_over_app_server_turns_when_available() {
        let path = temp_rollout_path("prefer-rollout");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"task_started"}}).to_string(),
                json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let mut thread = thread_with_path(&path);
        thread["turns"] = json!([
            {
                "id": "app-server-turn",
                "status": "completed",
                "items": [
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "text only"}]}
                ]
            }
        ]);

        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");

        assert_eq!(hydrated["turns"][0]["status"], "running");
        assert_eq!(
            hydrated["turns"][0]["items"][0]["payload"]["type"],
            "function_call"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn running_status_uses_rollout_tail_without_hydrating_turns() {
        let path = temp_rollout_path("running-status");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"task_started"}}).to_string(),
                json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let state = thread_with_rollout_running_status(&thread);

        assert_eq!(state["status"], "running");
        assert_eq!(
            state["turns"]
                .as_array()
                .expect("existing turns array should be preserved")
                .len(),
            0
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn running_status_detects_completed_tail() {
        let path = temp_rollout_path("running-status-complete");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"task_started"}}).to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let state = thread_with_rollout_running_status(&thread);

        assert_ne!(state["status"], "running");
        assert_eq!(
            state["turns"]
                .as_array()
                .expect("existing turns array should be preserved")
                .len(),
            0
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn append_rollout_turns_extends_cached_running_turn() {
        let path = temp_rollout_path("append-running");
        let initial = [
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}})
                .to_string(),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command"}})
                .to_string(),
        ]
        .join("\n");
        fs::write(&path, format!("{initial}\n")).unwrap();
        let offset = fs::metadata(&path).unwrap().len();
        fs::write(
            &path,
            format!(
                "{initial}\n{}\n{}\n",
                json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}})
            ),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let cached = vec![json!({
            "id": "turn-1",
            "createdAt": 1_780_000_000_i64,
            "startedAt": 1_780_000_000_i64,
            "status": "running",
            "items": [
                {"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command"}}
            ],
        })];
        let appended = append_rollout_turns_from_offset(&thread, cached, offset)
            .expect("append should parse new rollout bytes");

        assert_eq!(appended.changed_start, Some(0));
        assert_eq!(appended.turns.len(), 1);
        assert_eq!(appended.turns[0]["status"], "completed");
        assert_eq!(appended.turns[0]["items"].as_array().unwrap().len(), 2);
        assert_eq!(appended.turns[0]["items"][1]["payload"]["output"], "ok");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn append_rollout_turns_adds_new_started_turn() {
        let path = temp_rollout_path("append-new-turn");
        let initial = [
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}})
                .to_string(),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}})
                .to_string(),
        ]
        .join("\n");
        fs::write(&path, format!("{initial}\n")).unwrap();
        let offset = fs::metadata(&path).unwrap().len();
        fs::write(
            &path,
            format!(
                "{initial}\n{}\n{}\n",
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"next"}]}})
            ),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let cached = vec![json!({
            "id": "turn-1",
            "createdAt": 1_780_000_000_i64,
            "startedAt": 1_780_000_000_i64,
            "status": "completed",
            "items": [],
        })];
        let appended = append_rollout_turns_from_offset(&thread, cached, offset)
            .expect("append should parse new rollout bytes");

        assert_eq!(appended.changed_start, Some(1));
        assert_eq!(appended.turns.len(), 2);
        assert_eq!(appended.turns[1]["id"], "turn-2");
        assert_eq!(appended.turns[1]["status"], "running");
        assert_eq!(
            appended.turns[1]["items"][0]["payload"]["role"],
            "assistant"
        );
        let _ = fs::remove_file(path);
    }

    fn thread_with_path(path: &Path) -> Value {
        json!({
            "id": "thread-1",
            "path": path.display().to_string(),
            "createdAt": 1_780_000_000_i64,
            "turns": [],
        })
    }

    fn temp_rollout_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "wegent-codex-rollout-{label}-{}-{nanos}.jsonl",
            std::process::id()
        ))
    }
}
