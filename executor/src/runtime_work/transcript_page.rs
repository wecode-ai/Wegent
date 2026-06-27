// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

const MAX_TRANSCRIPT_PAGE_SIZE: usize = 200;

pub(crate) struct TranscriptPage {
    pub messages: Vec<Value>,
    pub has_more_before: bool,
    pub before_cursor: Option<String>,
}

pub(crate) fn transcript_page(
    messages: Vec<Value>,
    limit: Option<usize>,
    before_cursor: Option<&str>,
) -> TranscriptPage {
    let total = messages.len();
    let end = before_cursor
        .and_then(cursor_offset)
        .map(|offset| offset.min(total))
        .unwrap_or(total);
    let page_limit = limit
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_TRANSCRIPT_PAGE_SIZE))
        .unwrap_or(total);
    let start = end.saturating_sub(page_limit);
    let has_more_before = start > 0;
    let page_messages = messages[start..end].to_vec();

    TranscriptPage {
        messages: page_messages,
        has_more_before,
        before_cursor: has_more_before.then(|| format!("offset:{start}")),
    }
}

fn cursor_offset(cursor: &str) -> Option<usize> {
    cursor
        .trim()
        .strip_prefix("offset:")
        .and_then(|value| value.parse::<usize>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transcript_page_returns_latest_messages_by_default() {
        let page = transcript_page(
            vec![json!({"id": "1"}), json!({"id": "2"}), json!({"id": "3"})],
            Some(2),
            None,
        );

        assert_eq!(page.messages, vec![json!({"id": "2"}), json!({"id": "3"})]);
        assert!(page.has_more_before);
        assert_eq!(page.before_cursor.as_deref(), Some("offset:1"));
    }

    #[test]
    fn transcript_page_loads_messages_before_cursor() {
        let page = transcript_page(
            vec![
                json!({"id": "1"}),
                json!({"id": "2"}),
                json!({"id": "3"}),
                json!({"id": "4"}),
            ],
            Some(2),
            Some("offset:3"),
        );

        assert_eq!(page.messages, vec![json!({"id": "2"}), json!({"id": "3"})]);
        assert!(page.has_more_before);
        assert_eq!(page.before_cursor.as_deref(), Some("offset:1"));
    }
}
