// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader, Seek},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    transcript_search_projection::search_ranges,
    transcript_search_text::{codex_turn_search_regions, AsyncReplySearchProjection},
    util::{item_type, string_field},
};

#[cfg(test)]
use super::transcript_search_text::codex_turn_search_sources;

const CURSOR_PREFIX: &str = "wework-codex-legacy-search:";
const MAX_MATCHES: usize = 250;
const ITEM_RADIUS: usize = 50;

#[path = "codex_legacy_search/context.rs"]
mod context;

pub(super) use context::{
    load_legacy_context_page, load_legacy_search_match, parse_legacy_context_cursor,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacySearchCursor {
    turn_id: String,
    item_id: String,
    byte_offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reply_source_turn_id: Option<String>,
}

pub(super) fn is_legacy_search_cursor(cursor: &str) -> bool {
    cursor.starts_with(CURSOR_PREFIX)
}

pub(super) fn parse_legacy_search_cursor(
    cursor: &str,
) -> Result<Option<LegacySearchCursor>, String> {
    cursor
        .strip_prefix(CURSOR_PREFIX)
        .map(|encoded| {
            let cursor: LegacySearchCursor = serde_json::from_str(encoded)
                .map_err(|error| format!("Invalid legacy transcript search cursor: {error}"))?;
            if cursor.turn_id.is_empty() || cursor.item_id.is_empty() {
                return Err("Invalid legacy transcript search cursor bounds".to_owned());
            }
            Ok(cursor)
        })
        .transpose()
}

pub(super) async fn search_legacy_transcript(
    path: String,
    query: String,
    limit: usize,
    excluded_turn_ids: HashSet<String>,
    user_content_by_client_id: HashMap<String, String>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let file = File::open(path)
            .map_err(|error| format!("Cannot read legacy Codex history: {error}"))?;
        search_reader(
            BufReader::new(file),
            &query,
            limit,
            &excluded_turn_ids,
            &user_content_by_client_id,
        )
    })
    .await
    .map_err(|error| format!("Legacy transcript search worker failed: {error}"))?
}

fn search_reader(
    mut reader: impl BufRead + Seek,
    query: &str,
    limit: usize,
    excluded: &HashSet<String>,
    user_content_by_client_id: &HashMap<String, String>,
) -> Result<Value, String> {
    let needle = query.trim();
    let limit = limit.clamp(1, MAX_MATCHES);
    let mut matches = Vec::new();
    let mut total = 0usize;
    if !needle.is_empty() {
        let metadata = read_metadata(&mut reader)?;
        reader
            .rewind()
            .map_err(|error| format!("Cannot rewind legacy Codex history: {error}"))?;
        let mut reducer = LegacyProjection::new();
        reducer.capture_native = true;
        let mut selected_turn = None;
        let mut selected_items = Vec::new();
        let mut projection = AsyncReplySearchProjection::default();
        let query = LegacySearchQuery {
            needle,
            limit,
            user_content_by_client_id,
        };
        let mut append = |index: usize, items: &[ProjectedText]| {
            append_turn_matches(
                &metadata.turns[index],
                items,
                &query,
                &mut projection,
                &mut matches,
                &mut total,
            )
        };
        scan(reader, 0, |record, offset| {
            let result = reducer.handle(&record, offset);
            let Some(item) = result.item else {
                return Ok(true);
            };
            let Some(turn) = metadata.turns.get(item.turn_index) else {
                return Ok(true);
            };
            let replayed = &reducer.turns[item.turn_index];
            if excluded.contains(&turn.id)
                || turn.id != replayed.id
                || turn.first_text_offset != replayed.first_text_offset
            {
                return Ok(true);
            }
            if selected_turn != Some(item.turn_index) {
                if let Some(index) = selected_turn {
                    append(index, &selected_items)?;
                }
                selected_items.clear();
                selected_turn = Some(item.turn_index);
            }
            selected_items.push(item);
            Ok(true)
        })?;
        if let Some(index) = selected_turn {
            append(index, &selected_items)?;
        }
    }
    Ok(json!({
        "success": true,
        "totalMatches": total,
        "isCapped": total > matches.len(),
        "matches": matches,
    }))
}

fn read_metadata(reader: impl BufRead) -> Result<LegacyProjection, String> {
    let mut reducer = LegacyProjection::new();
    scan(reader, 0, |record, offset| {
        reducer.handle(&record, offset);
        Ok(true)
    })?;
    Ok(reducer)
}

struct LegacySearchQuery<'a> {
    needle: &'a str,
    limit: usize,
    user_content_by_client_id: &'a HashMap<String, String>,
}

fn append_turn_matches(
    turn: &TurnMetadata,
    items: &[ProjectedText],
    query: &LegacySearchQuery<'_>,
    projection: &mut AsyncReplySearchProjection,
    matches: &mut Vec<Value>,
    total: &mut usize,
) -> Result<(), String> {
    let native = turn.native_turn(items.iter().map(|item| item.native.clone()).collect());
    let by_id: HashMap<_, _> = items.iter().map(|item| (item.id.as_str(), item)).collect();
    for region in
        codex_turn_search_regions(&native, query.user_content_by_client_id, None, projection)
    {
        let Some(item) = by_id.get(region.id.as_str()) else {
            continue;
        };
        let ranges = search_ranges(&region.text, query.needle);
        *total = total.saturating_add(ranges.len());
        let cursor = LegacySearchCursor {
            turn_id: turn.id.clone(),
            item_id: region.id.clone(),
            byte_offset: item.byte_offset,
            reply_source_turn_id: projection.reply_source(&region.id).map(str::to_owned),
        };
        let encoded = serde_json::to_string(&cursor)
            .map_err(|error| format!("Cannot encode legacy search cursor: {error}"))?;
        for (occurrence, range) in ranges
            .into_iter()
            .take(query.limit.saturating_sub(matches.len()))
            .enumerate()
        {
            let mut matched = json!({
                "turnId": turn.id, "itemId": region.id, "regionId": region.id, "range":range,
                "occurrence": occurrence, "cursor": format!("{CURSOR_PREFIX}{encoded}"),
            });
            if item.user {
                matched["messageId"] = json!(item.client_id.as_ref().unwrap_or(&item.id));
                if let Some(questions) = projection.reply_questions(&item.id) {
                    matched["replyQuestions"] = json!(questions);
                }
            }
            matches.push(matched);
        }
    }
    Ok(())
}

/// Read one record at a time. A half-written final append is not a failed history.
fn scan(
    mut reader: impl BufRead,
    mut offset: u64,
    mut accept: impl FnMut(Value, u64) -> Result<bool, String>,
) -> Result<(), String> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| format!("Cannot read legacy rollout record: {error}"))?;
        if bytes == 0 {
            break;
        }
        let start = offset;
        offset = offset.saturating_add(bytes as u64);
        if line.trim().is_empty() {
            continue;
        }
        let record = match serde_json::from_str(&line) {
            Ok(record) => record,
            Err(error) if !line.ends_with('\n') && error.is_eof() => break,
            Err(error) => return Err(format!("Invalid legacy rollout record: {error}")),
        };
        if !accept(record, start)? {
            break;
        }
    }
    Ok(())
}

struct ProjectedText {
    turn_index: usize,
    id: String,
    client_id: Option<String>,
    user: bool,
    byte_offset: u64,
    native: Value,
}

#[derive(Default)]
struct Reduction {
    item: Option<ProjectedText>,
    rollback_from: Option<usize>,
}

struct TurnMetadata {
    id: String,
    explicit: bool,
    compacted: bool,
    item_ids: HashMap<String, usize>,
    item_count: usize,
    last_reasoning: bool,
    status: &'static str,
    error: Option<Value>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
    first_text_offset: Option<u64>,
    last_text_offset: Option<u64>,
}

impl TurnMetadata {
    fn native_turn(&self, items: Vec<Value>) -> Value {
        json!({
            "id": self.id, "items": items, "itemsView": "full",
            "status": self.status, "error": self.error,
            "startedAt": self.started_at, "completedAt": self.completed_at,
            "durationMs": self.duration_ms,
        })
    }
}

/// Mirrors Codex ThreadHistoryBuilder's legacy persistence projection. Retain only
/// ids/counters for rollback and late upserts; never retain historical item bodies.
struct LegacyProjection {
    turns: Vec<TurnMetadata>,
    by_id: HashMap<String, usize>,
    active: Option<usize>,
    rollout_index: u64,
    next_item_index: u64,
    current_rollout_index: u64,
    capture_native: bool,
}

impl LegacyProjection {
    fn new() -> Self {
        Self {
            turns: Vec::new(),
            by_id: HashMap::new(),
            active: None,
            rollout_index: 0,
            next_item_index: 1,
            current_rollout_index: 0,
            capture_native: false,
        }
    }

    fn open(&mut self, id: Option<String>, explicit: bool) -> usize {
        self.finish_current();
        let id = id.unwrap_or_else(|| format!("rollout-{}", self.current_rollout_index));
        let index = self.turns.len();
        self.by_id.insert(id.clone(), index);
        self.turns.push(TurnMetadata {
            id,
            explicit,
            compacted: false,
            item_ids: HashMap::new(),
            item_count: 0,
            last_reasoning: false,
            status: if explicit { "inProgress" } else { "completed" },
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            first_text_offset: None,
            last_text_offset: None,
        });
        self.active = Some(index);
        index
    }

    fn current(&mut self) -> usize {
        self.active.unwrap_or_else(|| self.open(None, false))
    }

    fn finish_current(&mut self) {
        if let Some(index) = self.active.take() {
            let turn = &self.turns[index];
            if index + 1 == self.turns.len()
                && turn.item_ids.is_empty()
                && !turn.explicit
                && !turn.compacted
            {
                let turn = self.turns.pop().expect("active turn exists");
                self.by_id.remove(&turn.id);
            }
        }
    }

    fn next_id(&mut self) -> String {
        let id = format!("item-{}", self.next_item_index);
        self.next_item_index = self.next_item_index.saturating_add(1);
        id
    }

    fn upsert(&mut self, id: String, turn_id: Option<&str>, reasoning: bool) -> Option<usize> {
        let index = match turn_id.filter(|id| !id.is_empty()) {
            Some(id) => *self.by_id.get(id)?,
            None => self.current(),
        };
        let turn = &mut self.turns[index];
        let position = *turn.item_ids.entry(id).or_insert_with(|| {
            let position = turn.item_count;
            turn.item_count += 1;
            position
        });
        if position + 1 == turn.item_count {
            turn.last_reasoning = reasoning;
        }
        Some(index)
    }

    fn push(&mut self, id: String, reasoning: bool) -> usize {
        let index = self.current();
        let turn = &mut self.turns[index];
        turn.item_ids.entry(id).or_insert(turn.item_count);
        turn.item_count += 1;
        turn.last_reasoning = reasoning;
        index
    }

    fn handle(&mut self, record: &Value, offset: u64) -> Reduction {
        if !legacy_persisted(record) {
            return Reduction::default();
        }
        self.current_rollout_index = self.rollout_index;
        self.rollout_index = self.rollout_index.saturating_add(1);
        let kind = string_field(record, "type").unwrap_or_default();
        if kind == "compacted" {
            let index = self.current();
            self.turns[index].compacted = true;
            return Reduction::default();
        }
        let Some(payload) = record.get("payload") else {
            return Reduction::default();
        };
        if kind == "response_item" {
            self.handle_response(payload);
            return Reduction::default();
        }
        if kind != "event_msg" {
            return Reduction::default();
        }
        match string_field(payload, "type").as_deref().unwrap_or_default() {
            "task_started" | "turn_started" => {
                self.finish_current();
                if let Some(id) = string_field(payload, "turn_id") {
                    let index = self.open(Some(id), true);
                    self.turns[index].started_at =
                        payload.get("started_at").and_then(Value::as_i64);
                }
            }
            "task_complete" | "turn_complete" => self.complete(payload, false),
            "turn_aborted" => self.complete(payload, true),
            "thread_rolled_back" => {
                self.finish_current();
                let remove = payload
                    .get("num_turns")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let retained = self.turns.len().saturating_sub(remove);
                for turn in self.turns.drain(retained..) {
                    self.by_id.remove(&turn.id);
                }
                self.next_item_index = self
                    .turns
                    .iter()
                    .map(|turn| turn.item_count as u64)
                    .sum::<u64>()
                    .saturating_add(1);
                return Reduction {
                    item: None,
                    rollback_from: Some(retained),
                };
            }
            "user_message" | "agent_message" => {
                return Reduction {
                    item: self.message(payload, offset),
                    rollback_from: None,
                };
            }
            "agent_reasoning" | "agent_reasoning_raw_content"
                if payload
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty()) =>
            {
                let index = self.current();
                if !self.turns[index].last_reasoning {
                    let id = self.next_id();
                    self.push(id, true);
                }
            }
            "context_compacted" => {
                let id = self.next_id();
                let index = self.push(id.clone(), false);
                return self.projected_event(index, id, payload.clone(), offset);
            }
            "entered_review_mode" | "exited_review_mode" => self.review(payload),
            "web_search_end" | "image_generation_end" => {
                if let Some(id) = string_field(payload, "call_id") {
                    if let Some(index) = self.upsert(id.clone(), None, false) {
                        return self.projected_event(index, id, payload.clone(), offset);
                    }
                }
            }
            "mcp_tool_call_end" | "patch_apply_end" => {
                if let Some(id) = string_field(payload, "call_id") {
                    let turn_id = string_field(payload, "turn_id");
                    if let Some(index) = self.upsert(id.clone(), turn_id.as_deref(), false) {
                        return self.projected_event(index, id, payload.clone(), offset);
                    }
                }
            }
            "sub_agent_activity" => {
                if let Some(id) = string_field(payload, "event_id") {
                    if let Some(index) = self.upsert(id.clone(), None, false) {
                        return self.projected_event(index, id, payload.clone(), offset);
                    }
                }
            }
            "item_completed" => return self.materialized(payload, offset),
            _ => {}
        }
        Reduction::default()
    }

    fn message(&mut self, payload: &Value, offset: u64) -> Option<ProjectedText> {
        let user = string_field(payload, "type").as_deref() == Some("user_message");
        let text = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if !user && text.is_empty() {
            return None;
        }
        if user
            && self.active.is_some_and(|index| {
                let turn = &self.turns[index];
                !(turn.explicit || turn.compacted && turn.item_ids.is_empty())
            })
        {
            self.finish_current();
        }
        let id = self.next_id();
        let index = self.push(id.clone(), false);
        self.turns[index].first_text_offset.get_or_insert(offset);
        self.turns[index].last_text_offset = Some(offset);
        let client_id = string_field(payload, "client_id");
        let mut native = if !self.capture_native {
            Value::Null
        } else if user {
            json!({"id": id, "type":"userMessage", "clientId":client_id, "content":user_inputs(payload)})
        } else {
            json!({"id": id, "type":"agentMessage", "text":text})
        };
        if !user && self.capture_native {
            for (raw, public) in [
                ("phase", "phase"),
                ("memory_citation", "memoryCitation"),
                ("delivery", "delivery"),
                ("questions", "questions"),
            ] {
                if let Some(value) = payload.get(raw) {
                    native[public] = value.clone();
                }
            }
        }
        Some(ProjectedText {
            turn_index: index,
            id,
            client_id,
            user,
            byte_offset: offset,
            native,
        })
    }

    fn complete(&mut self, payload: &Value, aborted: bool) {
        let explicit_id = string_field(payload, "turn_id");
        let target = explicit_id
            .as_ref()
            .and_then(|id| self.by_id.get(id).copied())
            .or(self.active);
        if let Some(index) = target {
            let turn = &mut self.turns[index];
            if aborted {
                turn.status = "interrupted";
            } else if payload.get("error").is_some_and(|error| !error.is_null()) {
                turn.status = "failed";
                turn.error = payload.get("error").cloned();
            } else if matches!(turn.status, "completed" | "inProgress") {
                turn.status = "completed";
            }
            turn.completed_at = payload.get("completed_at").and_then(Value::as_i64);
            turn.duration_ms = payload.get("duration_ms").and_then(Value::as_i64);
            if !aborted && self.active == Some(index) {
                self.finish_current();
            }
        }
    }

    fn review(&mut self, payload: &Value) {
        let id = string_field(payload, "item_id").unwrap_or_else(|| self.next_id());
        let turn_id = string_field(payload, "turn_id");
        if let Some(turn_id) = turn_id.as_ref() {
            if !self.by_id.contains_key(turn_id) {
                self.open(Some(turn_id.clone()), false);
            }
        }
        self.upsert(id, turn_id.as_deref(), false);
    }

    fn materialized(&mut self, payload: &Value, offset: u64) -> Reduction {
        let Some(item) = payload.get("item") else {
            return Reduction::default();
        };
        if item_type(item) == "plan"
            && item
                .get("text")
                .and_then(Value::as_str)
                .map_or(true, str::is_empty)
        {
            return Reduction::default();
        }
        let Some(id) = string_field(item, "id") else {
            return Reduction::default();
        };
        let turn_id = string_field(payload, "turn_id");
        let Some(index) = self.upsert(id.clone(), turn_id.as_deref(), false) else {
            return Reduction::default();
        };
        self.projected_event(index, id, item.clone(), offset)
    }

    /// Keep persisted process items in both search and context hydration. The
    /// existing transcript projector decides whether each item is visible.
    fn projected_event(
        &mut self,
        index: usize,
        id: String,
        mut native: Value,
        offset: u64,
    ) -> Reduction {
        self.turns[index].first_text_offset.get_or_insert(offset);
        self.turns[index].last_text_offset = Some(offset);
        if self.capture_native {
            native["id"] = json!(id);
        } else {
            native = Value::Null;
        }
        Reduction {
            item: Some(ProjectedText {
                turn_index: index,
                id,
                client_id: None,
                user: false,
                byte_offset: offset,
                native,
            }),
            rollback_from: None,
        }
    }

    fn handle_response(&mut self, payload: &Value) {
        let payload = payload.get("item").unwrap_or(payload);
        if item_type(payload) != "message"
            || string_field(payload, "role").as_deref() != Some("user")
        {
            return;
        }
        let hook = payload
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                !parts.is_empty()
                    && parts.iter().all(|part| {
                        let text = part
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim();
                        item_type(part) == "inputtext" && hook_prompt_fragment(text)
                    })
            });
        if hook {
            let id = string_field(payload, "id")
                .unwrap_or_else(|| format!("hook-{}", self.current_rollout_index));
            self.push(id, false);
        }
    }
}

/// Codex writes hook prompts as XML containing escaped text and one run id.
fn hook_prompt_fragment(text: &str) -> bool {
    static HOOK: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = HOOK.get_or_init(|| {
        regex::Regex::new(
            r#"^<hook_prompt\s+hook_run_id\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>[^<]+</hook_prompt>$"#,
        )
        .expect("valid hook prompt expression")
    });
    pattern.captures(text).is_some_and(|captures| {
        captures
            .get(1)
            .or_else(|| captures.get(2))
            .is_some_and(|id| !id.as_str().trim().is_empty())
    })
}

fn user_inputs(payload: &Value) -> Vec<Value> {
    let values = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut content = Vec::new();
    if let Some(text) = payload
        .get("message")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        content.push(json!({"type":"text", "text":text,
            "text_elements":payload.get("text_elements").cloned().unwrap_or_else(|| json!([]))}));
    }
    let images = values("images");
    let files = values("file_ids");
    let order = values("image_order");
    let image_details = values("image_details");
    let file_details = values("file_id_details");
    let complete_order = !order.is_empty()
        && order.len() == images.len() + files.len()
        && order
            .iter()
            .filter(|kind| kind.as_str() == Some("inline"))
            .count()
            == images.len()
        && order
            .iter()
            .filter(|kind| kind.as_str() == Some("file"))
            .count()
            == files.len();
    let order = if complete_order {
        order
    } else {
        images
            .iter()
            .map(|_| json!("inline"))
            .chain(files.iter().map(|_| json!("file")))
            .collect()
    };
    let (mut image_index, mut file_index) = (0, 0);
    for kind in order {
        if kind.as_str() == Some("inline") {
            content.push(json!({"type":"image", "url":images[image_index], "detail":image_details.get(image_index)}));
            image_index += 1;
        } else {
            content.push(json!({"type":"image", "fileId":files[file_index], "detail":file_details.get(file_index)}));
            file_index += 1;
        }
    }
    let local_details = values("local_image_details");
    for (index, path) in values("local_images").iter().enumerate() {
        content.push(json!({"type":"localImage", "path":path, "detail":local_details.get(index)}));
    }
    for url in values("audio") {
        content.push(json!({"type":"audio", "url":url}));
    }
    for path in values("local_audio") {
        content.push(json!({"type":"localAudio", "path":path}));
    }
    content
}

/// Match codex-rollout's legacy persistence policy before counting synthetic ids.
fn legacy_persisted(record: &Value) -> bool {
    match string_field(record, "type").as_deref().unwrap_or_default() {
        "realtime_item" => false,
        "response_item" => {
            let payload = record.get("payload").unwrap_or(&Value::Null);
            let payload = payload.get("item").unwrap_or(payload);
            matches!(
                item_type(payload).as_str(),
                "message"
                    | "agentmessage"
                    | "reasoning"
                    | "localshellcall"
                    | "functioncall"
                    | "toolsearchcall"
                    | "functioncalloutput"
                    | "toolsearchoutput"
                    | "customtoolcall"
                    | "customtoolcalloutput"
                    | "websearchcall"
                    | "imagegenerationcall"
                    | "configurationupdate"
                    | "compaction"
                    | "contextcompaction"
            )
        }
        "event_msg" => {
            let payload = record.get("payload").unwrap_or(&Value::Null);
            match string_field(payload, "type").as_deref().unwrap_or_default() {
                "user_message"
                | "agent_message"
                | "agent_reasoning"
                | "agent_reasoning_raw_content"
                | "entered_review_mode"
                | "exited_review_mode"
                | "patch_apply_end"
                | "context_compacted"
                | "mcp_tool_call_end"
                | "web_search_end"
                | "image_generation_end"
                | "token_count"
                | "thread_goal_updated"
                | "thread_rolled_back"
                | "turn_aborted"
                | "task_started"
                | "turn_started"
                | "task_complete"
                | "turn_complete"
                | "thread_settings_applied" => true,
                "sub_agent_activity" => {
                    string_field(payload, "kind").as_deref() != Some("completed")
                }
                "item_completed" => payload.get("item").is_some_and(|item| {
                    matches!(item_type(item).as_str(), "functioncalloutput" | "plan")
                        || (item_type(item) == "extension"
                            && string_field(item, "kind").as_deref() == Some("clock.sleep"))
                        || (item_type(item) == "subagentactivity"
                            && string_field(item, "kind").as_deref() == Some("completed"))
                }),
                _ => false,
            }
        }
        "compacted"
        | "turn_context"
        | "token_usage_record"
        | "world_state"
        | "retained_context"
        | "security_risk_score"
        | "session_meta"
        | "inter_agent_communication"
        | "inter_agent_communication_metadata" => true,
        _ => false,
    }
}

#[cfg(test)]
#[path = "codex_legacy_search_tests.rs"]
mod tests;
