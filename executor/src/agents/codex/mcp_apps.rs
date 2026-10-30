//! Live UI documents retain their source MCP connection without holding a model turn.
use super::*;

impl CodexAppServerClient {
    pub(crate) async fn set_mcp_app_lease(
        &self,
        thread_id: &str,
        call_id: &str,
        lease_id: Option<&str>,
        active: bool,
    ) {
        let gate = self.thread_lifecycle_gate(thread_id).await;
        let _guard = gate.lock().await;
        let mut state = self.state.lock().await;
        let now = Instant::now();
        state.mcp_app_leases.retain(|_, expires| *expires > now);
        let key = (
            thread_id.to_owned(),
            call_id.to_owned(),
            lease_id.map(str::to_owned),
        );
        if active {
            state
                .mcp_app_leases
                .insert(key, now + Duration::from_secs(90));
        } else {
            state.mcp_app_leases.remove(&key);
            if let Some(generation) = state
                .idle_thread_generations
                .get(thread_id)
                .copied()
                .filter(|_| !state.has_mcp_app_lease(thread_id))
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
    pub(super) fn has_mcp_app_lease(&self, thread_id: &str) -> bool {
        self.mcp_app_leases
            .iter()
            .any(|((thread, _, _), expires)| thread == thread_id && *expires > Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mcp_app_lease_prevents_idle_eviction_without_marking_a_model_turn_active() {
        let client = CodexAppServerClient::new("unused-mcp-app-test");
        client
            .set_mcp_app_lease("thread-1", "app", None, true)
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
            .set_mcp_app_lease("thread-1", "app", None, false)
            .await;
        assert!(!client.state.lock().await.has_mcp_app_lease("thread-1"));
    }

    #[tokio::test]
    async fn mcp_app_lease_expiry_releases_crashed_renderers() {
        let client = CodexAppServerClient::new("unused-mcp-app-expiry-test");
        client
            .set_mcp_app_lease("thread", "first", None, true)
            .await;
        client
            .set_mcp_app_lease("thread", "second", None, true)
            .await;
        client
            .set_mcp_app_lease("thread", "first", None, false)
            .await;
        assert!(client.state.lock().await.has_mcp_app_lease("thread"));
        client.state.lock().await.mcp_app_leases.insert(
            ("thread".into(), "second".into(), None),
            Instant::now() - Duration::from_secs(1),
        );
        assert!(!client.state.lock().await.has_mcp_app_lease("thread"));
    }

    #[tokio::test]
    async fn stale_app_release_cannot_remove_a_replacement_hosts_lease() {
        let client = CodexAppServerClient::new("unused-mcp-app-replacement-test");
        client.mark_thread_active("thread").await;
        client.mark_thread_idle("thread", true).await.unwrap();
        client
            .set_mcp_app_lease("thread", "call", Some("old"), true)
            .await;
        client
            .set_mcp_app_lease("thread", "call", Some("new"), true)
            .await;
        client
            .set_mcp_app_lease("thread", "call", Some("old"), false)
            .await;
        client
            .set_mcp_app_lease("thread", "call", Some("old"), false)
            .await;
        client
            .set_mcp_app_lease("thread", "call", None, false)
            .await;
        let generation = {
            let state = client.state.lock().await;
            assert!(state.has_mcp_app_lease("thread"));
            assert_eq!(state.mcp_app_leases.len(), 1);
            assert!(state.mcp_app_leases.contains_key(&(
                "thread".into(),
                "call".into(),
                Some("new".into())
            )));
            state.thread_generations["thread"]
        };
        assert!(!client
            .request_thread_unsubscribe_if_idle("thread", generation)
            .await
            .unwrap());
        client
            .set_mcp_app_lease("thread", "call", Some("new"), false)
            .await;
        assert!(!client.state.lock().await.has_mcp_app_lease("thread"));
    }
}
