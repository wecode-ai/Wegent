//! Read authoritative invocation records without materializing the whole conversation.
use super::*;

fn matching_item(entry: &Value, call_id: &str, turn_id: Option<&str>) -> Option<Value> {
    let item = &entry["item"];
    (item["id"] == call_id
        && item["type"] == "mcpToolCall"
        && turn_id.map_or(true, |turn_id| entry["turnId"] == turn_id))
    .then(|| item.clone())
}

impl RuntimeWorkRpcHandler {
    async fn mcp_app_source_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, AppIpcError> {
        let started = std::time::Instant::now();
        let result = self.call_codex_thread_method(method, params).await;
        if started.elapsed().as_millis() >= 250 {
            crate::logging::log_executor_event(
                "MCP App source read slow",
                &[
                    ("method", method.to_string()),
                    ("elapsed_ms", started.elapsed().as_millis().to_string()),
                ],
            );
        }
        result.map_err(|_| AppIpcError::new("mcp_app_denied", "Cannot read source invocation"))
    }

    pub(super) async fn mcp_app_source(
        &self,
        thread_id: &str,
        call_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(Value, Option<Value>), AppIpcError> {
        let read = self
            .mcp_app_source_request(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
            )
            .await?;
        if read["thread"]["historyMode"] != "paginated" {
            let read = self
                .mcp_app_source_request(
                    "thread/read",
                    json!({"threadId":thread_id,"includeTurns":true}),
                )
                .await?;
            let source = super::mcp_apps::source_call(&read["thread"], call_id, turn_id).cloned();
            return Ok((read, source));
        }
        let source = self
            .mcp_app_paginated_source(thread_id, call_id, turn_id)
            .await?;
        Ok((read, source))
    }

    async fn mcp_app_paginated_source(
        &self,
        thread_id: &str,
        call_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Option<Value>, AppIpcError> {
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        loop {
            let (method, params) = match turn_id {
                Some(turn_id) => (
                    "thread/items/read",
                    json!({
                        "threadId":thread_id,"turnId":turn_id,"itemIds":[call_id]
                    }),
                ),
                None => (
                    "thread/items/list",
                    json!({
                        "threadId":thread_id,"limit":100,"sortDirection":"desc","cursor":cursor
                    }),
                ),
            };
            let page = self.mcp_app_source_request(method, params).await?;
            if let Some(source) = page["data"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|entry| matching_item(entry, call_id, turn_id))
            {
                return Ok(Some(source));
            }
            if turn_id.is_some() || page["nextCursor"].is_null() {
                return Ok(None);
            }
            let next = page["nextCursor"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppIpcError::new("mcp_app_denied", "Invalid invocation cursor"))?;
            if !seen.insert(next.to_string()) {
                return Err(AppIpcError::new(
                    "mcp_app_denied",
                    "Repeated invocation cursor",
                ));
            }
            cursor = Some(next.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{install_native_history, isolated_runtime_work_handler};
    use super::*;

    #[tokio::test]
    async fn mcp_app_paginated_source_reads_only_the_requested_invocation() {
        let (mut handler, root) = isolated_runtime_work_handler("mcp-source-targeted");
        install_native_history(&mut handler, &root, vec![], None);
        let source = json!({"id":"call","type":"mcpToolCall","server":"counter"});
        fs::write(
            root.join("thread_items_read.json"),
            json!({
                "data":[{"turnId":"turn","item":source}]
            })
            .to_string(),
        )
        .unwrap();
        let (read, found) = handler
            .mcp_app_source("thread-1", "call", Some("turn"))
            .await
            .unwrap();
        assert_eq!(read["thread"]["historyMode"], "paginated");
        assert_eq!(found, Some(source));
        assert!(handler
            .mcp_app_source("thread-1", "call", Some("foreign-turn"))
            .await
            .unwrap()
            .1
            .is_none());
        fs::write(
            root.join("thread_items_list.json"),
            json!({
                "data":[{"turnId":"turn","item":{"id":"older","type":"mcpToolCall"}}],
                "nextCursor":null
            })
            .to_string(),
        )
        .unwrap();
        assert!(handler
            .mcp_app_source("thread-1", "older", None)
            .await
            .unwrap()
            .1
            .is_some());
        fs::write(
            root.join("thread_items_list.json"),
            json!({
                "data":[],"nextCursor":"repeated"
            })
            .to_string(),
        )
        .unwrap();
        assert!(handler
            .mcp_app_source("thread-1", "missing", None)
            .await
            .is_err());
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        let requests: Vec<Value> = fs::read_to_string(root.join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(requests
            .iter()
            .filter(|request| request["method"] == "thread/read")
            .all(|request| request["params"]["includeTurns"] == false));
        let targeted = requests
            .iter()
            .find(|request| request["method"] == "thread/items/read")
            .unwrap();
        assert_eq!(
            targeted["params"],
            json!({"threadId":"thread-1","turnId":"turn","itemIds":["call"]})
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invocation_must_match_native_item_type_id_and_turn() {
        let entry = json!({"turnId":"turn","item":{"id":"call","type":"mcpToolCall"}});
        assert!(matching_item(&entry, "call", Some("turn")).is_some());
        assert!(matching_item(&entry, "call", None).is_some());
        assert!(matching_item(&entry, "other", Some("turn")).is_none());
        assert!(matching_item(&entry, "call", Some("other")).is_none());
        let forged = json!({"turnId":"turn","item":{"id":"call","type":"agentMessage"}});
        assert!(matching_item(&forged, "call", Some("turn")).is_none());
    }
}
