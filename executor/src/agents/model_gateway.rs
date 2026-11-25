use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;

use crate::{
    config::device::ConnectionConfig, protocol::ExecutionRequest,
    server::local_model_proxy::GatewayCredentials,
};

use super::runtime_capabilities::api_url;

pub(crate) type ConnectionSnapshot = Arc<Mutex<Option<ConnectionConfig>>>;

const RESPONSES_GATEWAY: &str = "/api/runtime-work/llm-responses-proxy/responses";

pub(crate) async fn credentials(
    snapshot: &ConnectionSnapshot,
    request: &ExecutionRequest,
) -> Option<GatewayCredentials> {
    if request.model_config["wework_model_kind"] != "cloud" {
        return None;
    }
    let connection = snapshot.lock().ok()?.clone()?;
    let owner = connection.authenticated_user_id.filter(|id| *id > 0)?;
    if !connection.auth_token.starts_with("wg-") {
        return None;
    }
    let gateway = api_url(&connection.backend_url, RESPONSES_GATEWAY).ok()?;
    let base_url = request.model_config["base_url"].as_str()?;
    if format!("{}/responses", base_url.trim_end_matches('/')) != gateway {
        return None;
    }
    let initial = request.model_config["api_key"].as_str()?;
    if initial != connection.auth_token
        && gateway_token_owner(&connection.backend_url, initial).await != Some(owner)
    {
        return None;
    }
    Some(GatewayCredentials::new(
        Arc::clone(snapshot),
        connection.backend_url,
        gateway,
        owner,
    ))
}

async fn gateway_token_owner(backend_url: &str, token: &str) -> Option<i64> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .get(api_url(backend_url, "/api/users/me").ok()?)
        .bearer_auth(token)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    response.json::<Value>().await.ok()?["id"].as_i64()
}
