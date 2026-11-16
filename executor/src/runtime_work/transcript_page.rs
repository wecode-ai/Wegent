// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

const MAX_TRANSCRIPT_PAGE_SIZE: usize = 200;

pub(crate) struct TranscriptPage {
    pub messages: Vec<Value>,
    pub range_start: usize,
    pub range_end: usize,
    pub has_more_before: bool,
    pub before_cursor: Option<String>,
    pub has_more_after: bool,
    pub after_cursor: Option<String>,
}

pub(crate) fn transcript_page(
    messages: Vec<Value>,
    limit: Option<usize>,
    before_cursor: Option<&str>,
    after_cursor: Option<&str>,
) -> TranscriptPage {
    let total = messages.len();
    let page_limit = limit
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_TRANSCRIPT_PAGE_SIZE))
        .unwrap_or(total);

    if before_cursor.is_none() {
        if let Some(start) = after_cursor
            .and_then(cursor_offset)
            .map(|offset| offset.min(total))
        {
            let end = start.saturating_add(page_limit).min(total);
            return TranscriptPage {
                messages: transcript_page_messages(&messages, start, end),
                range_start: start,
                range_end: end,
                has_more_before: false,
                before_cursor: None,
                has_more_after: end < total,
                after_cursor: Some(format!("offset:{end}")),
            };
        }
    }

    let end = before_cursor
        .and_then(cursor_offset)
        .map(|offset| offset.min(total))
        .unwrap_or(total);
    let start = end.saturating_sub(page_limit);
    let has_more_before = start > 0;
    TranscriptPage {
        messages: transcript_page_messages(&messages, start, end),
        range_start: start,
        range_end: end,
        has_more_before,
        before_cursor: has_more_before.then(|| format!("offset:{start}")),
        has_more_after: end < total,
        after_cursor: Some(format!("offset:{end}")),
    }
}

fn transcript_page_messages(messages: &[Value], start: usize, end: usize) -> Vec<Value> {
    messages[start..end]
        .iter()
        .enumerate()
        .map(|(index, message)| message_with_index(message, start + index))
        .collect()
}

fn message_with_index(message: &Value, message_index: usize) -> Value {
    let mut indexed_message = message.clone();
    if let Some(object) = indexed_message.as_object_mut() {
        object.insert("messageIndex".to_owned(), json!(message_index));
    }
    indexed_message
}

fn cursor_offset(cursor: &str) -> Option<usize> {
    cursor
        .trim()
        .strip_prefix("offset:")
        .and_then(|value| value.parse::<usize>().ok())
}
