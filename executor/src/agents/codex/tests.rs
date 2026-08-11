// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;

use super::*;

#[tokio::test]
async fn codex_request_preparation_stops_when_cancelled() {
    let (cancel_tx, mut cancellation) = oneshot::channel();
    cancel_tx
        .send(())
        .expect("cancellation receiver should remain available");

    let result =
        prepare_codex_execution_request(ExecutionRequest::default(), Some(&mut cancellation)).await;

    assert!(matches!(
        result,
        Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED
    ));
}

#[test]
fn codex_turn_start_rejects_completed_cancellation() {
    let (cancel_tx, cancellation) = oneshot::channel();
    cancel_tx
        .send(())
        .expect("cancellation receiver should remain available");
    let mut cancellation = Some(cancellation);

    assert_eq!(
        ensure_codex_turn_not_cancelled(&mut cancellation).unwrap_err(),
        CODEX_APP_SERVER_TURN_CANCELLED
    );
}

#[tokio::test]
async fn active_thread_tracking_counts_each_thread_independently() {
    let client = CodexAppServerClient::new("codex-active-thread-test");

    client.mark_thread_active("thread-1").await;
    client.mark_thread_active("thread-1").await;
    client.mark_thread_active("thread-2").await;
    client.mark_thread_idle("thread-1").await;

    {
        let state = client.state.lock().await;
        assert_eq!(state.active_threads.get("thread-1"), Some(&1));
        assert_eq!(state.active_threads.get("thread-2"), Some(&1));
    }

    client.mark_thread_idle("thread-1").await;
    client.mark_thread_idle("thread-2").await;
    assert!(client.state.lock().await.active_threads.is_empty());
}

#[tokio::test]
async fn interaction_answer_router_matches_reverse_order_answers() {
    let (sender, receiver) = mpsc::channel(2);
    let router = InteractionAnswerRouter::new(receiver);
    let first = {
        let router = router.clone();
        tokio::spawn(async move { router.receive("41".to_owned()).await })
    };
    let second = {
        let router = router.clone();
        tokio::spawn(async move { router.receive("42".to_owned()).await })
    };

    sender
        .send(json!({"requestId": 42, "answers": {"choice": "second"}}))
        .await
        .expect("second answer should be sent");
    sender
        .send(json!({"requestId": 41, "answers": {"choice": "first"}}))
        .await
        .expect("first answer should be sent");

    assert_eq!(
        first
            .await
            .expect("first waiter should join")
            .unwrap()
            .unwrap()["answers"]["choice"],
        "first"
    );
    assert_eq!(
        second
            .await
            .expect("second waiter should join")
            .unwrap()
            .unwrap()["answers"]["choice"],
        "second"
    );
}

#[tokio::test]
async fn interaction_answer_router_rejects_waiters_after_channel_closes() {
    let (sender, receiver) = mpsc::channel(1);
    let router = InteractionAnswerRouter::new(receiver);
    drop(sender);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if router.state.lock().await.closed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("router should observe the closed response channel");

    let result = tokio::time::timeout(
        Duration::from_secs(1),
        router.receive("closed-request".to_owned()),
    )
    .await
    .expect("closed router should not leave the waiter pending");

    assert_eq!(
        result.unwrap_err(),
        "request_user_input response router closed"
    );
}

#[test]
fn normalize_reasoning_effort_preserves_supported_codex_levels() {
    for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
        assert_eq!(normalize_reasoning_effort(Some(effort)), effort);
    }
}

#[test]
fn normalize_reasoning_effort_maps_aliases_to_supported_codex_levels() {
    for (value, expected) in [
        ("minimal", "low"),
        ("轻度", "low"),
        ("中等", "medium"),
        ("extra high", "xhigh"),
        ("x-high", "xhigh"),
        ("最高", "max"),
        ("maximum", "max"),
        ("极高", "ultra"),
    ] {
        assert_eq!(normalize_reasoning_effort(Some(value)), expected);
    }
}

#[test]
fn normalize_reasoning_effort_uses_default_for_disabled_or_unknown_values() {
    for value in [None, Some("off"), Some("unknown")] {
        assert_eq!(normalize_reasoning_effort(value), DEFAULT_REASONING_EFFORT);
    }
}

#[test]
fn streaming_patch_overrides_enable_freeform_apply_patch() {
    let overrides = codex_streaming_patch_config_overrides();
    assert!(overrides.contains(&"features.apply_patch_streaming_events=true".to_owned()));
    assert!(overrides.contains(&"features.apply_patch_freeform=true".to_owned()));
    assert!(overrides.contains(&"suppress_unstable_features_warning=true".to_owned()));
}

#[test]
fn persistent_app_server_uses_direct_mcp_tools() {
    let request_config = CodexLaunchConfig::default();

    let config = persistent_codex_app_server_launch_config(&request_config);

    assert!(!config
        .config_overrides
        .contains(&"features.tool_search=true".to_owned()));
    assert!(!config
        .config_overrides
        .contains(&"features.tool_search_always_defer_mcp_tools=false".to_owned()));
    assert!(config
        .config_overrides
        .contains(&CODEX_DISABLE_TOOL_CALL_MCP_ELICITATION_OVERRIDE.to_owned()));
}

#[test]
fn initialize_params_does_not_advertise_openai_form_elicitation_extension() {
    let params = initialize_params();

    assert_eq!(params["capabilities"]["experimentalApi"], true);
    assert!(params["capabilities"]
        .get("mcpServerOpenaiFormElicitation")
        .is_none());
}

#[test]
fn mcp_form_elicitation_maps_enum_names_to_request_user_input_options() {
    let params = json!({
        "serverName": "wegent-sites",
        "mode": "form",
        "message": "请选择内网访问范围。",
        "requestedSchema": {
            "type": "object",
            "properties": {
                "audience": {
                    "type": "string",
                    "title": "访问范围",
                    "description": "请选择站点发布到内网后的访问范围。",
                    "enum": ["all", "owner", "custom"],
                    "enumNames": ["所有人", "仅自己", "指定人"]
                }
            },
            "required": ["audience"]
        }
    });

    let payload = mcp_server_elicitation_request_user_input_params(&params)
        .expect("enum + enumNames form should map to request_user_input payload");

    assert_eq!(payload["itemId"], "mcp_server_elicitation");
    assert_eq!(payload["questions"][0]["id"], "audience");
    assert_eq!(payload["questions"][0]["header"], "访问范围");
    assert_eq!(
        payload["questions"][0]["options"],
        json!([
            {"label": "所有人", "description": "all"},
            {"label": "仅自己", "description": "owner"},
            {"label": "指定人", "description": "custom"}
        ])
    );
}

#[test]
fn wework_codex_home_defaults_to_executor_home_codex() {
    let _lock = crate::test_env::lock();
    let home = unique_test_path("wework-codex-home-default");
    let _executor_home = EnvRestore::capture("WEGENT_EXECUTOR_HOME");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

    env::set_var("WEGENT_EXECUTOR_HOME", &home);
    env::remove_var(WEGENT_CODEX_HOME_ENV);
    env::set_var(
        CODEX_HOME_ENV,
        home.join("user-codex-should-not-be-wework-home"),
    );

    assert_eq!(wework_codex_home(), home.join("codex"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn wework_codex_home_ignores_empty_executor_home() {
    let _lock = crate::test_env::lock();
    let _executor_home = EnvRestore::capture("WEGENT_EXECUTOR_HOME");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);

    env::set_var("WEGENT_EXECUTOR_HOME", "");
    env::remove_var(WEGENT_CODEX_HOME_ENV);

    let expected = dirs::home_dir()
        .map(|home| home.join(".wegent-executor").join("codex"))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor/codex"));
    assert_eq!(wework_codex_home(), expected);
}

#[test]
fn wework_codex_home_prefers_explicit_wework_home() {
    let _lock = crate::test_env::lock();
    let executor_home = unique_test_path("wework-codex-home-executor");
    let codex_home = unique_test_path("wework-codex-home-explicit");
    let _executor_home = EnvRestore::capture("WEGENT_EXECUTOR_HOME");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

    env::set_var("WEGENT_EXECUTOR_HOME", &executor_home);
    env::set_var(WEGENT_CODEX_HOME_ENV, &codex_home);
    env::set_var(CODEX_HOME_ENV, executor_home.join("ignored-codex"));

    assert_eq!(wework_codex_home(), codex_home);

    let _ = fs::remove_dir_all(executor_home);
    let _ = fs::remove_dir_all(codex_home);
}

#[test]
fn prepare_wework_codex_home_links_user_auth() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("wework-codex-home-auth");
    let user_codex_home = root.join("user-codex");
    let codex_home = root.join("wework-codex");
    let source_auth = user_codex_home.join("auth.json");
    let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

    fs::create_dir_all(source_auth.parent().expect("auth parent should exist"))
        .expect("user Codex home should be created");
    fs::write(&source_auth, br#"{"token":"shared"}"#).expect("auth should be written");
    env::set_var(CODEX_HOME_ENV, &user_codex_home);

    prepare_wework_codex_home(&codex_home).expect("Codex home should be prepared");

    let linked_auth = codex_home.join("auth.json");
    assert!(linked_auth.is_file());
    #[cfg(unix)]
    assert_eq!(
        fs::read_link(&linked_auth).expect("auth should be a symlink"),
        source_auth
    );

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn prepare_wework_codex_home_replaces_stale_auth_link() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("wework-codex-home-stale-auth");
    let user_codex_home = root.join("user-codex");
    let codex_home = root.join("wework-codex");
    let source_auth = user_codex_home.join("auth.json");
    let stale_source = root.join("missing-auth.json");
    let linked_auth = codex_home.join("auth.json");
    let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

    fs::create_dir_all(source_auth.parent().expect("auth parent should exist"))
        .expect("user Codex home should be created");
    fs::create_dir_all(&codex_home).expect("WeWork Codex home should be created");
    fs::write(&source_auth, br#"{"token":"shared"}"#).expect("auth should be written");
    std::os::unix::fs::symlink(&stale_source, &linked_auth)
        .expect("stale auth link should be created");
    env::set_var(CODEX_HOME_ENV, &user_codex_home);

    prepare_wework_codex_home(&codex_home).expect("Codex home should be prepared");

    assert_eq!(
        fs::read_link(&linked_auth).expect("auth should be a symlink"),
        source_auth
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn prepare_wework_codex_home_migrates_base_instruction_override() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("wework-codex-config-migration");
    let codex_home = root.join("codex");
    fs::create_dir_all(&codex_home).expect("Codex home should be created");
    fs::write(
        codex_home.join("config.toml"),
        "instructions = \"用中文回复\"\n",
    )
    .expect("legacy config should be written");

    prepare_wework_codex_home(&codex_home).expect("Codex config should be normalized");

    let config = fs::read_to_string(codex_home.join("config.toml"))
        .expect("normalized config should be readable");
    assert!(!config
        .lines()
        .any(|line| line.starts_with("instructions =")));
    assert!(config.contains("developer_instructions"));
    assert!(config.contains("用中文回复"));
    assert!(!config.contains("Wework 内置浏览器 routing:"));
    assert!(config.contains("personality = \"pragmatic\""));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_codex_instructions_take_precedence_over_developer_instructions() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("wework-codex-config-instruction-precedence");
    let codex_home = root.join("codex");
    fs::create_dir_all(&codex_home).expect("Codex home should be created");
    fs::write(
        codex_home.join("config.toml"),
        "instructions = \"legacy user instructions\"\n\
         developer_instructions = \"current user instructions\"\n",
    )
    .expect("legacy config should be written");

    assert_eq!(
        read_wework_codex_user_instructions(&codex_home)
            .expect("user instructions should be readable"),
        "legacy user instructions"
    );

    prepare_wework_codex_home(&codex_home).expect("Codex config should be normalized");
    let config = fs::read_to_string(codex_home.join("config.toml"))
        .expect("normalized config should be readable");
    assert!(!config
        .lines()
        .any(|line| line.starts_with("instructions =")));
    assert!(config.contains("developer_instructions = \"legacy user instructions\""));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn codex_launch_config_error_cleans_generated_files() {
    let root = unique_test_path("codex-launch-config-cleanup");
    let generated_file = root.join("generated-image.png");
    fs::create_dir_all(&root).expect("test directory should be created");
    fs::write(&generated_file, "generated image").expect("generated file should be written");

    let result = cleanup_generated_files_on_error::<()>(
        std::slice::from_ref(&generated_file),
        Err("invalid".to_owned()),
    );

    assert!(result.is_err());
    assert!(!generated_file.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn prepare_wework_codex_home_removes_repeated_browser_instructions() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("wework-codex-config-browser-migration");
    let codex_home = root.join("codex");
    fs::create_dir_all(&codex_home).expect("Codex home should be created");
    fs::write(
        codex_home.join("config.toml"),
        r#"developer_instructions = """
用中文回复

Wework 内置浏览器 routing:
- prior generated version

Wework 内置浏览器 routing:
- current generated version
"""
"#,
    )
    .expect("legacy config should be written");

    prepare_wework_codex_home(&codex_home).expect("Codex config should be normalized");

    let config = fs::read_to_string(codex_home.join("config.toml"))
        .expect("normalized config should be readable");
    assert!(config.contains("用中文回复"));
    assert!(!config.contains("Wework 内置浏览器 routing:"));
    assert_eq!(
        read_wework_codex_user_instructions(&codex_home)
            .expect("user instructions should be readable"),
        "用中文回复"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn prepare_wework_codex_home_removes_browser_only_developer_instructions() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("wework-codex-config-browser-only-migration");
    let codex_home = root.join("codex");
    fs::create_dir_all(&codex_home).expect("Codex home should be created");
    fs::write(
        codex_home.join("config.toml"),
        format!(
            "developer_instructions = {instructions:?}\n",
            instructions = WEWORK_EMBEDDED_BROWSER_DEVELOPER_INSTRUCTIONS
        ),
    )
    .expect("legacy config should be written");

    prepare_wework_codex_home(&codex_home).expect("Codex config should be normalized");

    let config = fs::read_to_string(codex_home.join("config.toml"))
        .expect("normalized config should be readable");
    assert!(!config.contains("developer_instructions"));
    assert!(!config.contains("Wework 内置浏览器 routing:"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn strip_wework_browser_instructions_removes_all_generated_versions() {
    let instructions = "用中文回复\n\nWework 内置浏览器 routing:\n- prior generated version\
        \n\nWework 内置浏览器 routing:\n- current generated version";

    assert_eq!(
        strip_wework_browser_instructions(instructions),
        "用中文回复"
    );
}

#[test]
fn codex_launch_config_enables_streaming_patch_updates() {
    let request = ExecutionRequest {
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5-codex",
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");

    assert!(launch_config
        .config_overrides
        .contains(&CODEX_APPLY_PATCH_STREAMING_EVENTS_OVERRIDE.to_owned()));
    assert!(launch_config
        .config_overrides
        .contains(&CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING_OVERRIDE.to_owned()));
    assert!(launch_config
        .config_overrides
        .contains(&CODEX_DISABLE_TOOL_CALL_MCP_ELICITATION_OVERRIDE.to_owned()));
}

#[test]
fn custom_model_without_catalog_entry_uses_upstream_id() {
    let request = ExecutionRequest {
        model_config: json!({
        "model_id": "kimi-for-coding",
        "tool_profile": "function",
        "codex_responses_compat_proxy": true
        }),
        ..ExecutionRequest::default()
    };

    assert_eq!(
        codex_request_model(&request).as_deref(),
        Some("kimi-for-coding")
    );
}

#[test]
fn explicit_third_party_responses_upstream_bridges_app_tools_by_default() {
    let upstream = explicit_codex_upstream(
        &json!({
            "model_id": "gpt-5.6-sol",
            "upstream_api_format": "openai-responses"
        }),
        "https://example.com",
        "secret",
    );

    assert!(!upstream.convert_custom_tools);
    assert!(!upstream.native_tool_search);
    assert!(!upstream.native_namespace_tools);
}

#[test]
fn explicit_upstream_reads_native_app_tool_capabilities() {
    let upstream = explicit_codex_upstream(
        &json!({
            "model_id": "native-responses-model",
            "upstream_api_format": "openai-responses",
            "native_tool_search": true,
            "native_namespace_tools": true
        }),
        "https://example.com",
        "secret",
    );

    assert!(upstream.native_tool_search);
    assert!(upstream.native_namespace_tools);
}

#[test]
fn function_tool_profile_enables_responses_tool_conversion() {
    let upstream = explicit_codex_upstream(
        &json!({
            "model_id": "gateway-model",
            "upstream_api_format": "openai-responses",
            "tool_profile": "function"
        }),
        "https://example.com",
        "secret",
    );

    assert!(upstream.convert_custom_tools);
}

#[test]
fn parses_vision_sidecar_from_model_config() {
    let sidecar = vision_sidecar_upstream(&json!({
        "proxy": {"url": "http://127.0.0.1:7890"},
        "vision_sidecar": {
            "enabled": true,
            "request_url": "https://vision.example/v1/chat/completions",
            "api_format": "openai-chat-completions",
            "api_key": "vision-key",
            "model_id": "vision-model",
            "max_descriptions_per_turn": 4,
            "timeout_ms": 12_000
        }
    }))
    .expect("valid vision sidecar")
    .expect("configured vision sidecar");

    assert_eq!(
        sidecar.request_url,
        "https://vision.example/v1/chat/completions"
    );
    assert_eq!(sidecar.api_format, "openai-chat-completions");
    assert_eq!(sidecar.api_key, "vision-key");
    assert_eq!(sidecar.model_id, "vision-model");
    assert_eq!(sidecar.max_descriptions_per_turn, 4);
    assert_eq!(sidecar.timeout, Duration::from_secs(12));
    assert_eq!(sidecar.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
}

#[test]
fn vision_sidecar_allows_zero_descriptions_to_disable_calls_fail_closed() {
    let sidecar = vision_sidecar_upstream(&json!({
        "vision_sidecar": {
            "request_url": "https://vision.example/v1/responses",
            "model_id": "vision-model",
            "max_descriptions_per_turn": 0
        }
    }))
    .expect("valid vision sidecar")
    .expect("configured vision sidecar");

    assert_eq!(sidecar.max_descriptions_per_turn, 0);
}

#[test]
fn vision_sidecar_rejects_invalid_configuration_and_honors_disable() {
    assert!(vision_sidecar_upstream(&json!({
        "visionSidecar": {
            "requestUrl": "https://vision.example/v1/responses",
            "modelId": "vision-model",
            "apiFormat": "openai-embeddings"
        }
    }))
    .is_err());
    assert!(vision_sidecar_upstream(&json!({
        "vision_sidecar": {"model_id": "vision-model"}
    }))
    .is_err());
    assert!(vision_sidecar_upstream(&json!({
        "vision_sidecar": {
            "request_url": "https://vision.example/v1/responses"
        }
    }))
    .is_err());
    assert!(vision_sidecar_upstream(&json!({
        "vision_sidecar": {
            "enabled": false,
            "request_url": "https://vision.example/v1/responses",
            "model_id": "vision-model"
        }
    }))
    .expect("disabled sidecar")
    .is_none());
}

#[test]
fn explicit_upstream_uses_configured_max_output_tokens() {
    let upstream = explicit_codex_upstream(
        &json!({
            "model_id": "moonshot-kimi-k3",
            "upstream_api_format": "anthropic-messages",
            "max_output_tokens": 96_000
        }),
        "https://example.com",
        "secret",
    );

    assert_eq!(upstream.max_output_tokens, Some(96_000));
}

#[test]
fn kimi_k3_profile_uses_the_built_in_catalog_entry() {
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "kimi-k3",
            "tool_profile": "function",
            "codex_catalog_model_id": codex_model_catalog::KIMI_K3_MODEL,
            "codex_responses_compat_proxy": true
        }),
        ..ExecutionRequest::default()
    };

    assert_eq!(
        codex_request_model(&request).as_deref(),
        Some(codex_model_catalog::KIMI_K3_MODEL)
    );
}

#[test]
fn cloud_model_uses_provider_model_id_for_catalog_capabilities() {
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "openai-gpt-5.6-luna(海外)",
            "codex_catalog_model_id": "gpt-5.6-luna",
            "codex_responses_compat_proxy": true
        }),
        ..ExecutionRequest::default()
    };

    assert_eq!(
        codex_request_model(&request).as_deref(),
        Some("gpt-5.6-luna")
    );
}

#[test]
fn shell_profile_uses_explicit_catalog_capabilities() {
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "openai-gpt-5.6-luna(海外)",
            "codex_catalog_model_id": "gpt-5.6-luna",
            "tool_profile": "shell",
            "codex_responses_compat_proxy": true
        }),
        ..ExecutionRequest::default()
    };

    assert_eq!(
        codex_request_model(&request).as_deref(),
        Some("gpt-5.6-luna")
    );
}

#[test]
fn custom_shell_profile_without_catalog_entry_uses_upstream_id() {
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "native-model",
            "tool_profile": "shell",
            "codex_responses_compat_proxy": true
        }),
        ..ExecutionRequest::default()
    };

    assert_eq!(
        codex_request_model(&request).as_deref(),
        Some("native-model")
    );
}

#[test]
fn internal_catalog_provider_is_never_used_for_thread_inference() {
    let _lock = crate::test_env::lock();
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "gpt-5.4",
            "model_provider": "wework-catalog"
        }),
        ..ExecutionRequest::default()
    };
    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");

    assert_eq!(launch_config.model_provider.as_deref(), Some("openai"));
    for params in [
        thread_start_params(&request, &launch_config),
        thread_resume_params("thread-1", &request, &launch_config),
        thread_fork_params("thread-1", None, &request, &launch_config),
    ] {
        assert_eq!(params["modelProvider"], "openai");
    }
}

#[test]
fn configured_inference_provider_reads_the_unmodified_user_config() {
    let root = unique_test_path("configured-inference-provider");
    fs::create_dir_all(&root).expect("test directory should be created");
    let config_path = root.join("config.toml");
    fs::write(
        &config_path,
        "model_provider = \"wework-e2e\"\n[model_providers.wework-e2e]\nbase_url = \"http://127.0.0.1/v1\"\n",
    )
    .expect("config should be written");

    assert_eq!(
        configured_inference_model_provider_from_path(&config_path),
        "wework-e2e"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn user_configured_provider_routes_inference_through_the_local_router() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("configured-provider-router");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _api_key = EnvRestore::capture("WEWORK_TEST_MODEL_API_KEY");
    fs::create_dir_all(&root).expect("test directory should be created");
    fs::write(
        root.join("config.toml"),
        "model_provider = \"wework-e2e\"\n[model_providers.wework-e2e]\nbase_url = \"http://127.0.0.1:3456/v1\"\nenv_key = \"WEWORK_TEST_MODEL_API_KEY\"\nwire_api = \"responses\"\n",
    )
    .expect("config should be written");
    env::set_var(WEGENT_CODEX_HOME_ENV, &root);
    env::set_var("WEWORK_TEST_MODEL_API_KEY", "test-key");
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "gpt-test",
            "runtime_config": {
                "codex": {
                    "use_user_config": true,
                    "configured": true
                }
            }
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");

    assert_eq!(
        launch_config.model_provider.as_deref(),
        Some(codex_model_catalog::PROVIDER_ID)
    );
    assert!(launch_config.local_proxy_registration.is_some());
    assert!(launch_config.config_overrides.iter().any(|value| {
        value.starts_with("model_providers.wework-router.base_url=\"http://127.0.0.1:")
            && value.contains("/v1/codex-router/task-")
    }));
    for params in [
        thread_start_params(&request, &launch_config),
        thread_resume_params("thread-1", &request, &launch_config),
        thread_fork_params("thread-1", None, &request, &launch_config),
    ] {
        assert_eq!(params["modelProvider"], codex_model_catalog::PROVIDER_ID);
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn user_configured_third_party_responses_provider_bridges_app_tools() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("configured-provider-native-responses");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _api_key = EnvRestore::capture("WEWORK_TEST_MODEL_API_KEY");
    fs::create_dir_all(&root).expect("test directory should be created");
    fs::write(
        root.join("config.toml"),
        "model_provider = \"wework-e2e\"\n[model_providers.wework-e2e]\nbase_url = \"http://127.0.0.1:3456/v1\"\nenv_key = \"WEWORK_TEST_MODEL_API_KEY\"\nwire_api = \"responses\"\nupstream_api_format = \"openai-responses\"\n",
    )
    .expect("config should be written");
    env::set_var(WEGENT_CODEX_HOME_ENV, &root);
    env::set_var("WEWORK_TEST_MODEL_API_KEY", "test-key");

    let upstream = configured_codex_provider("wework-e2e", Some("http://127.0.0.1:7890"))
        .expect("configured provider");

    assert_eq!(upstream.api_format, "openai-responses");
    assert_eq!(
        upstream.request_url.as_deref(),
        Some("http://127.0.0.1:3456/v1/responses")
    );
    assert_eq!(upstream.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
    assert!(!upstream.convert_custom_tools);
    assert!(!upstream.native_tool_search);
    assert!(!upstream.native_namespace_tools);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn user_configured_provider_honors_native_app_tool_capabilities() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("configured-openai-native-app-tools");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _api_key = EnvRestore::capture("WEWORK_TEST_MODEL_API_KEY");
    fs::create_dir_all(&root).expect("test directory should be created");
    fs::write(
        root.join("config.toml"),
        "model_provider = \"native-responses\"\n[model_providers.native-responses]\nbase_url = \"https://api.example.com/v1\"\nenv_key = \"WEWORK_TEST_MODEL_API_KEY\"\nwire_api = \"responses\"\nnative_tool_search = true\nnative_namespace_tools = true\n",
    )
    .expect("config should be written");
    env::set_var(WEGENT_CODEX_HOME_ENV, &root);
    env::set_var("WEWORK_TEST_MODEL_API_KEY", "test-key");

    let upstream =
        configured_codex_provider("native-responses", None).expect("configured provider");

    assert!(upstream.native_tool_search);
    assert!(upstream.native_namespace_tools);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn user_configured_provider_converts_tools_for_non_responses_upstreams() {
    let _lock = crate::test_env::lock();
    let root = unique_test_path("configured-provider-anthropic");
    let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _api_key = EnvRestore::capture("WEWORK_TEST_MODEL_API_KEY");
    fs::create_dir_all(&root).expect("test directory should be created");
    fs::write(
        root.join("config.toml"),
        "model_provider = \"wework-e2e\"\n[model_providers.wework-e2e]\nbase_url = \"http://127.0.0.1:3456/v1\"\nenv_key = \"WEWORK_TEST_MODEL_API_KEY\"\nwire_api = \"responses\"\nupstream_api_format = \"anthropic-messages\"\n",
    )
    .expect("config should be written");
    env::set_var(WEGENT_CODEX_HOME_ENV, &root);
    env::set_var("WEWORK_TEST_MODEL_API_KEY", "test-key");

    let upstream = configured_codex_provider("wework-e2e", None).expect("configured provider");

    assert_eq!(upstream.api_format, "anthropic-messages");
    assert_eq!(
        upstream.request_url.as_deref(),
        Some("http://127.0.0.1:3456/v1/messages")
    );
    assert!(upstream.convert_custom_tools);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn configured_inference_provider_rejects_the_internal_catalog_provider() {
    let root = unique_test_path("configured-catalog-provider");
    fs::create_dir_all(&root).expect("test directory should be created");
    let config_path = root.join("config.toml");
    fs::write(&config_path, "model_provider = \"wework-catalog\"\n")
        .expect("config should be written");

    assert_eq!(
        configured_inference_model_provider_from_path(&config_path),
        "openai"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn codex_launch_config_forwards_web_search_mode() {
    let request = ExecutionRequest {
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5-codex",
            "web_search": "disabled",
            "image_generation": false,
            "model_context_window": 128000,
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");
    let params = thread_start_params(&request, &launch_config);
    let config = params
        .get("config")
        .and_then(Value::as_object)
        .expect("thread config should be present");

    assert_eq!(config.get("web_search"), Some(&json!("disabled")));
    assert_eq!(config.get("features.image_generation"), Some(&json!(false)));
    assert_eq!(config.get("model_context_window"), Some(&json!(128000)));
}

#[test]
fn codex_launch_config_defaults_context_window_to_256k() {
    let request = ExecutionRequest {
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "moonshot-kimi-k3",
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");
    let params = thread_start_params(&request, &launch_config);
    let config = params
        .get("config")
        .and_then(Value::as_object)
        .expect("thread config should be present");

    assert_eq!(config.get("model_context_window"), Some(&json!(262_144)));
}

#[test]
fn codex_launch_config_routes_marked_responses_models_through_compat_proxy() {
    let request = ExecutionRequest {
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "mimo-v2.5-pro",
            "base_url": "http://models.local/v1",
            "api_key": "sk-local",
            "api_format": "responses",
            "codex_responses_compat_proxy": true,
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");

    assert_eq!(
        launch_config.model_provider.as_deref(),
        Some(codex_model_catalog::PROVIDER_ID)
    );
    assert!(launch_config.config_overrides.iter().any(|override_value| {
        override_value.starts_with("model_providers.wework-router.base_url=\"http://127.0.0.1:")
            && override_value.contains("/v1/codex-router/task-")
    }));
    assert!(!launch_config
        .config_overrides
        .iter()
        .any(|override_value| override_value.contains("experimental_bearer_token")));
}

#[test]
fn codex_launch_config_keeps_one_proxy_address_when_a_task_changes_models() {
    let task_id = "codex-launch-config-stable-model-switch-task".to_owned();
    let luna_request = ExecutionRequest {
        task_id: task_id.clone(),
        model_config: json!({
            "model_id": "gpt-5.6-luna",
            "base_url": "http://luna.local/v1",
            "api_key": "luna-key",
            "api_format": "responses",
            "codex_responses_compat_proxy": true,
        }),
        ..ExecutionRequest::default()
    };
    let sol_request = ExecutionRequest {
        task_id,
        model_config: json!({
            "model_id": "gpt-5.6-sol",
            "base_url": "http://sol.local/v1",
            "api_key": "sol-key",
            "api_format": "responses",
            "codex_responses_compat_proxy": true,
        }),
        ..ExecutionRequest::default()
    };

    let luna_config =
        build_codex_launch_config(&luna_request).expect("Luna launch config should be built");
    let sol_config =
        build_codex_launch_config(&sol_request).expect("Sol launch config should be built");
    let proxy_url = |config: &CodexLaunchConfig| {
        config
            .config_overrides
            .iter()
            .find(|value| value.starts_with("model_providers.wework-router.base_url="))
            .expect("local proxy base URL")
            .to_owned()
    };

    assert_eq!(proxy_url(&luna_config), proxy_url(&sol_config));
    assert!(luna_config
        .config_overrides
        .contains(&"model=gpt-5.6-luna".to_owned()));
    assert!(sol_config
        .config_overrides
        .contains(&"model=gpt-5.6-sol".to_owned()));
}

#[test]
fn codex_launch_config_forwards_runtime_proxy_env() {
    let request = ExecutionRequest {
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5-codex",
            "proxy": {
                "url": "http://127.0.0.1:7890"
            },
            "runtime_config": {
                "codex": {
                    "use_proxy": true
                }
            }
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");

    assert_eq!(
        launch_config.env.get("HTTP_PROXY").map(String::as_str),
        Some("http://127.0.0.1:7890")
    );
    assert_eq!(
        launch_config.env.get("HTTPS_PROXY").map(String::as_str),
        Some("http://127.0.0.1:7890")
    );
    assert_eq!(
        launch_config.env.get("ALL_PROXY").map(String::as_str),
        Some("http://127.0.0.1:7890")
    );
}

#[test]
fn required_loopback_hosts_are_merged_into_no_proxy() {
    assert_eq!(
        merge_required_no_proxy(Some("example.com, localhost")),
        "example.com,localhost,127.0.0.1,::1,host.docker.internal"
    );
    assert_eq!(
        merge_required_no_proxy(Some("LOCALHOST,127.0.0.1,::1,HOST.DOCKER.INTERNAL")),
        "LOCALHOST,127.0.0.1,::1,HOST.DOCKER.INTERNAL"
    );
    assert_eq!(merge_required_no_proxy(None), DEFAULT_NO_PROXY);
}

#[test]
fn codex_launch_config_forwards_task_identity_to_thread_only() {
    let request = ExecutionRequest {
        task_id: "task-525".to_owned(),
        auth_token: Some("task-jwt".to_owned()),
        runtime_auth_token: Some("runtime-jwt".to_owned()),
        skill_identity_token: Some("skill-jwt".to_owned()),
        user_name: Some("alice".to_owned()),
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5-codex",
        }),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");
    let params = thread_start_params(&request, &launch_config);
    let config = params
        .get("config")
        .and_then(Value::as_object)
        .expect("thread config should include shell env");

    assert!(!launch_config.env.contains_key("WEGENT_TASK_ID"));
    assert!(!launch_config.env.contains_key("AUTH_TOKEN"));
    assert!(!launch_config.env.contains_key("WEGENT_RUNTIME_AUTH_TOKEN"));
    assert!(!launch_config
        .env
        .contains_key("WEGENT_SKILL_IDENTITY_TOKEN"));
    assert!(!launch_config.env.contains_key("WEGENT_SKILL_USER_NAME"));
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_TASK_ID"],
        "task-525"
    );
    assert_eq!(
        config["shell_environment_policy.set.AUTH_TOKEN"],
        "task-jwt"
    );
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_RUNTIME_AUTH_TOKEN"],
        "runtime-jwt"
    );
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_SKILL_IDENTITY_TOKEN"],
        "skill-jwt"
    );
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_SKILL_USER_NAME"],
        "alice"
    );
}

#[test]
fn turn_start_params_refreshes_task_identity_shell_environment() {
    let request = ExecutionRequest {
        task_id: "task-525".to_owned(),
        auth_token: Some("task-jwt".to_owned()),
        runtime_auth_token: Some("runtime-jwt".to_owned()),
        skill_identity_token: Some("skill-jwt".to_owned()),
        user_name: Some("alice".to_owned()),
        prompt: Value::String("continue".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5-codex",
        }),
        ..ExecutionRequest::default()
    };

    let mut launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");
    launch_config
        .config_overrides
        .push("model_provider=wework-router".to_owned());

    let params = turn_start_params("thread-1", &request, &launch_config, Vec::new());
    let config = params
        .get("config")
        .and_then(Value::as_object)
        .expect("turn config should include shell env");

    assert_eq!(
        config["shell_environment_policy.set.WEGENT_TASK_ID"],
        "task-525"
    );
    assert_eq!(
        config["shell_environment_policy.set.AUTH_TOKEN"],
        "task-jwt"
    );
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_RUNTIME_AUTH_TOKEN"],
        "runtime-jwt"
    );
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_SKILL_IDENTITY_TOKEN"],
        "skill-jwt"
    );
    assert_eq!(
        config["shell_environment_policy.set.WEGENT_SKILL_USER_NAME"],
        "alice"
    );
    assert!(config.contains_key("shell_environment_policy.set.PATH"));
    assert!(config.get("model_provider").is_none());
}

#[test]
fn persistent_codex_app_server_launch_config_keeps_only_process_settings() {
    let request_launch_config = CodexLaunchConfig {
        env: BTreeMap::from([("HTTP_PROXY".to_owned(), "http://127.0.0.1:7890".to_owned())]),
        config_overrides: vec![
            "model_provider=wecode-openai".to_owned(),
            "model_catalog_json=\"/tmp/wework-models.json\"".to_owned(),
            "mcp_servers.wework.command=\"node\"".to_owned(),
            "shell_environment_policy.set.WEGENT_TASK_ID=\"task-525\"".to_owned(),
            "shell_environment_policy.set.AUTH_TOKEN=\"task-jwt\"".to_owned(),
            "shell_environment_policy.set.WEGENT_RUNTIME_AUTH_TOKEN=\"runtime-jwt\"".to_owned(),
            "shell_environment_policy.set.WEGENT_SKILL_IDENTITY_TOKEN=\"skill-jwt\"".to_owned(),
            "shell_environment_policy.set.WEGENT_SKILL_USER_NAME=\"alice\"".to_owned(),
        ],
        model_provider: Some("wecode-openai".to_owned()),
        effort: Some("high".to_owned()),
        summary: Some("auto".to_owned()),
        ..CodexLaunchConfig::default()
    };

    let launch_config = persistent_codex_app_server_launch_config(&request_launch_config);

    assert_eq!(
        launch_config.env.get("HTTP_PROXY").map(String::as_str),
        Some("http://127.0.0.1:7890")
    );
    assert!(launch_config
        .config_overrides
        .iter()
        .any(|value| value == "model_provider=wework-router"));
    assert!(!launch_config
        .config_overrides
        .iter()
        .any(|value| value.starts_with("model_catalog_json=")));
    for key in [
        "WEGENT_TASK_ID",
        "AUTH_TOKEN",
        "WEGENT_RUNTIME_AUTH_TOKEN",
        "WEGENT_SKILL_IDENTITY_TOKEN",
        "WEGENT_SKILL_USER_NAME",
    ] {
        assert!(!launch_config
            .config_overrides
            .iter()
            .any(|value| value.starts_with(&format!("shell_environment_policy.set.{key}="))));
    }
    assert!(launch_config
        .config_overrides
        .contains(&"goals=true".to_owned()));
    assert!(launch_config
        .config_overrides
        .contains(&"features.apply_patch_freeform=true".to_owned()));
    assert!(launch_config
        .config_overrides
        .contains(&"features.apply_patch_streaming_events=true".to_owned()));
    assert!(launch_config.model_provider.is_none());
    assert!(launch_config.effort.is_none());
    assert!(launch_config.summary.is_none());
}

#[test]
fn persistent_process_does_not_inherit_request_model_overrides() {
    assert_eq!(
        persistent_codex_app_server_launch_config(&CodexLaunchConfig::default()).config_overrides,
        persistent_codex_app_server_launch_config(&CodexLaunchConfig {
            config_overrides: vec!["model=gpt-custom".to_owned()],
            ..CodexLaunchConfig::default()
        })
        .config_overrides
    );
}

#[test]
fn codex_run_state_uses_commentary_agent_delta_as_fallback_final_content() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "phase": "commentary",
                "delta": "I will inspect."
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "I will inspect.".to_owned()
        }
    );
}

#[test]
fn codex_run_state_uses_reclassified_commentary_as_fallback_final_content() {
    let mut state = CodexRunState::default();

    for message in [
        json!({
            "method": "item/started",
            "params": {
                "item": {
                    "id": "msg-progress",
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": ""
                }
            }
        }),
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "itemId": "msg-progress",
                "delta": "I will inspect."
            }
        }),
        json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "msg-progress",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "I will inspect."
                }
            }
        }),
    ] {
        assert!(state.handle_message(&message).is_none());
    }

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "I will inspect.".to_owned()
        }
    );
}

#[test]
fn codex_run_state_uses_completed_commentary_without_item_ids_as_fallback() {
    let mut state = CodexRunState::default();

    for message in [
        json!({
            "method": "item/agentMessage/delta",
            "params": {
                "phase": "final_answer",
                "delta": "Final answer."
            }
        }),
        json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "I will inspect."
                }
            }
        }),
    ] {
        assert!(state.handle_message(&message).is_none());
    }

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "I will inspect.".to_owned()
        }
    );
}

#[test]
fn goal_created_during_turn_allows_the_current_run_to_settle() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "thread/goal/updated",
            "params": {
                "threadId": "thread-1",
                "goal": { "status": "active" }
            }
        }))
        .is_none());
    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "status": "completed" }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert!(!should_wait_for_goal_continuation(&outcome, &state, false));
    assert!(should_wait_for_goal_continuation(&outcome, &state, true));
}

#[test]
fn turn_started_sets_or_replaces_the_active_turn() {
    let state = CodexRunState::default();
    let notification = json!({
        "method": "turn/started",
        "params": {
            "threadId": "thread-1",
            "turn": { "id": "turn-2", "status": "inProgress" }
        }
    });

    assert_eq!(
        started_active_turn_id(None, &notification, &state),
        Some("turn-2".to_owned())
    );
    assert_eq!(
        started_active_turn_id(Some("turn-1"), &notification, &state),
        Some("turn-2".to_owned())
    );
    assert_eq!(
        started_active_turn_id(Some("turn-2"), &notification, &state),
        None
    );
}

#[test]
fn turn_start_response_resolves_the_active_turn_without_a_started_notification() {
    assert_eq!(
        turn_start_response_id(&json!({
            "turn": {
                "id": "turn-1",
                "status": "inProgress"
            }
        }))
        .as_deref(),
        Some("turn-1")
    );
    assert_eq!(
        turn_start_response_id(&json!({
            "turnId": "turn-2"
        }))
        .as_deref(),
        Some("turn-2")
    );
}

#[test]
fn item_notification_cannot_replace_the_active_turn() {
    let state = CodexRunState::default();
    let notification = json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-2",
            "item": {
                "id": "message-1",
                "type": "agentMessage",
                "text": "done"
            }
        }
    });

    assert_eq!(
        started_active_turn_id(Some("turn-1"), &notification, &state),
        None
    );
}

#[test]
fn codex_run_state_uses_commentary_channel_delta_as_fallback_final_content() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "channel": "commentary",
                "delta": "I will inspect."
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "I will inspect.".to_owned()
        }
    );
}

#[test]
fn codex_run_state_keeps_completed_plan_out_of_final_content() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "turn-1-plan",
                    "type": "plan",
                    "text": "# Plan\n\n- Execute the steps."
                }
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: String::new()
        }
    );
}

#[test]
fn codex_run_state_routes_item_id_deltas_by_started_phase() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/started",
            "params": {
                "item": {
                    "id": "msg-commentary",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": ""
                }
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "itemId": "msg-commentary",
                "delta": "I will inspect."
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "item/started",
            "params": {
                "item": {
                    "id": "msg-final",
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": ""
                }
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "itemId": "msg-final",
                "delta": "Done."
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "Done.".to_owned()
        }
    );
}

#[test]
fn codex_run_state_keeps_unphased_agent_delta_as_final_content() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "delta": "Current directory: /tmp/project"
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "Current directory: /tmp/project".to_owned()
        }
    );
}

#[test]
fn codex_run_state_uses_latest_completed_agent_message_in_same_turn() {
    let mut state = CodexRunState::default();

    for (id, text) in [
        ("msg-before-tool", "I found the failing step."),
        (
            "msg-after-tool",
            "The failure is caused by a stale lockfile.",
        ),
    ] {
        assert!(state
            .handle_message(&json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": id,
                        "type": "agentMessage",
                        "role": "assistant",
                        "text": text
                    }
                }
            }))
            .is_none());
    }

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "The failure is caused by a stale lockfile.".to_owned()
        }
    );
}

#[test]
fn codex_run_state_prefers_explicit_final_text_over_unphased_text() {
    let mut state = CodexRunState::default();

    for (id, phase, text) in [
        ("msg-uncertain", None, "I may need another tool."),
        ("msg-final", Some("final_answer"), "The task is complete."),
    ] {
        assert!(state
            .handle_message(&json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": id,
                        "type": "agentMessage",
                        "role": "assistant",
                        "phase": phase,
                        "text": text
                    }
                }
            }))
            .is_none());
    }

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "The task is complete.".to_owned()
        }
    );
}

#[test]
fn codex_run_state_does_not_duplicate_completed_text_after_matching_delta() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "itemId": "msg-final",
                "delta": "Done."
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "msg-final",
                    "type": "agentMessage",
                    "role": "assistant",
                    "text": "Done."
                }
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "Done.".to_owned()
        }
    );
}

#[test]
fn turn_start_params_includes_plan_collaboration_mode_when_requested() {
    let mut request = ExecutionRequest {
        prompt: Value::String("plan this".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5",
        }),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "collaborationMode".to_owned(),
        Value::String("plan".to_owned()),
    );
    let launch_config = CodexLaunchConfig {
        effort: Some("high".to_owned()),
        ..CodexLaunchConfig::default()
    };

    let params = turn_start_params(
        "thread-1",
        &request,
        &launch_config,
        vec![json!({"type": "text", "text": "plan this"})],
    );

    assert_eq!(params["collaborationMode"]["mode"], "plan");
    assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-5.5");
    assert_eq!(
        params["collaborationMode"]["settings"]["reasoningEffort"],
        "high"
    );
    assert!(params["collaborationMode"]["settings"]["developerInstructions"].is_null());
}

#[test]
fn turn_start_params_includes_client_user_message_id() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "client_user_message_id".to_owned(),
        Value::String("runtime-local-pane-1".to_owned()),
    );

    let params = turn_start_params(
        "thread-1",
        &request,
        &CodexLaunchConfig::default(),
        Vec::new(),
    );

    assert_eq!(params["clientUserMessageId"], "runtime-local-pane-1");
}

#[test]
fn turn_start_params_includes_output_schema() {
    let mut request = ExecutionRequest::default();
    let schema = json!({
        "type": "object",
        "properties": {
            "accepted": {"type": "boolean"}
        },
        "required": ["accepted"],
        "additionalProperties": false
    });
    request
        .extra
        .insert("output_schema".to_owned(), schema.clone());

    let params = turn_start_params(
        "thread-1",
        &request,
        &CodexLaunchConfig::default(),
        Vec::new(),
    );

    assert_eq!(params["outputSchema"], schema);
}

#[test]
fn thread_start_uses_paginated_history_mode() {
    let params = thread_start_params(&ExecutionRequest::default(), &CodexLaunchConfig::default());

    assert_eq!(params["historyMode"], "paginated");
}

#[test]
fn codex_thread_plan_trims_and_prioritizes_direct_thread() {
    let plan = codex_thread_plan(
        Some("  direct-thread  "),
        Some("fork-thread"),
        Some("/tmp/fork.jsonl"),
        Some("resume-thread"),
        &ExecutionRequest::default(),
        &CodexLaunchConfig::default(),
    );

    match plan.start {
        CodexThreadStart::Direct(thread_id) => assert_eq!(thread_id, "direct-thread"),
        CodexThreadStart::Request { operation, .. } => {
            panic!("expected direct thread, got {operation}")
        }
    }
    assert!(plan.fork_requested);
    assert!(plan.resume_requested);
}

#[test]
fn codex_thread_plan_ignores_empty_direct_thread_and_prioritizes_fork() {
    let plan = codex_thread_plan(
        Some("   "),
        Some("fork-thread"),
        Some("/tmp/fork.jsonl"),
        Some("resume-thread"),
        &ExecutionRequest::default(),
        &CodexLaunchConfig::default(),
    );

    match plan.start {
        CodexThreadStart::Request { operation, params } => {
            assert_eq!(operation, "thread/fork");
            assert_eq!(params["threadId"], "fork-thread");
            assert_eq!(params["path"], "/tmp/fork.jsonl");
        }
        CodexThreadStart::Direct(thread_id) => {
            panic!("expected fork request, got direct thread {thread_id}")
        }
    }
}

#[test]
fn codex_thread_plan_selects_resume_when_fork_is_absent() {
    let plan = codex_thread_plan(
        None,
        None,
        None,
        Some("resume-thread"),
        &ExecutionRequest::default(),
        &CodexLaunchConfig::default(),
    );

    match plan.start {
        CodexThreadStart::Request { operation, params } => {
            assert_eq!(operation, "thread/resume");
            assert_eq!(params["threadId"], "resume-thread");
        }
        CodexThreadStart::Direct(thread_id) => {
            panic!("expected resume request, got direct thread {thread_id}")
        }
    }
    assert!(plan.resume_requested);
    assert!(!plan.fork_requested);
}

#[test]
fn codex_thread_plan_starts_new_thread_without_identifiers() {
    let plan = codex_thread_plan(
        None,
        None,
        None,
        None,
        &ExecutionRequest::default(),
        &CodexLaunchConfig::default(),
    );

    match plan.start {
        CodexThreadStart::Request { operation, .. } => assert_eq!(operation, "thread/start"),
        CodexThreadStart::Direct(thread_id) => {
            panic!("expected start request, got direct thread {thread_id}")
        }
    }
    assert!(!plan.resume_requested);
    assert!(!plan.fork_requested);
}

#[test]
fn thread_id_from_response_validates_provider_and_requires_thread_id() {
    assert_eq!(
        thread_id_from_response(
            "thread/start",
            &json!({
                "thread": {
                    "id": "thread-1",
                    "modelProvider": "provider-1"
                }
            }),
            Some("provider-1"),
        )
        .unwrap(),
        "thread-1"
    );
    assert!(thread_id_from_response(
        "thread/resume",
        &json!({"thread": {"modelProvider": "provider-1"}}),
        Some("provider-1"),
    )
    .unwrap_err()
    .contains("did not return thread.id"));
    assert!(thread_id_from_response(
        "thread/fork",
        &json!({
            "thread": {
                "id": "thread-2",
                "modelProvider": "provider-2"
            }
        }),
        Some("provider-1"),
    )
    .unwrap_err()
    .contains("unexpected model provider"));
}

#[test]
fn thread_launch_params_include_execution_system_prompt_as_developer_instructions() {
    let request = ExecutionRequest {
        system_prompt: "Judge the supplied content without answering it.".to_owned(),
        ..ExecutionRequest::default()
    };
    let launch_config = CodexLaunchConfig {
        user_developer_instructions: "用中文回复".to_owned(),
        ..CodexLaunchConfig::default()
    };

    let thread_start = thread_start_params(&request, &launch_config);
    let thread_fork = thread_fork_params("thread-1", None, &request, &launch_config);
    let thread_resume = thread_resume_params("thread-1", &request, &launch_config);

    for params in [thread_start, thread_fork, thread_resume] {
        let instructions = params["developerInstructions"]
            .as_str()
            .expect("developer instructions should be a string");
        assert!(instructions
            .starts_with("用中文回复\n\nJudge the supplied content without answering it."));
        assert!(instructions.contains("Wework 内置浏览器 routing:"));
        assert!(instructions.contains("browser_open"));
    }
}

#[test]
fn codex_permission_profile_is_applied_to_thread_and_turn_requests() {
    let request = ExecutionRequest::default();
    let launch_config = CodexLaunchConfig::default();
    let thread_start = thread_start_params(&request, &launch_config);
    let thread_resume = thread_resume_params("thread-1", &request, &launch_config);
    let thread_fork = thread_fork_params("thread-1", None, &request, &launch_config);
    let turn_start = turn_start_params("thread-1", &request, &launch_config, Vec::new());

    for params in [thread_start, thread_resume, thread_fork, turn_start] {
        assert_eq!(params["permissions"], CODEX_WORKSPACE_PERMISSION_PROFILE);
        assert_eq!(
            params["approvalPolicy"],
            codex_runtime_approval_policy(&request)
        );
        assert!(params.get("sandboxPolicy").is_none());
        assert!(params.get("sandbox").is_none());
    }
}

#[test]
fn codex_full_access_permission_profile_is_applied_when_requested() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "runtime_permission_profile".to_owned(),
        Value::String(CODEX_DANGER_FULL_ACCESS_PERMISSION_PROFILE.to_owned()),
    );
    let launch_config = CodexLaunchConfig::default();

    for params in [
        thread_start_params(&request, &launch_config),
        thread_resume_params("thread-1", &request, &launch_config),
        thread_fork_params("thread-1", None, &request, &launch_config),
        turn_start_params("thread-1", &request, &launch_config, Vec::new()),
    ] {
        assert_eq!(
            params["permissions"],
            CODEX_DANGER_FULL_ACCESS_PERMISSION_PROFILE
        );
        assert_eq!(params["approvalPolicy"], "never");
    }
}

#[test]
fn codex_read_only_permission_profile_is_applied_to_supervisor_requests() {
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "runtime_permission_profile".to_owned(),
        Value::String(CODEX_READ_ONLY_PERMISSION_PROFILE.to_owned()),
    );
    let launch_config = CodexLaunchConfig::default();

    for params in [
        thread_start_params(&request, &launch_config),
        thread_resume_params("thread-1", &request, &launch_config),
        thread_fork_params("thread-1", None, &request, &launch_config),
        turn_start_params("thread-1", &request, &launch_config, Vec::new()),
    ] {
        assert_eq!(params["permissions"], CODEX_READ_ONLY_PERMISSION_PROFILE);
        assert_eq!(
            params["approvalPolicy"],
            codex_runtime_approval_policy(&request)
        );
    }
}

#[test]
fn codex_command_approval_response_preserves_user_decision() {
    let message = json!({
        "method": "item/commandExecution/requestApproval",
        "params": {"itemId": "command-1"}
    });

    assert_eq!(
        codex_approval_result(
            &message,
            &json!({
                "answers": {
                    CODEX_APPROVAL_QUESTION_ID: {"answers": ["allow_once"]}
                }
            }),
        )
        .unwrap(),
        json!({"decision": "accept"})
    );
    assert_eq!(
        codex_approval_result(
            &message,
            &json!({
                "answers": {
                    CODEX_APPROVAL_QUESTION_ID: {"answers": ["allow_session"]}
                }
            }),
        )
        .unwrap(),
        json!({"decision": "acceptForSession"})
    );
}

#[test]
fn codex_permissions_approval_returns_requested_profile_and_scope() {
    let message = json!({
        "method": "item/permissions/requestApproval",
        "params": {
            "itemId": "permissions-1",
            "permissions": {
                "network": {"enabled": true},
                "fileSystem": null
            }
        }
    });

    assert_eq!(
        codex_approval_result(
            &message,
            &json!({
                "answers": {
                    CODEX_APPROVAL_QUESTION_ID: {"answers": ["allow_session"]}
                }
            }),
        )
        .unwrap(),
        json!({
            "permissions": {
                "network": {"enabled": true},
                "fileSystem": null
            },
            "scope": "session"
        })
    );
}

#[test]
fn codex_thread_launch_disables_tool_call_mcp_elicitation() {
    let request = ExecutionRequest::default();
    let mut launch_config = CodexLaunchConfig::default();
    launch_config
        .config_overrides
        .push(CODEX_DISABLE_TOOL_CALL_MCP_ELICITATION_OVERRIDE.to_owned());

    let thread_start = thread_start_params(&request, &launch_config);
    let thread_resume = thread_resume_params("thread-1", &request, &launch_config);
    let thread_fork = thread_fork_params("thread-1", None, &request, &launch_config);

    for params in [thread_start, thread_resume, thread_fork] {
        assert_eq!(
            params["config"]["features.tool_call_mcp_elicitation"],
            false
        );
        assert_eq!(params["approvalPolicy"], "on-request");
    }
}

#[test]
fn codex_runtime_workspace_roots_are_applied_to_thread_and_turn_requests() {
    let request = ExecutionRequest {
        project_workspace_path: Some("/workspace/web".to_owned()),
        runtime_workspace_roots: vec!["/workspace/web".to_owned(), "/workspace/api".to_owned()],
        ..ExecutionRequest::default()
    };
    let launch_config = CodexLaunchConfig::default();
    let thread_start = thread_start_params(&request, &launch_config);
    let thread_resume = thread_resume_params("thread-1", &request, &launch_config);
    let thread_fork = thread_fork_params("thread-1", None, &request, &launch_config);
    let turn_start = turn_start_params("thread-1", &request, &launch_config, Vec::new());

    for params in [thread_start, thread_resume, thread_fork, turn_start] {
        assert_eq!(
            params["runtimeWorkspaceRoots"],
            json!(["/workspace/web", "/workspace/api"])
        );
    }
}

#[test]
fn codex_model_provider_validation_rejects_stale_loaded_provider() {
    let response = json!({
        "modelProvider": "wework-router",
        "thread": {"modelProvider": "wework-router"},
    });

    let error = validate_codex_model_provider("thread/resume", &response, Some("openai"))
        .expect_err("a stale provider must not start a turn");

    assert!(error.contains("expected=openai"));
    assert!(error.contains("actual=wework-router"));
}

#[test]
fn codex_model_provider_validation_accepts_requested_provider() {
    let response = json!({
        "modelProvider": "openai",
        "thread": {"modelProvider": "openai"},
    });

    validate_codex_model_provider("thread/resume", &response, Some("openai")).unwrap();
}

#[test]
fn turn_input_expands_absolute_skill_markdown_mentions_for_app_server() {
    let input = turn_input(&Value::String(
        "[$linear](/Users/me/.codex/plugins/linear/skills/linear/SKILL.md) triage".to_owned(),
    ));

    assert_eq!(
        input,
        vec![
            json!({"type": "text", "text": "$linear triage", "text_elements": []}),
            json!({
                "type": "skill",
                "name": "linear",
                "path": "/Users/me/.codex/plugins/linear/skills/linear/SKILL.md",
            }),
        ]
    );
}

#[test]
fn turn_input_expands_legacy_skill_markdown_mentions_for_app_server() {
    let input = turn_input(&Value::String(
        "[$linear](skill:///Users/me/.codex/plugins/linear/skills/linear/SKILL.md) triage"
            .to_owned(),
    ));

    assert_eq!(
        input,
        vec![
            json!({"type": "text", "text": "$linear triage", "text_elements": []}),
            json!({
                "type": "skill",
                "name": "linear",
                "path": "/Users/me/.codex/plugins/linear/skills/linear/SKILL.md",
            }),
        ]
    );
}

#[test]
fn turn_input_deduplicates_legacy_and_absolute_references_to_the_same_skill() {
    let input = turn_input(&Value::String(
        "[$linear](skill:///Users/me/skills/linear/SKILL.md) then [$linear](/Users/me/skills/linear/SKILL.md)"
            .to_owned(),
    ));

    assert_eq!(
        input,
        vec![
            json!({
                "type": "text",
                "text": "$linear then $linear",
                "text_elements": [],
            }),
            json!({
                "type": "skill",
                "name": "linear",
                "path": "/Users/me/skills/linear/SKILL.md",
            }),
        ]
    );
}

#[test]
fn turn_input_expands_app_and_plugin_markdown_mentions_for_app_server() {
    let input = turn_input(&Value::String(
        "Use [$calendar](app://google-calendar) and [$sample](plugin://sample@test)".to_owned(),
    ));

    assert_eq!(
        input,
        vec![
            json!({
                "type": "text",
                "text": "Use $calendar and @sample",
                "text_elements": [],
            }),
            json!({
                "type": "mention",
                "name": "calendar",
                "path": "app://google-calendar",
            }),
            json!({
                "type": "mention",
                "name": "sample",
                "path": "plugin://sample@test",
            }),
        ]
    );
}

#[test]
fn turn_input_binds_managed_plugin_mentions_to_the_plugin_entry_skill() {
    let root = unique_test_path("managed-plugin-skill-input");
    let codex_home = root.join("codex");
    let manifest_path = root.join("capabilities/manifest.json");
    let plugin_root = codex_home.join("plugins/cache/wegent/dingtalk/0.2.0");
    let skill_path = plugin_root.join("skills/dws/SKILL.md");
    fs::create_dir_all(skill_path.parent().expect("skill parent should exist"))
        .expect("skill directory should be created");
    fs::create_dir_all(plugin_root.join(".codex-plugin"))
        .expect("plugin manifest directory should be created");
    fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"dingtalk","version":"0.2.0","skills":"./skills/"}"#,
    )
    .expect("plugin manifest should be written");
    fs::write(
        &skill_path,
        "---\nname: dws\ndescription: DingTalk workspace\n---\n\n# DWS\n",
    )
    .expect("skill should be written");
    fs::create_dir_all(
        manifest_path
            .parent()
            .expect("capability manifest parent should exist"),
    )
    .expect("capability manifest directory should be created");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&json!({
            "plugins": {
                "dingtalk@wegent": {
                    "enabled": true,
                    "marketplace": "wegent",
                    "name": "dingtalk",
                    "version": "0.2.0"
                }
            }
        }))
        .expect("capability manifest should serialize"),
    )
    .expect("capability manifest should be written");

    let plugin_skills = PluginSkillResolver::load(&codex_home, &manifest_path);
    let input = turn_input_with_plugin_skills(
        &Value::String("[$钉钉](plugin://dingtalk@wegent) 检查我有哪些文档？".to_owned()),
        &plugin_skills,
    );

    assert_eq!(
        input,
        vec![
            json!({
                "type": "text",
                "text": "@钉钉 检查我有哪些文档？",
                "text_elements": [],
            }),
            json!({
                "type": "mention",
                "name": "钉钉",
                "path": "plugin://dingtalk@wegent",
            }),
            json!({
                "type": "skill",
                "name": "dingtalk:dws",
                "path": skill_path.display().to_string(),
            }),
        ]
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn turn_input_converts_composer_file_references_to_plain_paths() {
    let input = turn_input(&Value::String(
        "Inspect [$frontend](folder://%2FUsers%2Fme%2FMy%20Project%2Ffrontend) and [$auth.ts](file://%2FUsers%2Fme%2FMy%20Project%2Ffrontend%2Fauth.ts)"
            .to_owned(),
    ));

    assert_eq!(
        input,
        vec![json!({
            "type": "text",
            "text": "Inspect \"/Users/me/My Project/frontend\" and \"/Users/me/My Project/frontend/auth.ts\"",
            "text_elements": [],
        })]
    );
}

#[test]
fn codex_launch_config_includes_cdp_browser_mcp_server() {
    let _lock = crate::test_env::lock();
    let home = env::temp_dir().join(format!("codex-browser-mcp-{}", std::process::id()));
    let old_home = env::var_os("WEGENT_EXECUTOR_HOME");
    let old_bridge_addr = env::var_os(WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR_ENV);
    let old_bridge_token = env::var_os(WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV);
    env::set_var("WEGENT_EXECUTOR_HOME", &home);
    env::set_var(WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR_ENV, "127.0.0.1:43127");
    env::set_var(
        WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV,
        "bridge-test-token",
    );
    let request = ExecutionRequest {
        task_id: "task:123".to_owned(),
        ..ExecutionRequest::default()
    };

    let launch_config =
        build_codex_launch_config(&request).expect("Codex launch config should be built");
    let params = thread_start_params(&request, &launch_config);
    let config = params
        .get("config")
        .and_then(Value::as_object)
        .expect("thread config should be present");
    assert!(!config.contains_key("developer_instructions"));
    assert_eq!(
        config["skills.config"],
        json!([
            {
                "name": "browser:control-in-app-browser",
                "enabled": false,
            },
            {
                "name": "chrome:control-chrome",
                "enabled": false,
            },
        ])
    );
    assert_eq!(config["features.non_prefixed_mcp_tool_names"], true);
    assert!(!config.contains_key("features.code_mode.direct_only_tool_namespaces"));
    assert_eq!(
        config["mcp_servers.wework_browser.command"],
        env::current_exe().unwrap().display().to_string()
    );
    assert_eq!(
        config["mcp_servers.wework_browser.args"],
        json!(["browser-mcp-server"])
    );
    assert_eq!(config["mcp_servers.wework_browser.startup_timeout_sec"], 15);
    assert_eq!(config["mcp_servers.wework_browser.tool_timeout_sec"], 60);
    assert_eq!(
        config["mcp_servers.wework_browser.default_tools_approval_mode"],
        "approve"
    );
    assert_eq!(
        config["mcp_servers.wework_browser.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL"],
        "http://127.0.0.1:43127"
    );
    assert_eq!(
        config["mcp_servers.wework_browser.env.WEWORK_EMBEDDED_BROWSER_LABEL"],
        "workspace-browser-task-123"
    );
    assert_eq!(
        config["mcp_servers.wework_browser.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN"],
        "bridge-test-token"
    );

    if let Some(old_home) = old_home {
        env::set_var("WEGENT_EXECUTOR_HOME", old_home);
    } else {
        env::remove_var("WEGENT_EXECUTOR_HOME");
    }
    if let Some(old_bridge_addr) = old_bridge_addr {
        env::set_var(WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR_ENV, old_bridge_addr);
    } else {
        env::remove_var(WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR_ENV);
    }
    if let Some(old_bridge_token) = old_bridge_token {
        env::set_var(WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV, old_bridge_token);
    } else {
        env::remove_var(WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV);
    }
}

#[test]
fn turn_start_params_includes_default_collaboration_mode_when_requested() {
    let mut request = ExecutionRequest {
        prompt: Value::String("continue this".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5",
        }),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "collaborationMode".to_owned(),
        Value::String("default".to_owned()),
    );
    let launch_config = CodexLaunchConfig {
        effort: Some("medium".to_owned()),
        ..CodexLaunchConfig::default()
    };

    let params = turn_start_params(
        "thread-1",
        &request,
        &launch_config,
        vec![json!({"type": "text", "text": "continue this"})],
    );

    assert_eq!(params["collaborationMode"]["mode"], "default");
    assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-5.5");
    assert_eq!(
        params["collaborationMode"]["settings"]["reasoningEffort"],
        "medium"
    );
    assert!(params["collaborationMode"]["settings"]["developerInstructions"].is_null());
}

#[test]
fn thread_goal_set_params_maps_initial_goal() {
    let params = thread_goal_set_params(
        "thread-1",
        &json!({
            "objective": "ship the feature",
            "status": "paused",
            "tokenBudget": 1200,
        }),
    )
    .expect("initial goal should map to Codex goal params");

    assert_eq!(
        params,
        json!({
            "threadId": "thread-1",
            "objective": "ship the feature",
            "status": "paused",
            "tokenBudget": 1200,
        })
    );
}

#[test]
fn thread_goal_set_params_rejects_empty_objective() {
    let error = thread_goal_set_params("thread-1", &json!({"objective": "   "}))
        .expect_err("empty objective should be rejected");

    assert_eq!(error, "initial goal objective is required");
}

#[test]
fn root_turn_notification_uses_protocol_turn_id_and_ignores_child_turns() {
    let mut state = CodexRunState::default();
    state.set_root_thread_id("thread-root");

    let active_item = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-root",
            "turnId": "turn-current",
            "item": { "type": "reasoning" }
        }
    });
    assert_eq!(
        root_turn_notification_id(&active_item, &state).as_deref(),
        Some("turn-current")
    );

    let completed_turn = json!({
        "method": "turn/completed",
        "params": {
            "threadId": "thread-root",
            "turn": { "id": "turn-current", "status": "completed" }
        }
    });
    assert_eq!(
        root_turn_notification_id(&completed_turn, &state).as_deref(),
        Some("turn-current")
    );

    let child_item = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-root",
            "turnId": "child-turn",
            "agentPath": "/root/worker",
            "item": { "type": "reasoning" }
        }
    });
    assert_eq!(root_turn_notification_id(&child_item, &state), None);
}

#[test]
fn initial_progress_excludes_user_echo_retry_errors_and_subagents() {
    let mut state = CodexRunState::default();
    state.set_root_thread_id("thread-root");

    let user_echo = json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-root",
            "item": { "type": "userMessage", "text": "hello" }
        }
    });
    assert!(!codex_notification_has_initial_progress(&user_echo, &state));

    let retryable_error = json!({
        "method": "error",
        "params": {
            "threadId": "thread-root",
            "message": "Reconnecting... 1/5",
            "willRetry": true
        }
    });
    assert!(!codex_notification_has_initial_progress(
        &retryable_error,
        &state
    ));

    let subagent_tool = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-root",
            "agentPath": "/root/worker",
            "item": { "type": "commandExecution" }
        }
    });
    assert!(!codex_notification_has_initial_progress(
        &subagent_tool,
        &state
    ));

    let root_tool = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-root",
            "item": { "type": "commandExecution" }
        }
    });
    assert!(codex_notification_has_initial_progress(&root_tool, &state));
}

#[test]
fn codex_run_state_ignores_subagent_turn_completion() {
    let mut state = CodexRunState::default();

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "delta": "Still working"
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed",
                    "agent_path": "/root/worker"
                }
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "status": "completed",
                    "agent_path": "/root"
                }
            }
        }))
        .expect("root turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "Still working".to_owned()
        }
    );
}

#[test]
fn codex_run_state_ignores_cross_thread_final_deltas() {
    let mut state = CodexRunState::default();
    state.set_root_thread_id("root-thread");

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "child-thread",
                "turnId": "child-turn",
                "itemId": "msg-child",
                "delta": "child"
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "root-thread",
                "turnId": "root-turn",
                "itemId": "msg-root",
                "delta": "root"
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "root-thread",
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("root turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "root".to_owned()
        }
    );
}

#[test]
fn codex_run_state_ignores_cross_thread_turn_completion() {
    let mut state = CodexRunState::default();
    state.set_root_thread_id("root-thread");

    assert!(state
        .handle_message(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "root-thread",
                "turnId": "root-turn",
                "itemId": "msg-root",
                "delta": "root"
            }
        }))
        .is_none());
    assert!(state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "child-thread",
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .is_none());

    let outcome = state
        .handle_message(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "root-thread",
                "turn": {
                    "status": "completed"
                }
            }
        }))
        .expect("root turn completion should produce an outcome");

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "root".to_owned()
        }
    );
}
