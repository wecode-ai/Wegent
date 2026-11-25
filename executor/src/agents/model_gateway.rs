use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    config::device::ConnectionConfig,
    logging::log_executor_event,
    protocol::ExecutionRequest,
    server::local_model_proxy::{upstream_from_model_config, GatewayCredentials},
};

use super::runtime_capabilities::api_url;

pub(crate) type ConnectionSnapshot = Arc<Mutex<Option<ConnectionConfig>>>;

const RESPONSES_GATEWAY: &str = "/api/runtime-work/llm-responses-proxy/responses";
const ACCOUNT_CHANGED: &str =
    "The saved model gateway's connected account or backend is no longer available";

/// Executor-owned proof. This is stored separately from incoming and exported task metadata.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct GatewayBinding {
    backend_url: String,
    request_url: String,
    user_id: i64,
    launch_digest: [u8; 32],
    model_id: Option<String>,
    routing_headers: Vec<(String, String)>,
}

pub(crate) async fn credentials(
    snapshot: &ConnectionSnapshot,
    request: &mut ExecutionRequest,
    saved: Option<&GatewayBinding>,
    restore_saved_profile: bool,
) -> Result<Option<(GatewayCredentials, GatewayBinding)>, String> {
    if request.model_config["wework_model_kind"] != "cloud" {
        return Ok(None);
    }
    let Some(upstream) = upstream_from_model_config(&request.model_config)? else {
        return Ok(None);
    };
    if upstream.api_format != "openai-responses" {
        return Ok(None);
    }
    let launch_digest = Sha256::digest(upstream.api_key.as_bytes()).into();
    let use_saved = saved.filter(|binding| {
        binding.launch_digest == launch_digest
            || (restore_saved_profile && upstream.api_key.is_empty())
    });
    let connection = snapshot.lock().map_err(|_| ACCOUNT_CHANGED)?.clone();
    let Some(connection) = connection.filter(|connection| connection.auth_token.starts_with("wg-"))
    else {
        return if use_saved.is_some() {
            Err(ACCOUNT_CHANGED.into())
        } else {
            Ok(None)
        };
    };
    let gateway = api_url(&connection.backend_url, RESPONSES_GATEWAY)?;
    let request_url = upstream.resolved_request_url();
    if let Some(binding) = use_saved {
        if binding.backend_url != connection.backend_url || binding.request_url != gateway {
            return Err(ACCOUNT_CHANGED.into());
        }
        if binding.model_id == upstream.model_id && request_url == gateway {
            let credentials =
                live_credentials(snapshot, &connection, &gateway, binding.user_id).await?;
            if upstream.api_key.is_empty() {
                request.model_config["default_headers"] = Value::Object(
                    binding
                        .routing_headers
                        .iter()
                        .cloned()
                        .map(|(key, value)| (key, Value::String(value)))
                        .collect(),
                );
            }
            return Ok(Some((credentials, binding.clone())));
        }
        if restore_saved_profile {
            return Err("The saved model gateway profile has changed".into());
        }
    }
    if request_url != gateway {
        return Ok(None);
    }
    if upstream.api_key.is_empty() {
        return if restore_saved_profile {
            Err("The saved model gateway profile requires a verified model selection".into())
        } else {
            Ok(None)
        };
    }

    let owner = connection.authenticated_user_id.filter(|id| *id > 0);
    let launch_owner = if upstream.api_key == connection.auth_token {
        // The same credential is authenticated by live_credentials before it is saved.
        owner
    } else {
        gateway_token_owner(&connection.backend_url, &upstream.api_key).await
    };
    if let Some(user_id) = launch_owner.filter(|id| Some(*id) == owner) {
        let credentials = live_credentials(snapshot, &connection, &gateway, user_id).await?;
        let binding = GatewayBinding {
            backend_url: connection.backend_url,
            request_url,
            user_id,
            launch_digest,
            model_id: upstream.model_id,
            routing_headers: upstream
                .default_headers
                .into_iter()
                .filter(|(name, _)| {
                    matches!(
                        name.to_ascii_lowercase().as_str(),
                        "x-wegent-model-type"
                            | "x-wegent-model-namespace"
                            | "x-wegent-model-user-id"
                            | "x-wegent-upstream-header-wecode-executor"
                            | "x-wegent-upstream-header-wecode-source"
                    )
                })
                .collect(),
        };
        return Ok(Some((credentials, binding)));
    }
    log_executor_event(
        "cloud model gateway device credential not bound",
        &[
            ("task_id", request.task_id.clone()),
            (
                "reason",
                if launch_owner.is_some() {
                    "different_account"
                } else {
                    "owner_lookup_unavailable"
                }
                .to_owned(),
            ),
        ],
    );
    if restore_saved_profile && launch_owner.is_none() {
        return Err("The saved model gateway credential could not be verified".into());
    }
    Ok(None)
}

async fn live_credentials(
    snapshot: &ConnectionSnapshot,
    connection: &ConnectionConfig,
    gateway: &str,
    user_id: i64,
) -> Result<GatewayCredentials, String> {
    let credentials = GatewayCredentials::new(
        Arc::clone(snapshot),
        connection.backend_url.clone(),
        gateway.to_owned(),
        api_url(&connection.backend_url, "/api/devices/runtime-owner")?,
        user_id,
    );
    credentials.verify().await.map_err(|error| error.detail)?;
    Ok(credentials)
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
