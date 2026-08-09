// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use futures_util::{stream, StreamExt};
use serde_json::{json, Value};

use crate::agents::CodexAppServerClient;

use super::util::string_field;

const CODEX_ITEM_PAGE_SIZE: usize = 100;
const CODEX_ITEM_LOAD_CONCURRENCY: usize = 5;

pub(crate) struct CodexTranscriptRequest<'a> {
    pub thread_id: &'a str,
    pub cursor: Option<&'a str>,
    pub limit: usize,
    pub full_content: bool,
}

pub(crate) struct CodexTranscriptPage {
    pub thread: Value,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
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
        .unwrap_or(&metadata_response)
        .clone();
    let paginated = string_field(&thread, "historyMode").as_deref() == Some("paginated");
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
            paginated,
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
        if paginated {
            page_turns = load_full_turn_items(client, request.thread_id, page_turns).await?;
        }
        turns.extend(page_turns);

        let next_cursor = string_field(&page, "nextCursor");
        if !request.full_content || next_cursor.is_none() {
            turns.reverse();
            thread["turns"] = Value::Array(turns);
            return Ok(CodexTranscriptPage {
                thread,
                next_cursor,
                backwards_cursor,
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
    paginated: bool,
) -> Result<Value, String> {
    client
        .request(
            "thread/turns/list",
            json!({
                "threadId": thread_id,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": "desc",
                "itemsView": if paginated { "notLoaded" } else { "full" },
            }),
        )
        .await
}

async fn load_full_turn_items(
    client: &CodexAppServerClient,
    thread_id: &str,
    turns: Vec<Value>,
) -> Result<Vec<Value>, String> {
    stream::iter(turns.into_iter().map(|turn| {
        let client = client.clone();
        async move {
            let turn_id = string_field(&turn, "id")
                .ok_or_else(|| "thread/turns/list returned a turn without id".to_owned())?;
            let items = load_turn_items(&client, thread_id, &turn_id).await?;
            let mut turn = turn;
            turn["items"] = Value::Array(items);
            turn["itemsView"] = Value::String("full".to_owned());
            Ok::<Value, String>(turn)
        }
    }))
    .buffered(CODEX_ITEM_LOAD_CONCURRENCY)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect()
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
