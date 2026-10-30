//! Live UI documents retain their source MCP connection without holding a model turn.
use super::*;

impl CodexAppServerClient {
    pub(crate) async fn set_mcp_app_session(
        &self,
        thread_id: &str,
        call_id: &str,
        session_id: &str,
        active: bool,
    ) {
        let gate = self.thread_lifecycle_gate(thread_id).await;
        let _guard = gate.lock().await;
        let mut state = self.state.lock().await;
        let key = (
            thread_id.to_owned(),
            call_id.to_owned(),
            session_id.to_owned(),
        );
        if active {
            state.mcp_app_sessions.insert(key);
        } else {
            if state.mcp_app_sessions.remove(&key) {
                log_executor_event(
                    "codex MCP App session released",
                    &[
                        ("thread_id", thread_id.to_owned()),
                        ("call_id", call_id.to_owned()),
                        ("app_session_id", session_id.to_owned()),
                    ],
                );
            }
            if let Some(generation) = state
                .idle_thread_generations
                .get(thread_id)
                .copied()
                .filter(|_| !state.has_mcp_app_session(thread_id))
            {
                self.unsubscribe_thread_in_background(
                    thread_id.to_owned(),
                    generation,
                    IDLE_CODEX_THREAD_SUBSCRIPTION_TTL,
                    "app_closed",
                    MAX_IDLE_CODEX_THREAD_UNSUBSCRIBE_RETRIES,
                );
            }
        }
    }
}

impl CodexAppServerSharedState {
    pub(super) fn has_mcp_app_session(&self, thread_id: &str) -> bool {
        self.mcp_app_sessions
            .iter()
            .any(|(thread, _, _)| thread == thread_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mcp_app_session_prevents_idle_eviction_without_marking_a_model_turn_active() {
        let client = CodexAppServerClient::new("unused-mcp-app-test");
        client
            .set_mcp_app_session("thread-1", "app", "instance", true)
            .await;
        for index in 1..=MAX_IDLE_CODEX_THREAD_SUBSCRIPTIONS + 1 {
            let thread = format!("thread-{index}");
            client.mark_thread_active(&thread).await;
            let (_, evicted) = client.mark_thread_idle(&thread, true).await.unwrap();
            assert!(evicted.iter().all(|(thread, _)| thread != "thread-1"));
        }
        let generation = {
            let state = client.state.lock().await;
            assert!(state.active_threads.is_empty());
            assert!(state.idle_thread_generations.contains_key("thread-1"));
            state.thread_generations["thread-1"]
        };
        assert!(!client
            .request_thread_unsubscribe_if_idle("thread-1", generation)
            .await
            .unwrap());
        client
            .set_mcp_app_session("thread-1", "app", "instance", false)
            .await;
        assert!(!client.state.lock().await.has_mcp_app_session("thread-1"));
    }

    #[tokio::test]
    async fn stale_app_release_cannot_remove_a_replacement_hosts_session() {
        let client = CodexAppServerClient::new("unused-mcp-app-replacement-test");
        client.mark_thread_active("thread").await;
        client.mark_thread_idle("thread", true).await.unwrap();
        client
            .set_mcp_app_session("thread", "call", "old", true)
            .await;
        client
            .set_mcp_app_session("thread", "call", "new", true)
            .await;
        client
            .set_mcp_app_session("thread", "call", "old", false)
            .await;
        client
            .set_mcp_app_session("thread", "call", "old", false)
            .await;
        let generation = {
            let state = client.state.lock().await;
            assert!(state.has_mcp_app_session("thread"));
            assert_eq!(state.mcp_app_sessions.len(), 1);
            assert!(state.mcp_app_sessions.contains(&(
                "thread".into(),
                "call".into(),
                "new".into()
            )));
            state.thread_generations["thread"]
        };
        assert!(!client
            .request_thread_unsubscribe_if_idle("thread", generation)
            .await
            .unwrap());
        client
            .set_mcp_app_session("thread", "call", "new", false)
            .await;
        assert!(!client.state.lock().await.has_mcp_app_session("thread"));
    }
}
