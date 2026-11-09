use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};
static HOST: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
fn unavailable() -> AppIpcError {
    AppIpcError::new(
        "connection_host_unavailable",
        "The Wework connection runtime is unavailable on this device",
    )
}
pub(crate) fn configure(mut value: Value) -> Result<(), AppIpcError> {
    value["registeredAt"] = json!(chrono::Utc::now().timestamp());
    *HOST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| unavailable())? = Some(value);
    Ok(())
}

pub(crate) fn assert_dependency_unused(plugin_id: &str) -> Result<(), AppIpcError> {
    let guard = HOST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| unavailable())?;
    if let Some(host) = guard.as_ref() {
        assert_host_dependency_unused(host, plugin_id)?;
    }
    Ok(())
}

fn assert_host_dependency_unused(host: &Value, plugin_id: &str) -> Result<(), AppIpcError> {
    if !host_is_live(host) {
        return Ok(());
    }
    if let Some(reference) = host["dependencyReferences"]
        .as_array()
        .and_then(|references| {
            references
                .iter()
                .find(|reference| reference["pluginId"] == plugin_id)
        })
    {
        return Err(AppIpcError::new(
            "connection_dependency_in_use",
            format!(
                "Disable connection plugin {} before removing its Codex dependency",
                reference["providerId"].as_str().unwrap_or_default()
            ),
        ));
    }
    Ok(())
}

fn host_is_live(host: &Value) -> bool {
    host["registeredAt"]
        .as_i64()
        .is_some_and(|at| chrono::Utc::now().timestamp() - at <= 15)
}

pub(crate) fn provider_guidance() -> Vec<Value> {
    HOST.get()
        .and_then(|host| host.lock().ok())
        .and_then(|host| host.as_ref().map(live_provider_guidance))
        .unwrap_or_default()
}

fn live_provider_guidance(host: &Value) -> Vec<Value> {
    if !host_is_live(host) {
        return Vec::new();
    }
    host["providerGuidance"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn declared_dependency(
    provider: &str,
    source: &Value,
    alias: Option<&str>,
) -> Result<Value, AppIpcError> {
    let guard = HOST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| unavailable())?;
    let host = guard
        .as_ref()
        .filter(|host| host_is_live(host))
        .ok_or_else(unavailable)?;
    find_declared_dependency(host, provider, source, alias)
}

fn find_declared_dependency(
    host: &Value,
    provider: &str,
    source: &Value,
    alias: Option<&str>,
) -> Result<Value, AppIpcError> {
    let reference = host["dependencyReferences"]
        .as_array()
        .and_then(|references| {
            references.iter().find(|item| {
                item["providerId"].as_str() == Some(provider)
                    && alias.is_some()
                    && item["alias"].as_str() == alias
                    && item["pluginId"].is_string()
                    && item["marketplaceId"].is_string()
                    && item["pluginId"] == source["pluginId"]
                    && item["marketplaceId"] == source["marketplaceId"]
            })
        })
        .ok_or_else(|| {
            AppIpcError::new(
                "connection_dependency_denied",
                "Connection dependency is not registered",
            )
        })?;
    Ok(reference.clone())
}
pub(crate) async fn call(
    method: &str,
    provider: Option<&str>,
    input: Value,
) -> Result<Value, AppIpcError> {
    let host = HOST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| unavailable())?
        .clone()
        .ok_or_else(unavailable)?;
    if !host_is_live(&host) {
        return Err(unavailable());
    }
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| unavailable())?
        .post(host["url"].as_str().unwrap())
        .bearer_auth(host["token"].as_str().unwrap())
        .json(&json!({"method": method, "providerId": provider, "input": input}))
        .send()
        .await
        .map_err(|_| unavailable())?;
    let body: Value = response.json().await.map_err(|_| unavailable())?;
    if body["ok"] != true {
        return Err(response_error(method, &body["error"]));
    }
    Ok(body["result"].clone())
}

pub(super) fn collection_runtime_retry_after_ms(code: &str) -> Option<u64> {
    // A runtime read timeout is not a provider rejection or an action outcome.
    (code == "request_timeout").then_some(30_000)
}

fn response_error(method: &str, error: &Value) -> AppIpcError {
    let failure = AppIpcError::new(
        error["code"].as_str().unwrap_or("connection_failed"),
        error["message"].as_str().unwrap_or("Connection failed"),
    );
    if method == "collect"
        && !matches!(
            failure.code.as_str(),
            "connector_auth_required"
                | "connection_response_invalid"
                | "invalid_connection"
                | "forbidden"
                | "connection_tool_denied"
                | "connection_cli_request_failed"
                | "connection_cli_response_invalid"
        )
    {
        if let Some(delay) = error["retryAfterMs"]
            .as_u64()
            .filter(|delay| (1..=3_600_000).contains(delay))
            .or_else(|| collection_runtime_retry_after_ms(&failure.code))
        {
            return failure.with_retry_after_ms(delay);
        }
    }
    failure
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_guidance_expires_with_the_registered_host() {
        let mut host = json!({"registeredAt":chrono::Utc::now().timestamp(),"providerGuidance":[{"providerId":"mail","assistance":{"observe":["new mail"]}}]});
        assert_eq!(live_provider_guidance(&host).len(), 1);
        host["providerGuidance"] = json!([]);
        assert!(live_provider_guidance(&host).is_empty());
        host["providerGuidance"] = json!([{"providerId":"mail"}]);
        host["registeredAt"] = json!(chrono::Utc::now().timestamp() - 30);
        assert!(live_provider_guidance(&host).is_empty());
    }

    #[test]
    fn collection_retry_metadata_is_bounded_and_never_authorizes_action_replay() {
        let error =
            json!({"code":"plugin_transport_failed","message":"Offline","retryAfterMs":45000});
        assert_eq!(
            response_error("collect", &error).retry_after_ms,
            Some(45000)
        );
        for code in [
            "connector_auth_required",
            "connection_response_invalid",
            "invalid_connection",
            "forbidden",
            "connection_tool_denied",
            "connection_cli_request_failed",
            "connection_cli_response_invalid",
        ] {
            let mut permanent = error.clone();
            permanent["code"] = json!(code);
            assert_eq!(response_error("collect", &permanent).retry_after_ms, None);
        }
        for method in ["executeAction", "readSource", "initialize", "validate"] {
            assert_eq!(response_error(method, &error).retry_after_ms, None);
        }
        for delay in [
            json!(0),
            json!(-1),
            json!(3600001),
            json!("45000"),
            json!(1.5),
        ] {
            let mut invalid = error.clone();
            invalid["retryAfterMs"] = delay;
            assert_eq!(response_error("collect", &invalid).retry_after_ms, None);
        }
    }

    #[test]
    fn runtime_timeouts_retry_collection_only_without_provider_retry_metadata() {
        let error = json!({"code":"request_timeout","message":"Executor read timed out"});
        assert_eq!(
            response_error("collect", &error).retry_after_ms,
            Some(30_000)
        );
        for method in ["executeAction", "readSource", "initialize", "validate"] {
            assert_eq!(response_error(method, &error).retry_after_ms, None);
        }
    }

    #[test]
    fn connection_mcp_dependency_grants_are_exact_and_read_tools_come_from_the_host() {
        let host = json!({"dependencyReferences":[{"providerId":"@test/mail/inbox","alias":"mail","marketplaceId":"company","pluginId":"mail@company","readTools":[{"server":"mail","tool":"read"}]}]});
        let source = json!({"marketplaceId":"company","pluginId":"mail@company"});
        let granted =
            find_declared_dependency(&host, "@test/mail/inbox", &source, Some("mail")).unwrap();
        assert_eq!(
            granted["readTools"],
            json!([{"server":"mail","tool":"read"}])
        );
        assert!(
            find_declared_dependency(&host, "@other/mail/inbox", &source, Some("mail")).is_err()
        );
        assert!(find_declared_dependency(
            &host,
            "@test/mail/inbox",
            &json!({"marketplaceId":"other","pluginId":"mail@company"}),
            Some("mail")
        )
        .is_err());
        assert!(
            find_declared_dependency(&host, "@test/mail/inbox", &json!({}), Some("mail")).is_err()
        );
        assert!(find_declared_dependency(&host, "@test/mail/inbox", &source, None).is_err());
        assert!(
            find_declared_dependency(&host, "@test/mail/inbox", &source, Some("unknown")).is_err()
        );
    }

    #[test]
    fn connection_dependency_alias_selects_its_own_read_contract_for_the_same_plugin() {
        let host = json!({"dependencyReferences":[
            {"providerId":"@test/mail/inbox","alias":"mail","marketplaceId":"company","pluginId":"mail@company","cliReadTools":{"operations":{"list":{}}}},
            {"providerId":"@test/mail/inbox","alias":"archive","marketplaceId":"company","pluginId":"mail@company","cliReadTools":{"operations":{"search":{}}}}
        ]});
        let source = json!({"marketplaceId":"company","pluginId":"mail@company"});
        let first =
            find_declared_dependency(&host, "@test/mail/inbox", &source, Some("mail")).unwrap();
        let second =
            find_declared_dependency(&host, "@test/mail/inbox", &source, Some("archive")).unwrap();
        assert!(first["cliReadTools"]["operations"].get("list").is_some());
        assert!(first["cliReadTools"]["operations"].get("search").is_none());
        assert!(second["cliReadTools"]["operations"].get("search").is_some());
        assert!(second["cliReadTools"]["operations"].get("list").is_none());
    }

    #[test]
    fn stand_in_connection_dependencies_block_only_exact_live_references() {
        let mut host = json!({"registeredAt":chrono::Utc::now().timestamp(),"dependencyReferences":[{"providerId":"@test/mail/inbox","pluginId":"mail@company"}]});
        assert_eq!(
            assert_host_dependency_unused(&host, "mail@company")
                .unwrap_err()
                .code,
            "connection_dependency_in_use"
        );
        assert!(assert_host_dependency_unused(&host, "mail@other").is_ok());
        host["registeredAt"] = json!(chrono::Utc::now().timestamp() - 30);
        assert!(assert_host_dependency_unused(&host, "mail@company").is_ok());
    }
}
