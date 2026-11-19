use super::*;

impl CodexAppServerClient {
    /// Drain native background copies after the local plugin configuration is revoked.
    /// An offline Runtime has no native copy worker and must not start one to uninstall.
    pub(crate) async fn drain_local_plugin_cache_refresh(&self) -> Result<(), String> {
        if self.state.lock().await.process.is_none() {
            return Ok(());
        }
        let method = "plugin/list";
        let params = json!({
            "cwds": null,
            "marketplaceKinds": ["local"],
            "forceRefetch": true,
        });
        let request = self
            .prepare_request_with_process(false, None, method, &params)
            .await?;
        request
            .write_and_wait(method, params, codex_rpc_timeout_seconds())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn offline_uninstall_does_not_start_an_app_server() {
        let client = CodexAppServerClient::new("missing-cache-diagnostic-binary");
        client.drain_local_plugin_cache_refresh().await.unwrap();
        assert!(client.state.lock().await.process.is_none());
    }
}
