// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::VecDeque;

use super::*;
use crate::runtime_work::codex_transcript_page::{CodexTranscriptDirection, CodexTranscriptPage};

const CONTEXT_CURSOR_PREFIX: &str = "wework-codex-legacy-context:";
const CONTEXT_PAGE_SIZE: usize = ITEM_RADIUS * 2;

pub(in super::super) fn parse_legacy_context_cursor(
    cursor: &str,
) -> Result<Option<LegacySearchCursor>, String> {
    cursor
        .strip_prefix(CONTEXT_CURSOR_PREFIX)
        .map(|encoded| parse_legacy_search_cursor(&format!("{CURSOR_PREFIX}{encoded}")))
        .transpose()
        .map(Option::flatten)
}

pub(in super::super) async fn load_legacy_search_match(
    thread: Value,
    cursor: LegacySearchCursor,
) -> Result<CodexTranscriptPage, String> {
    load_legacy_page(thread, cursor, None, 3).await
}

pub(in super::super) async fn load_legacy_context_page(
    thread: Value,
    cursor: LegacySearchCursor,
    direction: CodexTranscriptDirection,
    limit: usize,
) -> Result<CodexTranscriptPage, String> {
    load_legacy_page(thread, cursor, Some(direction), limit).await
}

async fn load_legacy_page(
    mut thread: Value,
    cursor: LegacySearchCursor,
    direction: Option<CodexTranscriptDirection>,
    limit: usize,
) -> Result<CodexTranscriptPage, String> {
    let path = string_field(&thread, "path")
        .ok_or_else(|| "Legacy Codex history has no rollout path".to_owned())?;
    tokio::task::spawn_blocking(move || {
        let file = File::open(path)
            .map_err(|error| format!("Cannot read legacy Codex history: {error}"))?;
        let mut page = hydrate_context_reader(BufReader::new(file), &cursor, direction, limit)?;
        thread["turns"] = page.thread["turns"].take();
        page.thread = thread;
        Ok(page)
    })
    .await
    .map_err(|error| format!("Legacy transcript loading worker failed: {error}"))?
}

struct ContextItem {
    turn_index: usize,
    cursor: LegacySearchCursor,
    native: Value,
}

struct ContextWindow {
    items: VecDeque<ContextItem>,
    anchor_turn: Option<usize>,
    direction: Option<CodexTranscriptDirection>,
    turn_limit: usize,
    capture_native: bool,
    complete_anchor_turn: Option<usize>,
    complete_start_turn: Option<usize>,
}

impl ContextWindow {
    fn new(
        direction: Option<CodexTranscriptDirection>,
        turn_limit: usize,
        complete_anchor_turn: Option<usize>,
        complete_start_turn: Option<usize>,
    ) -> Self {
        Self {
            items: VecDeque::new(),
            anchor_turn: None,
            direction,
            turn_limit: turn_limit.clamp(1, 5),
            capture_native: direction != Some(CodexTranscriptDirection::Ascending),
            complete_anchor_turn,
            complete_start_turn,
        }
    }

    fn rollback(&mut self, retained: usize, anchor_offset: u64) -> Result<(), String> {
        if self.anchor_turn.is_some_and(|index| index >= retained) {
            return Err("Legacy transcript search match is no longer available".to_owned());
        }
        self.items.retain(|item| item.turn_index < retained);
        self.capture_native = match (self.direction, self.anchor_turn) {
            (Some(CodexTranscriptDirection::Ascending), None) => false,
            (Some(CodexTranscriptDirection::Descending), Some(_)) => false,
            (Some(CodexTranscriptDirection::Ascending), Some(_)) => {
                self.items.len() < CONTEXT_PAGE_SIZE
            }
            (None, Some(_)) => self.after_count(anchor_offset) < ITEM_RADIUS,
            (_, None) => true,
        };
        Ok(())
    }

    fn after_count(&self, offset: u64) -> usize {
        self.items
            .iter()
            .filter(|item| {
                item.cursor.byte_offset > offset
                    && Some(item.turn_index) != self.complete_anchor_turn
            })
            .count()
    }

    fn select_anchor(&mut self, item: ContextItem) {
        self.anchor_turn = Some(item.turn_index);
        match self.direction {
            None => {
                self.items.retain(|previous| {
                    previous.turn_index
                        >= self
                            .complete_start_turn
                            .unwrap_or(item.turn_index)
                            .min(item.turn_index.saturating_sub(1))
                });
                self.items.push_back(item);
            }
            Some(CodexTranscriptDirection::Descending) => {
                self.retain_recent_turns();
                self.capture_native = false;
            }
            Some(CodexTranscriptDirection::Ascending) => self.capture_native = true,
        }
    }

    fn retain_recent_turns(&mut self) {
        let mut selected = HashSet::new();
        for item in self.items.iter().rev() {
            if !selected.contains(&item.turn_index) && selected.len() >= self.turn_limit {
                break;
            }
            selected.insert(item.turn_index);
        }
        self.items
            .retain(|item| selected.contains(&item.turn_index));
    }

    fn capture(&mut self, item: ContextItem, anchor_offset: u64) {
        if !self.capture_native {
            return;
        }
        if let Some(anchor_turn) = self.anchor_turn {
            let within_turns = if self.direction.is_none() {
                item.turn_index <= anchor_turn.saturating_add(1)
            } else {
                self.items
                    .back()
                    .is_some_and(|last| last.turn_index == item.turn_index)
                    || self
                        .items
                        .iter()
                        .map(|item| item.turn_index)
                        .collect::<HashSet<_>>()
                        .len()
                        < self.turn_limit
            };
            if !within_turns {
                self.capture_native = false;
                return;
            }
            self.items.push_back(item);
            self.capture_native = if self.direction.is_none() {
                self.items
                    .back()
                    .is_some_and(|last| Some(last.turn_index) == self.complete_anchor_turn)
                    || self.after_count(anchor_offset) < ITEM_RADIUS
            } else {
                self.items.len() < CONTEXT_PAGE_SIZE
            };
        } else {
            let complete_anchor_item = self
                .complete_start_turn
                .zip(self.complete_anchor_turn)
                .is_some_and(|(start, end)| (start..=end).contains(&item.turn_index));
            self.items.push_back(item);
            let maximum = if self.direction.is_none() {
                ITEM_RADIUS
            } else {
                CONTEXT_PAGE_SIZE
            };
            if !complete_anchor_item && self.items.len() > maximum {
                self.items.pop_front();
            }
        }
    }
}

pub(super) fn hydrate_context_reader(
    mut reader: impl BufRead + Seek,
    cursor: &LegacySearchCursor,
    direction: Option<CodexTranscriptDirection>,
    turn_limit: usize,
) -> Result<CodexTranscriptPage, String> {
    let (complete_start_turn, complete_anchor_turn) = if direction.is_none() {
        complete_turn_range(&mut reader, cursor)?
    } else {
        (None, None)
    };
    let mut reducer = LegacyProjection::new();
    let mut window = ContextWindow::new(
        direction,
        turn_limit,
        complete_anchor_turn,
        complete_start_turn,
    );
    scan(reader, 0, |record, offset| {
        reducer.capture_native = window.capture_native;
        let result = reducer.handle(&record, offset);
        if let Some(retained) = result.rollback_from {
            window.rollback(retained, cursor.byte_offset)?;
        }
        if let Some(item) = result.item {
            let turn = &reducer.turns[item.turn_index];
            let selected = offset == cursor.byte_offset
                && item.id == cursor.item_id
                && turn.id == cursor.turn_id;
            let item = ContextItem {
                turn_index: item.turn_index,
                cursor: LegacySearchCursor {
                    turn_id: turn.id.clone(),
                    item_id: item.id,
                    byte_offset: offset,
                    reply_source_turn_id: None,
                },
                native: item.native,
            };
            if selected {
                window.select_anchor(item);
            } else {
                window.capture(item, cursor.byte_offset);
            }
        }
        // Scan lightweight metadata through EOF to retain late completions and
        // reject stale anchors even when a rollback follows the bounded window.
        Ok(true)
    })?;
    let index = window
        .anchor_turn
        .ok_or_else(|| "Legacy transcript search match is no longer available".to_owned())?;
    let turn = &reducer.turns[index];
    if turn.id != cursor.turn_id || !turn.item_ids.contains_key(&cursor.item_id) {
        return Err("Legacy transcript search match is no longer available".to_owned());
    }
    context_page(&reducer, window)
}

fn complete_turn_range(
    reader: &mut (impl BufRead + Seek),
    cursor: &LegacySearchCursor,
) -> Result<(Option<usize>, Option<usize>), String> {
    let metadata = read_metadata(&mut *reader)?;
    reader
        .rewind()
        .map_err(|error| format!("Cannot rewind legacy Codex history: {error}"))?;
    // Every anchor needs the complete projection. A distant final fragment can
    // make a same-text process block visible even when the turn completed.
    let anchor = metadata.turns.iter().position(|turn| {
        turn.id == cursor.turn_id
            && turn.item_ids.contains_key(&cursor.item_id)
            && turn
                .first_text_offset
                .is_some_and(|offset| offset <= cursor.byte_offset)
            && turn
                .last_text_offset
                .is_some_and(|offset| offset >= cursor.byte_offset)
    });
    let start = if let Some(source_id) = cursor.reply_source_turn_id.as_deref() {
        let source = metadata
            .turns
            .iter()
            .position(|turn| turn.id == source_id)
            .filter(|index| anchor.is_some_and(|anchor| *index <= anchor))
            .ok_or_else(|| "Legacy async question source is no longer available".to_owned())?;
        Some(source)
    } else {
        anchor
    };
    Ok((start, anchor))
}

fn context_page(
    reducer: &LegacyProjection,
    window: ContextWindow,
) -> Result<CodexTranscriptPage, String> {
    let before_cursor = context_boundary(reducer, window.items.front(), true)?;
    let after_cursor = context_boundary(reducer, window.items.back(), false)?;
    let mut turns = Vec::<Value>::new();
    let mut prepend_item_turn_ids = HashSet::new();
    for item in window.items {
        let metadata = &reducer.turns[item.turn_index];
        if turns.last().and_then(|turn| turn["id"].as_str()) != Some(metadata.id.as_str()) {
            turns.push(metadata.native_turn(Vec::new()));
            if window.direction == Some(CodexTranscriptDirection::Descending) {
                prepend_item_turn_ids.insert(metadata.id.clone());
            }
        }
        turns.last_mut().expect("context turn exists")["items"]
            .as_array_mut()
            .expect("context items are an array")
            .push(item.native);
    }
    Ok(CodexTranscriptPage {
        thread: json!({"turns": turns}),
        before_cursor,
        after_cursor,
        prepend_item_turn_ids,
    })
}

fn context_boundary(
    reducer: &LegacyProjection,
    item: Option<&ContextItem>,
    before: bool,
) -> Result<Option<String>, String> {
    let Some(item) = item else {
        return Ok(None);
    };
    let has_more = reducer.turns.iter().any(|turn| {
        if before {
            turn.first_text_offset
                .is_some_and(|offset| offset < item.cursor.byte_offset)
        } else {
            turn.last_text_offset
                .is_some_and(|offset| offset > item.cursor.byte_offset)
        }
    });
    has_more
        .then(|| {
            serde_json::to_string(&item.cursor)
                .map(|encoded| format!("{CONTEXT_CURSOR_PREFIX}{encoded}"))
                .map_err(|error| format!("Cannot encode legacy context cursor: {error}"))
        })
        .transpose()
}
