//! Live UI documents retain their source MCP connection without holding a model turn.
use super::*;

impl CodexAppServerClient {
    pub(crate) async fn set_mcp_app_lease(&self, thread_id: &str, call_id: &str, active: bool) {
        let gate = self.thread_lifecycle_gate(thread_id).await;
        let _guard = gate.lock().await;
        let mut state = self.state.lock().await;
        let now = Instant::now();
        state.mcp_app_leases.retain(|_, expires| *expires > now);
        let key = (thread_id.to_owned(), call_id.to_owned());
        if active {
            state
                .mcp_app_leases
                .insert(key, now + Duration::from_secs(90));
        } else {
            state.mcp_app_leases.remove(&key);
            if let Some(generation) = state.idle_thread_generations.get(thread_id).copied() {
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
    pub(super) fn has_mcp_app_lease(&self, thread_id: &str) -> bool {
        self.mcp_app_leases
            .iter()
            .any(|((thread, _), expires)| thread == thread_id && *expires > Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mcp_app_lease_prevents_idle_eviction_without_marking_a_model_turn_active() {
        let client = CodexAppServerClient::new("unused-mcp-app-test");
        client.set_mcp_app_lease("thread-1", "app", true).await;
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
        client.set_mcp_app_lease("thread-1", "app", false).await;
        assert!(!client.state.lock().await.has_mcp_app_lease("thread-1"));
    }

    #[tokio::test]
    async fn mcp_app_lease_expiry_releases_crashed_renderers() {
        let client = CodexAppServerClient::new("unused-mcp-app-expiry-test");
        client.set_mcp_app_lease("thread", "first", true).await;
        client.set_mcp_app_lease("thread", "second", true).await;
        client.set_mcp_app_lease("thread", "first", false).await;
        assert!(client.state.lock().await.has_mcp_app_lease("thread"));
        client.state.lock().await.mcp_app_leases.insert(
            ("thread".into(), "second".into()),
            Instant::now() - Duration::from_secs(1),
        );
        assert!(!client.state.lock().await.has_mcp_app_lease("thread"));
    }
}
