//! Device-local connection plugins are hosted by the managed Wework plugin runtime.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn configure_connection_host(&self, payload: Value) -> Result<Value, AppIpcError> {
        let poll = payload["poll"] == true;
        super::super::connection_host::configure(payload)?;
        if poll {
            self.schedule_connection_subscribers();
        }
        Ok(json!({"success": true}))
    }

    pub(super) async fn connection_call(
        &self,
        method: &str,
        provider: Option<&str>,
        input: Value,
    ) -> Result<Value, AppIpcError> {
        super::super::connection_host::call(method, provider, input).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stand_in_connection_callback_cannot_redirect_credentials_to_remote_hosts() {
        for address in [
            "https://example.com",
            "http://localhost:123",
            "http://127.0.0.1:123/other",
        ] {
            assert!(super::super::super::connection_host::validate_host(
                &json!({"url":address,"token":"a".repeat(64)})
            )
            .is_err());
        }
        assert!(super::super::super::connection_host::validate_host(
            &json!({"url":"http://127.0.0.1:123/wework/connections/v1/rpc","token":"a".repeat(64)})
        )
        .is_ok());
    }
}
