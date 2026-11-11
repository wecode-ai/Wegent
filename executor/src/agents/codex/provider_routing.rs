// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

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
        return Ok(None);
    }
    Ok(configured_codex_provider(
        &provider,
        runtime_proxy_url(&request.model_config),
        &request_home(request)?,
    )
    .map(|upstream| (upstream, "local_proxy_user_provider")))
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
    log_route(request, route)?;
    if let Some((mut upstream, _)) = upstream {
        inject_session_headers(&mut upstream.default_headers, &request.task_id);
        configure_codex_router(
            launch,
            route_scope,
            upstream,
            codex_request_model(request),
            request_model_switched(request),
            vision_sidecar_with_session_headers(&request.model_config, &request.task_id)?,
        );
    } else {
        let provider = request_provider(request)?;
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

fn log_route(request: &ExecutionRequest, route: &str) -> Result<(), String> {
    log_executor_event(
        "codex model route selected",
        &[
            ("task_id", request.task_id.clone()),
            ("route", route.to_owned()),
            ("provider", request_provider(request)?),
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
    fn builtin_provider_configuration_cannot_turn_native_auth_into_a_proxy_route() {
        let _lock = crate::test_env::lock();
        let home = tempfile::tempdir().unwrap();
        let _restore = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        env::set_var(WEGENT_CODEX_HOME_ENV, home.path());
        fs::write(
            home.path().join("config.toml"),
            r#"
[model_providers.openai]
base_url="https://synthetic.invalid/v1"
experimental_bearer_token="must-not-select"
"#,
        )
        .unwrap();
        let request = ExecutionRequest {
            model_config: json!({"model_provider":"openai","model_id":"gpt-test"}),
            ..ExecutionRequest::default()
        };
        assert!(request_upstream(&request).unwrap().is_none());
        let launch = build_codex_launch_config(&request).unwrap();
        assert!(launch.local_proxy_registration.is_none());
        let profile = super::super::native_provider::profile_for_test(&launch.config_overrides);
        assert_eq!(profile["requires_openai_auth"], true);
        assert!(profile.get("auth").is_none());
        assert!(profile.get("base_url").is_none());
    }

    #[test]
    fn provider_only_requests_and_user_config_share_the_same_router() {
        let _lock = crate::test_env::lock();
        let directory = tempfile::tempdir().unwrap();
        let _home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        env::set_var(WEGENT_CODEX_HOME_ENV, directory.path());
        fs::write(
            directory.path().join("config.toml"),
            r#"
model_provider = "custom"
[model_providers.custom]
base_url = "http://127.0.0.1:3456/v1"
experimental_bearer_token = "synthetic-token"
wire_api = "responses"
"#,
        )
        .unwrap();
        for user_config in [false, true] {
            let request = ExecutionRequest {
                task_id: format!("provider-selection-{user_config}"),
                model_config: json!({"model_id":"gpt-test", "model_provider":"custom",
                    "runtime_config":{"codex":{"use_user_config":user_config}}}),
                ..ExecutionRequest::default()
            };
            let (upstream, source) = request_upstream(&request).unwrap().unwrap();
            assert_eq!(source, "local_proxy_user_provider");
            assert_eq!(upstream.api_key, "synthetic-token");
            let launch = build_codex_launch_config(&request).unwrap();
            assert_eq!(
                launch.model_provider.as_deref(),
                Some(codex_model_catalog::PROVIDER_ID)
            );
            assert!(launch.local_proxy_registration.is_some());
            let thread_id = format!("thread-{user_config}");
            bind_local_proxy_thread(&launch, &thread_id).unwrap();
            assert!(local_model_proxy::thread_has_bound_route(&thread_id));
        }
    }

    #[test]
    fn explicit_payload_upstream_is_not_replaced_by_user_provider_config() {
        let _lock = crate::test_env::lock();
        let request = ExecutionRequest {
            model_config: json!({"model_provider":"custom", "base_url":"http://127.0.0.1:4567/v1", "api_key":"payload-token"}),
            ..ExecutionRequest::default()
        };
        let (upstream, source) = request_upstream(&request).unwrap().unwrap();
        assert_eq!(source, "local_proxy_payload");
        assert_eq!(upstream.base_url, "http://127.0.0.1:4567/v1");
        assert_eq!(upstream.api_key, "payload-token");
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
