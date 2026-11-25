// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Resolve the same inference route for ordinary tasks and personal stand-ins.
pub(super) fn request_upstream(
    request: &ExecutionRequest,
) -> Result<Option<(LocalModelProxyUpstream, &'static str)>, String> {
    if !use_user_runtime_config(&request.model_config) {
        if let Some(upstream) =
            local_model_proxy::upstream_from_model_config(&request.model_config)?
        {
            return Ok(Some((upstream, "local_proxy_payload")));
        }
    }
    // A provider-only selection still owns the provider configured in CODEX_HOME.
    // Use the same route for launch, follow-up turns and control operations.
    let provider = request_provider(request)?;
    if is_builtin_codex_provider(&provider) {
        let home = request_home(request)?;
        if official_openai_proxy_applies(request, &provider) {
            if let Some(base_url) = native_provider::official_codex_base_url(&home)? {
                return Ok(Some((
                    official_openai_proxy_upstream(request, base_url),
                    "local_proxy_official_subscription",
                )));
            }
        }
        return Ok(None);
    }
    Ok(configured_codex_provider(
        &provider,
        runtime_proxy_url(&request.model_config),
        &request_home(request)?,
    )
    .map(|upstream| (upstream, "local_proxy_user_provider")))
}

fn official_openai_proxy_applies(request: &ExecutionRequest, provider: &str) -> bool {
    provider == "openai"
        && is_official_codex_model(&request.model_config)
        && super::super::instance_home::request_home(request).is_none()
        && home::codex_subscription_enabled()
}

fn official_openai_proxy_upstream(
    request: &ExecutionRequest,
    base_url: String,
) -> LocalModelProxyUpstream {
    LocalModelProxyUpstream {
        request_url: Some(format!("{base_url}/responses")),
        base_url,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: true,
        native_namespace_tools: true,
        // Official Responses requests keep their native shape. The proxy
        // only sanitizes non-portable history and the first switch request.
        codex_request_mode: local_model_proxy::CodexRequestMode::Passthrough,
        api_key: String::new(),
        default_headers: Vec::new(),
        proxy_url: runtime_proxy_url(&request.model_config).map(str::to_owned),
        model_id: None,
        routing_model_id: None,
        max_output_tokens: local_model_proxy::model_max_output_tokens(&request.model_config),
        model_context_window: codex_model_context_window(&request.model_config)
            .and_then(|value| u64::try_from(value).ok()),
    }
}

pub(super) fn configure_request_provider(
    launch: &mut CodexLaunchConfig,
    request: &ExecutionRequest,
    route_scope: &str,
) -> Result<(), String> {
    let upstream = request_upstream(request)?;
    let route = upstream
        .as_ref()
        .map(|(_, source)| *source)
        .unwrap_or_else(|| {
            if use_user_runtime_config(&request.model_config) {
                "direct_user_provider"
            } else {
                "direct_payload_provider"
            }
        });
    let provider = request_provider(request)?;
    launch.inference_model_provider = Some(provider.clone());
    log_route(request, route, &provider)?;
    if let Some((mut upstream, _)) = upstream {
        inject_session_headers(&mut upstream.default_headers, &request.task_id);
        let official_websocket = upstream.is_official_chatgpt_codex()
            && native_provider::official_websocket_enabled(&request_home(request)?)?;
        configure_codex_router(
            launch,
            route_scope,
            upstream,
            codex_request_model(request),
            request_model_switched(request),
            vision_sidecar_with_session_headers(&request.model_config, &request.task_id)?,
            official_websocket,
        );
    } else {
        launch.model_provider = Some(codex_model_catalog::PROVIDER_ID.to_owned());
        let headers = if is_builtin_codex_provider(&provider) {
            Vec::new()
        } else {
            task_provider_headers(
                request.model_config.get("default_headers"),
                project_id(request).as_deref(),
                &request.task_id,
            )
        };
        launch
            .config_overrides
            .extend(super::native_provider::with_headers(
                &request_home(request)?,
                &provider,
                headers,
                request.cwd(),
            )?);
    }
    Ok(())
}

fn request_home(request: &ExecutionRequest) -> Result<PathBuf, String> {
    let home = super::super::instance_home::request_home(request).unwrap_or_else(wework_codex_home);
    if !home.is_absolute() {
        return Err("Named Agent Home identity is incomplete".to_owned());
    }
    Ok(home)
}

fn request_provider(request: &ExecutionRequest) -> Result<String, String> {
    let home = request_home(request)?;
    Ok(
        explicit_model_provider(&request.model_config).unwrap_or_else(|| {
            configured_inference_model_provider_from_path(&home.join("config.toml"))
        }),
    )
}

fn log_route(request: &ExecutionRequest, route: &str, provider: &str) -> Result<(), String> {
    log_executor_event(
        "codex model route selected",
        &[
            ("task_id", request.task_id.clone()),
            ("route", route.to_owned()),
            ("provider", provider.to_owned()),
            ("model", codex_request_model(request).unwrap_or_default()),
            (
                "payload_base_url_present",
                non_empty_config(&request.model_config, "base_url")
                    .or_else(|| non_empty_config(&request.model_config, "baseUrl"))
                    .is_some()
                    .to_string(),
            ),
            (
                "payload_auth_present",
                api_key(&request.model_config).is_some().to_string(),
            ),
        ],
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_chatgpt_uses_the_compatibility_proxy_with_native_auth() {
        let _lock = crate::test_env::lock();
        let home = tempfile::tempdir().unwrap();
        let _restore = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        let _subscription = EnvRestore::capture(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV);
        env::set_var(WEGENT_CODEX_HOME_ENV, home.path());
        env::set_var(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV, "true");
        fs::write(
            home.path().join("config.toml"),
            r#"openai_base_url="http://127.0.0.1:4567/backend-api/codex"
[model_providers.openai]
base_url="https://synthetic.invalid/v1"
experimental_bearer_token="must-not-select"
"#,
        )
        .unwrap();
        let request = ExecutionRequest {
            model_config: json!({
                "model_provider":"openai",
                "model_id":"gpt-test",
                "wework_model_kind":"codex-official"
            }),
            ..ExecutionRequest::default()
        };
        let (upstream, source) = request_upstream(&request).unwrap().unwrap();
        assert_eq!(source, "local_proxy_official_subscription");
        assert!(upstream.is_official_chatgpt_codex());
        assert!(upstream.api_key.is_empty());
        assert_eq!(upstream.base_url, "http://127.0.0.1:4567/backend-api/codex");
        assert_eq!(
            upstream.codex_request_mode,
            local_model_proxy::CodexRequestMode::Passthrough
        );
        let mut launch = CodexLaunchConfig::default();
        configure_codex_router(
            &mut launch,
            "official-chatgpt-test",
            upstream,
            Some("gpt-test".to_owned()),
            false,
            None,
            false,
        );
        assert!(launch.local_proxy_registration.is_some());
        assert!(!launch
            .config_overrides
            .contains(&"forced_login_method=api".to_owned()));
        let profile = super::super::native_provider::profile_for_test(&launch.config_overrides);
        assert_eq!(profile["requires_openai_auth"], true);
        assert_eq!(profile["wire_api"], "responses");
        assert_eq!(profile["supports_websockets"], false);
        assert_eq!(profile["supports_standalone_web_search"], true);
        assert!(profile.get("auth").is_none());
        assert!(profile["base_url"]
            .as_str()
            .is_some_and(|value| value.contains("/v1/codex-router/")));
        assert!(profile.get("experimental_bearer_token").is_none());
    }

    #[test]
    fn official_chatgpt_stays_direct_when_subscription_auth_is_disabled() {
        let _lock = crate::test_env::lock();
        let home = tempfile::tempdir().unwrap();
        let _restore = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        let _subscription = EnvRestore::capture(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV);
        env::set_var(WEGENT_CODEX_HOME_ENV, home.path());
        env::set_var(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV, "false");
        let request = ExecutionRequest {
            model_config: json!({
                "model_provider":"openai",
                "model_id":"gpt-test",
                "wework_model_kind":"codex-official"
            }),
            ..ExecutionRequest::default()
        };

        assert!(request_upstream(&request).unwrap().is_none());
    }

    #[test]
    fn official_chatgpt_stays_direct_with_a_custom_openai_base_url() {
        let _lock = crate::test_env::lock();
        let home = tempfile::tempdir().unwrap();
        let _restore = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        let _subscription = EnvRestore::capture(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV);
        env::set_var(WEGENT_CODEX_HOME_ENV, home.path());
        env::set_var(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV, "true");
        fs::write(
            home.path().join("config.toml"),
            r#"openai_base_url="http://127.0.0.1:4567/v1""#,
        )
        .unwrap();
        let request = ExecutionRequest {
            model_config: json!({
                "model_provider":"openai",
                "model_id":"gpt-test",
                "wework_model_kind":"codex-official"
            }),
            ..ExecutionRequest::default()
        };

        assert!(request_upstream(&request).unwrap().is_none());
    }

    #[test]
    fn provider_resolution_never_reads_another_native_home() {
        let _lock = crate::test_env::lock();
        let directory = tempfile::tempdir().unwrap();
        let _root = EnvRestore::capture("WEGENT_WORKBENCH_HOME");
        let _home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        env::set_var("WEGENT_WORKBENCH_HOME", directory.path());
        let managed = directory.path().join("managed-codex");
        env::set_var(WEGENT_CODEX_HOME_ENV, &managed);
        let request: ExecutionRequest = serde_json::from_value(json!({
            "task_id":"named-provider", "team_id":12, "team_name":"agent", "team_namespace":"space",
            "user_name":"user1", "bot":[{"id":23,"name":"bot","shell_type":"Codex"}],
            "model_config":{"model_provider":"custom","model_id":"gpt-test"}
        }))
        .unwrap();
        let selected = request_home(&request).unwrap();
        assert_ne!(selected, managed);
        for (home, token) in [
            (&managed, "other-home-token"),
            (&selected, "selected-home-token"),
        ] {
            fs::create_dir_all(home).unwrap();
            fs::write(home.join("config.toml"), format!(
                "model_provider=\"custom\"\n[model_providers.custom]\nbase_url=\"http://127.0.0.1:3456/v1\"\nexperimental_bearer_token=\"{token}\"\nwire_api=\"responses\"\n"
            )).unwrap();
        }
        let (upstream, _) = request_upstream(&request).unwrap().unwrap();
        assert_eq!(upstream.api_key, "selected-home-token");
        fs::remove_file(selected.join("config.toml")).unwrap();
        assert!(request_upstream(&request).unwrap().is_none());
        assert!(build_codex_launch_config(&request)
            .unwrap_err()
            .contains("not configured in its native Home"));
    }
}
