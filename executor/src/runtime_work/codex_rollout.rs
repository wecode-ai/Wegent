// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::Path,
};

use serde_json::{json, Value};

use super::util::{
    codex_wrapped_item_payload, extract_text, integer_field, item_type, now_ms, string_field,
    timestamp_ms_field,
};

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

pub(crate) fn rollout_context_usage(thread: &Value) -> Option<Value> {
    normalize_thread_token_usage(
        thread
            .get("tokenUsage")
            .or_else(|| thread.get("token_usage"))
            .unwrap_or(thread),
    )
    .or_else(|| {
        string_field(thread, "path").and_then(|path| rollout_path_context_usage(Path::new(&path)))
    })
}

pub(crate) fn thread_with_turns(thread: &Value, turns: Vec<Value>) -> Value {
    let mut next_thread = thread.clone();
    if let Some(object) = next_thread.as_object_mut() {
        object.insert("turns".to_owned(), Value::Array(turns));
    }
    next_thread
}

fn rollout_path_context_usage(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|item| {
            let payload = codex_wrapped_item_payload(&item).unwrap_or(&item);
            if !matches!(item_type(payload).as_str(), "tokencount" | "token_count") {
                return None;
            }
            payload
                .get("info")
                .and_then(normalize_token_usage_info)
                .or_else(|| normalize_thread_token_usage(payload))
        })
        .last()
}

fn normalize_token_usage_info(info: &Value) -> Option<Value> {
    let total = normalize_token_usage_breakdown(
        info.get("total_token_usage")
            .or_else(|| info.get("totalTokenUsage"))
            .or_else(|| info.get("total"))?,
    )?;
    let last = normalize_token_usage_breakdown(
        info.get("last_token_usage")
            .or_else(|| info.get("lastTokenUsage"))
            .or_else(|| info.get("last"))?,
    )?;
    let model_context_window = integer_field(info, "model_context_window")
        .or_else(|| integer_field(info, "modelContextWindow"))?;

    Some(json!({
        "total": total,
        "last": last,
        "modelContextWindow": model_context_window,
    }))
}

fn normalize_thread_token_usage(value: &Value) -> Option<Value> {
    let total = normalize_token_usage_breakdown(value.get("total")?)?;
    let last = normalize_token_usage_breakdown(value.get("last")?)?;
    let model_context_window = integer_field(value, "modelContextWindow")
        .or_else(|| integer_field(value, "model_context_window"))?;

    Some(json!({
        "total": total,
        "last": last,
        "modelContextWindow": model_context_window,
    }))
}

fn normalize_token_usage_breakdown(value: &Value) -> Option<Value> {
    Some(json!({
        "totalTokens": integer_field(value, "total_tokens")
            .or_else(|| integer_field(value, "totalTokens"))?,
        "inputTokens": integer_field(value, "input_tokens")
            .or_else(|| integer_field(value, "inputTokens"))
            .unwrap_or(0),
        "cachedInputTokens": integer_field(value, "cached_input_tokens")
            .or_else(|| integer_field(value, "cachedInputTokens"))
            .unwrap_or(0),
        "outputTokens": integer_field(value, "output_tokens")
            .or_else(|| integer_field(value, "outputTokens"))
            .unwrap_or(0),
        "reasoningOutputTokens": integer_field(value, "reasoning_output_tokens")
            .or_else(|| integer_field(value, "reasoningOutputTokens"))
            .unwrap_or(0),
    }))
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

    complete_current_turn_if_final_assistant_message(&mut current, fallback_started_at);
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
    if !is_root_turn_marker(&item) {
        return;
    }
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

fn is_final_assistant_message_item(item: &Value) -> bool {
    if item_type(item) != "responseitem" || !is_root_turn_marker(item) {
        return false;
    }
    let Some(payload) = codex_wrapped_item_payload(item) else {
        return false;
    };
    item_type(payload) == "message"
        && string_field(payload, "role").is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
}

fn complete_current_turn_if_final_assistant_message(
    current: &mut RolloutTurn,
    fallback_started_at: i64,
) {
    if current.status != "running" {
        return;
    }
    let Some(last_item) = current
        .items
        .last()
        .filter(|item| is_final_assistant_message_item(item))
    else {
        return;
    };
    current.status = "completed".to_owned();
    current.completed_at = item_timestamp_ms(last_item).or(Some(fallback_started_at));
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
        // Keep user events. They mark the actual user prompt when Codex also
        // records injected context as `response_item/message role=user`.
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
        && is_root_turn_marker(item)
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
        && is_root_turn_marker(item)
}

fn is_root_turn_marker(item: &Value) -> bool {
    let payload = codex_wrapped_item_payload(item).unwrap_or(item);
    codex_agent_path(payload)
        .or_else(|| codex_agent_path(item))
        .map_or(true, |agent_path| agent_path == "/root")
}

fn codex_agent_path(value: &Value) -> Option<String> {
    string_field(value, "agent_path").or_else(|| string_field(value, "agentPath"))
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

    use crate::runtime_work::transcript::transcript_messages;

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
    fn detects_inactive_turn_when_rollout_ends_with_assistant_message() {
        let path = temp_rollout_path("assistant-message-complete");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"user_message","message":"fix"}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"done"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}})
                    .to_string(),
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

        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["type"], "event_msg");
        assert_eq!(items[0]["payload"]["type"], "user_message");
        assert_eq!(items[1]["type"], "response_item");
        assert_eq!(items[1]["payload"]["role"], "user");
        assert_eq!(items[2]["type"], "response_item");
        assert_eq!(items[2]["payload"]["role"], "assistant");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rollout_transcript_hides_injected_context_user_response_items() {
        let path = temp_rollout_path("injected-context-user");
        fs::write(
            &path,
            [
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<environment_context>"}]}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect runtime"}]}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"inspect runtime"}})
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
        let messages = transcript_messages(&hydrated, "device-1");
        let user_messages = messages
            .iter()
            .filter(|message| message["role"] == "user")
            .collect::<Vec<_>>();

        assert_eq!(user_messages.len(), 1);
        assert_eq!(user_messages[0]["content"], "inspect runtime");
        assert!(!messages.iter().any(|message| {
            message["content"]
                .as_str()
                .is_some_and(|content| content.contains("AGENTS.md"))
        }));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rollout_transcript_uses_each_turn_iso_start_and_completion_times() {
        let path = temp_rollout_path("turn-iso-times");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","timestamp":"2026-06-29T07:27:08.936Z","payload":{"type":"task_started"}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:27:14.516Z","payload":{"type":"user_message","message":"first"}})
                    .to_string(),
                json!({"type":"response_item","timestamp":"2026-06-29T07:27:24.733Z","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"one"}]}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:27:24.812Z","payload":{"type":"task_complete"}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:29:39.701Z","payload":{"type":"task_started"}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:29:50.687Z","payload":{"type":"user_message","message":"second"}})
                    .to_string(),
                json!({"type":"response_item","timestamp":"2026-06-29T07:29:56.803Z","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"two"}]}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:29:56.820Z","payload":{"type":"task_complete"}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:41:44.833Z","payload":{"type":"task_started"}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:41:50.370Z","payload":{"type":"user_message","message":"third"}})
                    .to_string(),
                json!({"type":"response_item","timestamp":"2026-06-29T07:41:56.199Z","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"three"}]}})
                    .to_string(),
                json!({"type":"event_msg","timestamp":"2026-06-29T07:41:56.275Z","payload":{"type":"task_complete"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");
        let messages = transcript_messages(&hydrated, "device-1");
        let assistants = messages
            .iter()
            .filter(|message| message["role"] == "assistant")
            .collect::<Vec<_>>();

        assert_eq!(assistants.len(), 3);
        assert_eq!(assistants[0]["createdAt"], 1_782_718_028_936_i64);
        assert_eq!(assistants[0]["completedAt"], 1_782_718_044_812_i64);
        assert_eq!(assistants[1]["createdAt"], 1_782_718_179_701_i64);
        assert_eq!(assistants[1]["completedAt"], 1_782_718_196_820_i64);
        assert_eq!(assistants[2]["createdAt"], 1_782_718_904_833_i64);
        assert_eq!(assistants[2]["completedAt"], 1_782_718_916_275_i64);
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
    fn ignores_subagent_turn_completion_for_root_rollout_status() {
        let path = temp_rollout_path("subagent-complete");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"root-turn"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"spawn_agent"}})
                    .to_string(),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"child-turn","agent_path":"/root/worker"}})
                    .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let thread = thread_with_path(&path);
        let hydrated = thread_with_rollout_turns(&thread).expect("rollout should hydrate thread");

        assert_eq!(hydrated["turns"][0]["status"], "running");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ignores_subagent_rollout_message_items() {
        let path = temp_rollout_path("subagent-message");
        fs::write(
            &path,
            [
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"root-turn","agent_path":"/root"}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","agent_path":"/root/worker","content":[{"type":"output_text","text":"child"}]}})
                    .to_string(),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","agent_path":"/root","content":[{"type":"output_text","text":"root"}]}})
                    .to_string(),
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
        assert_eq!(items[1]["payload"]["content"][0]["text"], "root");
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

    #[test]
    fn rollout_context_usage_reads_latest_token_count_from_rollout_file() {
        let path = temp_rollout_path("context-usage");
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","model_context_window":258400}}),
                json!({"type":"event_msg","payload":{"type":"token_count","info":{
                    "total_token_usage":{
                        "input_tokens":12000,
                        "cached_input_tokens":4000,
                        "output_tokens":100,
                        "reasoning_output_tokens":0,
                        "total_tokens":12100
                    },
                    "last_token_usage":{
                        "input_tokens":12000,
                        "cached_input_tokens":4000,
                        "output_tokens":100,
                        "reasoning_output_tokens":0,
                        "total_tokens":12100
                    },
                    "model_context_window":258400
                }}}),
                json!({"type":"event_msg","payload":{"type":"token_count","info":{
                    "total_token_usage":{
                        "input_tokens":17000000,
                        "cached_input_tokens":0,
                        "output_tokens":200000,
                        "reasoning_output_tokens":0,
                        "total_tokens":17200000
                    },
                    "last_token_usage":{
                        "input_tokens":7000,
                        "cached_input_tokens":1000,
                        "output_tokens":1000,
                        "reasoning_output_tokens":0,
                        "total_tokens":8000
                    },
                    "model_context_window":258400
                }}})
            ),
        )
        .unwrap();

        let usage = rollout_context_usage(&thread_with_path(&path)).expect("context usage");

        assert_eq!(usage["total"]["totalTokens"], json!(17_200_000));
        assert_eq!(usage["last"]["totalTokens"], json!(8_000));
        assert_eq!(usage["modelContextWindow"], json!(258_400));
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
