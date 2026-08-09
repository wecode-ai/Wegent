// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use futures_util::{stream, TryStreamExt};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;

use super::util::string_field;

const CODEX_ITEM_PAGE_SIZE: usize = 100;
const CODEX_ITEM_LOAD_CONCURRENCY: usize = 5;
const CODEX_FULL_TRANSCRIPT_MAX_TURNS: usize = 500;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CodexTranscriptDirection {
    Ascending,
    Descending,
}

impl CodexTranscriptDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ascending => "asc",
            Self::Descending => "desc",
        }
    }
}

pub(crate) struct CodexTranscriptRequest<'a> {
    pub thread_id: &'a str,
    pub cursor: Option<&'a str>,
    pub limit: usize,
    pub direction: CodexTranscriptDirection,
    pub full_content: bool,
}

pub(crate) struct CodexTranscriptPage {
    pub thread: Value,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
}

pub(crate) async fn load_codex_transcript(
    client: &CodexAppServerClient,
    request: CodexTranscriptRequest<'_>,
) -> Result<CodexTranscriptPage, String> {
    let metadata_response = client
        .request(
            "thread/read",
            json!({"threadId": request.thread_id, "includeTurns": false}),
        )
        .await?;
    let mut thread = metadata_response
        .get("thread")
        .cloned()
        .ok_or_else(|| "thread/read returned a response without thread".to_owned())?;
    if !thread.is_object() {
        return Err("thread/read returned a non-object thread".to_owned());
    }
    let paginated_history = thread_uses_paginated_history(&thread);
    let mut cursor = request.cursor.map(ToOwned::to_owned);
    let mut turns = Vec::new();
    let mut backwards_cursor = None;
    let mut seen_cursors = HashSet::new();
    if let Some(cursor) = cursor.as_ref() {
        seen_cursors.insert(cursor.clone());
    }

    loop {
        let page = load_turn_page(
            client,
            request.thread_id,
            cursor.as_deref(),
            request.limit,
            request.direction,
            paginated_history,
        )
        .await?;
        if backwards_cursor.is_none() {
            backwards_cursor = string_field(&page, "backwardsCursor");
        }
        let mut page_turns = page
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if paginated_history {
            page_turns = load_full_turn_items(client, request.thread_id, page_turns).await?;
        }
        turns.extend(page_turns);

        let next_cursor = string_field(&page, "nextCursor");
        let reached_full_content_limit =
            request.full_content && turns.len() >= CODEX_FULL_TRANSCRIPT_MAX_TURNS;
        if !request.full_content || next_cursor.is_none() || reached_full_content_limit {
            if reached_full_content_limit && next_cursor.is_some() {
                turns.truncate(CODEX_FULL_TRANSCRIPT_MAX_TURNS);
                eprintln!(
                    "Codex transcript {thread_id} truncated at {max_turns} turns",
                    thread_id = request.thread_id,
                    max_turns = CODEX_FULL_TRANSCRIPT_MAX_TURNS,
                );
            }
            if request.direction == CodexTranscriptDirection::Descending {
                turns.reverse();
            }
            thread["turns"] = Value::Array(turns);
            let (before_cursor, after_cursor) =
                if request.direction == CodexTranscriptDirection::Descending {
                    (next_cursor, backwards_cursor)
                } else {
                    (backwards_cursor, next_cursor)
                };
            return Ok(CodexTranscriptPage {
                thread,
                before_cursor,
                after_cursor,
            });
        }
        let next_cursor = next_cursor.expect("checked above");
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("thread/turns/list returned a repeated cursor".to_owned());
        }
        cursor = Some(next_cursor);
    }
}

async fn load_turn_page(
    client: &CodexAppServerClient,
    thread_id: &str,
    cursor: Option<&str>,
    limit: usize,
    direction: CodexTranscriptDirection,
    paginated_history: bool,
) -> Result<Value, String> {
    client
        .request(
            "thread/turns/list",
            json!({
                "threadId": thread_id,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": direction.as_str(),
                "itemsView": turn_items_view(paginated_history),
            }),
        )
        .await
}

fn thread_uses_paginated_history(thread: &Value) -> bool {
    string_field(thread, "historyMode").as_deref() == Some("paginated")
}

fn turn_items_view(paginated_history: bool) -> &'static str {
    if paginated_history {
        "notLoaded"
    } else {
        "full"
    }
}

async fn load_full_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    turns: Vec<Value>,
) -> Result<Vec<Value>, String> {
    stream::iter(turns.into_iter().map(|turn| {
        let client = client.clone();
        Ok::<_, String>(async move {
            let turn_id = string_field(&turn, "id")
                .ok_or_else(|| "thread/turns/list returned a turn without id".to_owned())?;
            let items = load_turn_items(&client, thread_id, &turn_id).await?;
            let mut turn = turn;
            turn["items"] = Value::Array(items);
            turn["itemsView"] = Value::String("full".to_owned());
            Ok::<Value, String>(turn)
        })
    }))
    .try_buffered(CODEX_ITEM_LOAD_CONCURRENCY)
    .try_collect()
    .await
}

async fn load_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    turn_id: &str,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();

    loop {
        let response = client
            .request(
                "thread/items/list",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "cursor": cursor,
                    "limit": CODEX_ITEM_PAGE_SIZE,
                    "sortDirection": "asc",
                }),
            )
            .await?;
        for entry in response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if string_field(entry, "turnId").as_deref() != Some(turn_id) {
                return Err(format!(
                    "thread/items/list returned an item for a different turn than {turn_id}"
                ));
            }
            let item = entry
                .get("item")
                .cloned()
                .ok_or_else(|| "thread/items/list returned an entry without item".to_owned())?;
            items.push(item);
        }

        let next_cursor = string_field(&response, "nextCursor");
        let Some(next_cursor) = next_cursor else {
            return Ok(items);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(format!(
                "thread/items/list returned a repeated cursor for turn {turn_id}"
            ));
        }
        cursor = Some(next_cursor);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{thread_uses_paginated_history, turn_items_view};

    #[test]
    fn detects_paginated_thread_history() {
        assert!(thread_uses_paginated_history(
            &json!({"historyMode": "paginated"})
        ));
    }

    #[test]
    fn treats_legacy_and_missing_history_modes_as_non_paginated() {
        assert!(!thread_uses_paginated_history(
            &json!({"historyMode": "legacy"})
        ));
        assert!(!thread_uses_paginated_history(&json!({})));
    }

    #[test]
    fn requests_items_only_for_paginated_thread_history() {
        assert_eq!(turn_items_view(true), "notLoaded");
        assert_eq!(turn_items_view(false), "full");
    }
}
