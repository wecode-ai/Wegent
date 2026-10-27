// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_codex_recent_turns(&self, thread_id: &str) -> Result<Value, String> {
        self.read_codex_recent_turns_with_client(&self.codex_app_server, thread_id)
            .await
    }

    pub(super) async fn read_codex_recent_turns_with_client(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
    ) -> Result<Value, String> {
        load_codex_transcript(
            client,
            CodexTranscriptRequest {
                thread_id,
                cursor: None,
                limit: 1,
                direction: CodexTranscriptDirection::Descending,
                full_content: false,
                prefer_rollout_history: false,
            },
        )
        .await
        .map(|page| page.thread)
    }

    pub(super) async fn read_codex_turn_page(
        &self,
        thread_id: &str,
        limit: usize,
        direction: CodexTranscriptDirection,
    ) -> Result<Value, String> {
        load_codex_transcript(
            &self.codex_app_server,
            CodexTranscriptRequest {
                thread_id,
                cursor: None,
                limit,
                direction,
                full_content: false,
                prefer_rollout_history: false,
            },
        )
        .await
        .map(|page| page.thread)
    }

    async fn codex_transcript_navigation(
        &self,
        client: &CodexAppServerClient,
        thread: &Value,
        thread_id: &str,
        prefer_rollout_history: bool,
        refresh: bool,
    ) -> Result<CodexTranscriptNavigation, AppIpcError> {
        if !refresh {
            if let Some(navigation) = self.cached_codex_transcript_navigation(thread_id) {
                return Ok(navigation);
            }
        }

        let navigation =
            load_codex_transcript_navigation(client, thread, thread_id, prefer_rollout_history)
                .await
                .map_err(|error| AppIpcError::new("codex_error", error))?;
        let mut cache = self
            .codex_transcript_navigation_cache
            .lock()
            .expect("Codex transcript navigation cache lock should not be poisoned");
        cache.retain(|_, entry| entry.cached_at.elapsed() < CODEX_TRANSCRIPT_NAVIGATION_CACHE_TTL);
        if cache.len() >= CODEX_TRANSCRIPT_NAVIGATION_CACHE_MAX_ENTRIES {
            if let Some(oldest_key) = cache
                .iter()
                .max_by_key(|(_, entry)| entry.cached_at.elapsed())
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(
            thread_id.to_owned(),
            CachedCodexTranscriptNavigation {
                cached_at: Instant::now(),
                navigation: navigation.clone(),
            },
        );
        Ok(navigation)
    }

    fn cached_codex_transcript_navigation(
        &self,
        thread_id: &str,
    ) -> Option<CodexTranscriptNavigation> {
        self.codex_transcript_navigation_cache
            .lock()
            .expect("Codex transcript navigation cache lock should not be poisoned")
            .get(thread_id)
            .filter(|entry| entry.cached_at.elapsed() < CODEX_TRANSCRIPT_NAVIGATION_CACHE_TTL)
            .map(|entry| entry.navigation.clone())
    }
}

async fn delay_desktop_e2e_transcript_response() {
    let Some(delay_ms) = std::env::var("WEWORK_E2E_RUNTIME_TRANSCRIPT_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    else {
        return;
    };
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms.min(10_000))).await;
}
