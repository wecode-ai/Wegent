//! Headless workbenches resolve cloud routes through the existing authorized catalog.

use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloudModelReference {
    name: String,
    r#type: String,
    namespace: String,
    resource_user_id: u64,
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn resolve_harness_proxy_upstream(
        &self,
        payload: &Value,
    ) -> Result<local_model_proxy::LocalModelProxyUpstream, AppIpcError> {
        let Some(reference) = payload.get("cloudModel") else {
            return serde_json::from_value(
                payload
                    .get("upstream")
                    .cloned()
                    .ok_or_else(|| invalid("upstream or cloudModel is required"))?,
            )
            .map_err(|_| invalid("Invalid harness proxy upstream"));
        };
        let reference = cloud_reference(payload, reference)?;
        let mut launch = json!({"runnerRouting": {"model": {
            "runtime": "codex",
            "source": "cloud",
            "cloud_model": reference,
        }}});
        self.materialize_runner_cloud_models(&mut launch).await?;
        cloud_harness_upstream(&launch["modelConfig"])
    }
}

fn cloud_reference(payload: &Value, value: &Value) -> Result<Value, AppIpcError> {
    if payload.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|key| !["scope", "cloudModel"].contains(&key.as_str()))
    }) {
        return Err(invalid(
            "cloudModel cannot override Executor-owned routing configuration",
        ));
    }
    let reference: CloudModelReference = serde_json::from_value(value.clone())
        .map_err(|_| invalid("A complete cloud model resource identity is required"))?;
    if !["public", "user", "group"].contains(&reference.r#type.as_str())
        || [&reference.name, &reference.namespace]
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > 512)
    {
        return Err(invalid("Invalid cloud model resource identity"));
    }
    Ok(json!({"name": reference.name, "type": reference.r#type,
        "namespace": reference.namespace, "resource_user_id": reference.resource_user_id}))
}

fn cloud_harness_upstream(
    config: &Value,
) -> Result<local_model_proxy::LocalModelProxyUpstream, AppIpcError> {
    let mut config = config.clone();
    let base = config["base_url"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("Authorized cloud model gateway is unavailable"))?;
    let request_url = format!("{}/responses", base.trim_end_matches('/'));
    // The Backend gateway accepts Responses even when its provider uses Messages or Chat.
    config["upstream_api_format"] = json!("openai-responses");
    config["responses_url"] = json!(request_url);
    local_model_proxy::upstream_from_model_config(&config)
        .map_err(|_| invalid("Authorized cloud model gateway is invalid"))?
        .ok_or_else(|| invalid("Authorized cloud model gateway is unavailable"))
}

fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("invalid_request", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, routing::get, Json, Router};

    fn request() -> Value {
        json!({"scope":"workbench:installation-1", "cloudModel":{
            "name":"shared-model", "type":"public", "namespace":"default", "resource_user_id":0
        }})
    }

    fn model(protocol: &str) -> Value {
        json!({"name":"shared-model", "type":"public", "namespace":"default",
            "resourceUserId":0, "config":{"protocol":protocol}, "contextWindow":100_000})
    }

    async fn connected_handler(
        models: Vec<Value>,
    ) -> (RuntimeWorkRpcHandler, String, tokio::task::JoinHandle<()>) {
        let router = Router::new().route(
            "/api/models/unified",
            get(move |headers: HeaderMap| {
                let models = models.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer synthetic-current-user");
                    Json(json!({"data":models}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("device", "unused").with_backend_connection(
            Arc::new(Mutex::new(Some(ConnectionConfig {
                backend_url: url.clone(),
                auth_token: "synthetic-current-user".into(),
                runtime_auth_token: "synthetic-device-token".into(),
                ..Default::default()
            }))),
        );
        (handler, url, server)
    }

    #[tokio::test]
    async fn headless_cloud_models_use_authorized_identity_and_responses_gateway() {
        for protocol in [
            "openai-responses",
            "openai-chat-completions",
            "anthropic-messages",
        ] {
            let (handler, url, server) = connected_handler(vec![model(protocol)]).await;
            let upstream = handler
                .resolve_harness_proxy_upstream(&request())
                .await
                .unwrap();
            server.abort();
            assert_eq!(
                upstream.request_url.as_deref(),
                Some(format!("{url}/api/runtime-work/llm-responses-proxy/responses").as_str())
            );
            assert_eq!(upstream.api_format, "openai-responses");
            assert_eq!(upstream.api_key, "synthetic-current-user");
            assert_eq!(upstream.model_id.as_deref(), Some("shared-model"));
            assert_eq!(upstream.model_context_window, Some(100_000));
            assert!(upstream
                .default_headers
                .contains(&("X-Wegent-Model-User-Id".into(), "0".into())));
        }
    }

    #[tokio::test]
    async fn headless_cloud_models_reject_injection_before_network_access() {
        let handler = RuntimeWorkRpcHandler::new("device", "unused");
        for field in ["upstream", "apiKey", "authorization", "base_url", "models"] {
            let mut payload = request();
            payload[field] = json!("attacker-supplied");
            assert_eq!(
                handler
                    .resolve_harness_proxy_upstream(&payload)
                    .await
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
        }
        for reference in [
            json!({"name":"shared-model"}),
            json!({"name":"shared-model","type":"public","namespace":"default","resource_user_id":0,"apiKey":"attacker"}),
        ] {
            let mut payload = request();
            payload["cloudModel"] = reference;
            assert_eq!(
                handler
                    .resolve_harness_proxy_upstream(&payload)
                    .await
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
        }
    }

    #[tokio::test]
    async fn headless_cloud_models_reject_removed_inactive_and_different_owner_models() {
        let mut other = model("openai-responses");
        other["resourceUserId"] = json!(7);
        let mut inactive = model("openai-responses");
        inactive["isActive"] = json!(false);
        for models in [vec![], vec![other], vec![inactive]] {
            let (handler, _, server) = connected_handler(models).await;
            let error = handler
                .resolve_harness_proxy_upstream(&request())
                .await
                .unwrap_err();
            server.abort();
            assert_eq!(error.code, "RUNNER_MODEL_UNAVAILABLE");
        }
    }

    #[tokio::test]
    async fn headless_cloud_models_require_the_connected_user() {
        let handler = RuntimeWorkRpcHandler::new("device", "unused");
        assert_eq!(
            handler
                .resolve_harness_proxy_upstream(&request())
                .await
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }
}
