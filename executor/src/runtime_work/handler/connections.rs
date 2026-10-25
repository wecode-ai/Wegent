//! Device-local connection plugins are hosted by the managed Wework plugin runtime.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn configure_connection_host(&self, payload: Value) -> Result<Value, AppIpcError> {
        validate_connection_host(&payload)?;
        super::super::connection_host::configure(payload)?;
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

fn validate_connection_host(payload: &Value) -> Result<(), AppIpcError> {
    let url = payload["url"]
        .as_str()
        .and_then(|url| url::Url::parse(url).ok());
    let valid = url.is_some_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/wework/connections/v1/rpc"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    });
    let token = payload["token"].as_str().unwrap_or_default();
    if !valid || token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppIpcError::new(
            "invalid_connection_host",
            "Invalid connection runtime endpoint",
        ));
    }
    Ok(())
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
            assert!(
                validate_connection_host(&json!({"url":address,"token":"a".repeat(64)})).is_err()
            );
        }
        assert!(validate_connection_host(
            &json!({"url":"http://127.0.0.1:123/wework/connections/v1/rpc","token":"a".repeat(64)})
        )
        .is_ok());
    }
}
