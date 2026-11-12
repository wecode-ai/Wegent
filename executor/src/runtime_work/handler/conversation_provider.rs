//! Read only the active native provider for an already-authorized identity conversation.
use super::*;

pub(super) fn active_provider(link: &RuntimeTaskLink) -> Option<Value> {
    let thread = link.thread_id.as_deref()?;
    let identity = &link.runtime_handle["activeModelProvider"];
    let provider = identity["provider"].as_str()?.trim();
    (identity["threadId"].as_str() == Some(thread) && !provider.is_empty())
        .then(|| json!({"threadId": thread, "provider": provider}))
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn get_task_with_active_provider(
        &self,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let response = self.get_task(payload)?;
        if payload["resolveActiveProvider"] != true || response["success"] != true {
            return Ok(response);
        }
        // Resolve the link through the same task lookup and ownership boundary as get_task.
        // Never accept a caller-supplied native thread id or configuration.
        let task_id = runtime_task_id(payload).unwrap();
        let link = self.local_task_link(&task_id).ok_or_else(|| {
            AppIpcError::new("not_found", "Conversation no longer exists on this Runtime")
        })?;
        if !crate::runtime_work::conversation_sessions::is_identity_conversation(&link) {
            return Err(AppIpcError::new(
                "bad_request",
                "Provider lookup requires a persistent stand-in conversation",
            ));
        }
        let Some(thread_id) = link.thread_id.as_deref() else {
            return Ok(response);
        };
        if active_provider(&link).is_some() {
            return Ok(response);
        }
        let client = self
            .codex_app_server
            .for_request(&runtime_event_request_from_link(&link))
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let metadata = read_codex_thread_metadata(&client, thread_id)
            .await
            .map_err(|error| AppIpcError::new("codex_error", error))?;
        let provider = string_field(&metadata["thread"], "modelProvider")
            .filter(|_| metadata["thread"]["id"].as_str() == Some(thread_id))
            .ok_or_else(|| {
                AppIpcError::new("codex_error", "Native thread provider is unavailable")
            })?;
        self.store.update_task(&task_id, |current| {
            if current.thread_id.as_deref() == Some(thread_id)
                && current.status != "archived"
                && crate::runtime_work::conversation_sessions::is_identity_conversation(current)
            {
                current.runtime_handle["activeModelProvider"] =
                    json!({"threadId": thread_id, "provider": provider});
            }
        });
        // Project the current link, not the one captured before the asynchronous read.
        self.get_task(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{install_native_history, isolated_runtime_work_handler};
    use super::*;

    #[tokio::test]
    async fn legacy_provider_lookup_reads_only_the_owned_active_thread_and_caches_safe_fields() {
        let (mut handler, root) = isolated_runtime_work_handler("legacy-provider-lookup");
        install_native_history(&mut handler, &root, Vec::new(), None);
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "stand-in-chat-7-primary".into(),
            thread_id: Some("thread-1".into()),
            workspace_path: root.display().to_string(),
            runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7}}),
            ..Default::default()
        });
        fs::write(
            root.join("thread_read.json"),
            json!({"thread":{
                "id":"thread-1","modelProvider":"openai","private":"never project metadata"
            }})
            .to_string(),
        )
        .unwrap();
        let payload = json!({"taskId":"stand-in-chat-7-primary", "resolveActiveProvider":true,
            "threadId":"foreign", "runtimeHandle":{"threadId":"foreign"}});
        let result = handler
            .get_task_with_active_provider(&payload)
            .await
            .unwrap();
        assert_eq!(
            result["task"]["runtimeHandle"]["activeModelProvider"],
            json!({"threadId":"thread-1","provider":"openai"})
        );
        assert!(result["task"]["modelSelection"].is_null());
        assert!(!result.to_string().contains("never project"));
        handler
            .get_task_with_active_provider(&payload)
            .await
            .unwrap();
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        let calls = fs::read_to_string(root.join("requests.jsonl")).unwrap();
        let reads = calls
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|call| call["method"] == "thread/read")
            .collect::<Vec<_>>();
        assert_eq!(reads.len(), 1);
        assert_eq!(
            reads[0]["params"],
            json!({"threadId":"thread-1","includeTurns":false})
        );
        handler
            .store
            .update_task("stand-in-chat-7-primary", |link| {
                link.thread_id = Some("new-thread".into());
            });
        assert!(handler.get_task(&payload).unwrap()["task"]["runtimeHandle"]
            ["activeModelProvider"]
            .is_null());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn provider_resolution_is_opt_in_and_rejects_unrelated_tasks_without_provider_io() {
        let (handler, root) = isolated_runtime_work_handler("provider-lookup-scope");
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "ordinary".into(),
            thread_id: Some("thread-1".into()),
            ..Default::default()
        });
        assert_eq!(
            handler
                .get_task_with_active_provider(&json!({"taskId":"ordinary"}))
                .await
                .unwrap()["success"],
            true
        );
        assert_eq!(
            handler
                .get_task_with_active_provider(&json!({
                    "taskId":"ordinary", "resolveActiveProvider":true
                }))
                .await
                .unwrap_err()
                .code,
            "bad_request"
        );
        assert!(!root.join("requests.jsonl").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn provider_metadata_failure_is_retryable_and_does_not_cache_defaults() {
        let (mut handler, root) = isolated_runtime_work_handler("provider-lookup-recovery");
        install_native_history(&mut handler, &root, Vec::new(), None);
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "chat".into(),
            thread_id: Some("thread-1".into()),
            runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7}}),
            ..Default::default()
        });
        fs::write(
            root.join("thread_read.error-once.json"),
            json!({"code":-32000,"message":"metadata unavailable"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("thread_read.json"),
            json!({"thread":{"id":"thread-1","modelProvider":"router"}}).to_string(),
        )
        .unwrap();
        let payload = json!({"taskId":"chat","resolveActiveProvider":true});
        assert_eq!(
            handler
                .get_task_with_active_provider(&payload)
                .await
                .unwrap_err()
                .code,
            "codex_error"
        );
        assert!(handler.get_task(&payload).unwrap()["task"]["runtimeHandle"]
            ["activeModelProvider"]
            .is_null());
        let result = handler
            .get_task_with_active_provider(&payload)
            .await
            .unwrap();
        assert_eq!(
            result["task"]["runtimeHandle"]["activeModelProvider"]["provider"],
            "router"
        );
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
