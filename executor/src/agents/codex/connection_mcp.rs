//! Direct background MCP requests never create a model turn or grant interactive consent.
use super::*;

impl CodexAppServerClient {
    pub(crate) async fn request_connection_mcp(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, String> {
        if method == "thread/start" {
            let result = self.request(method, params).await?;
            let id = thread_id_from_response(method, &result, None)?;
            self.mark_thread_active(&id).await;
            return Ok(result);
        }
        if method == "thread/unsubscribe" {
            let id = params["threadId"]
                .as_str()
                .ok_or("Missing background thread ID")?;
            let result = self.release_thread_subscription(id).await;
            self.mark_thread_idle(id, false).await;
            return result.map(|_| json!({}));
        }
        let Some(thread_id) = params["threadId"].as_str() else {
            return self.request(method, params).await;
        };
        let mut notifications = self.subscribe_thread_notifications(thread_id).await?;
        let response = self.request(method, params.clone());
        tokio::pin!(response);
        let mut interaction_required = false;
        loop {
            tokio::select! {
                result = &mut response => {
                    return if interaction_required {
                        Err("connection_interaction_required".to_owned())
                    } else { result };
                }
                notification = notifications.recv() => {
                    let message = notification.map_err(|_| "Background MCP notification stream closed".to_owned())?;
                    if background_mcp_interaction(&message, thread_id) {
                        // There is no user conversation for this thread. Never invent approval.
                        interaction_required = true;
                        self.send_response(message["id"].clone(), json!({"action":"cancel"})).await?;
                    }
                }
            }
        }
    }
}

fn background_mcp_interaction(message: &Value, thread_id: &str) -> bool {
    message["method"] == "mcpServer/elicitation/request"
        && message
            .get("id")
            .is_some_and(|id| id.is_string() || id.is_number())
        && message["params"]["threadId"].as_str() == Some(thread_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_mcp_interactions_are_scoped_to_the_background_thread() {
        let mut event = json!({"id":0,"method":"mcpServer/elicitation/request","params":{"threadId":"background"}});
        assert!(background_mcp_interaction(&event, "background"));
        assert!(!background_mcp_interaction(&event, "personal-conversation"));
        event["params"] = json!({});
        assert!(!background_mcp_interaction(&event, "background"));
        event["params"] = json!({"threadId":"background"});
        event.as_object_mut().unwrap().remove("id");
        assert!(!background_mcp_interaction(&event, "background"));
    }
}
