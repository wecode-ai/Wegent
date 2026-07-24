// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;

use super::*;

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
        first.await.expect("first waiter should join").unwrap()["answers"]["choice"],
        "first"
    );
    assert_eq!(
        second.await.expect("second waiter should join").unwrap()["answers"]["choice"],
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
    assert!(config.contains("browser_navigate"));
    assert!(config.contains("personality = \"pragmatic\""));
    let _ = fs::remove_dir_all(root);
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

    let launch_config = build_codex_launch_config(&request);

    assert!(launch_config
        .config_overrides
        .contains(&CODEX_APPLY_PATCH_STREAMING_EVENTS_OVERRIDE.to_owned()));
    assert!(launch_config
        .config_overrides
        .contains(&CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING_OVERRIDE.to_owned()));
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
    let request = ExecutionRequest {
        model_config: json!({
            "model_id": "gpt-5.4",
            "model_provider": "wework-catalog"
        }),
        ..ExecutionRequest::default()
    };
    let launch_config = build_codex_launch_config(&request);

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

    let launch_config = build_codex_launch_config(&request);

    assert_eq!(
        launch_config.model_provider.as_deref(),
        Some(codex_model_catalog::PROVIDER_ID)
    );
    assert!(launch_config.local_proxy_registration.is_some());
    assert!(launch_config.config_overrides.iter().any(|value| {
        value.starts_with("model_providers.wework-router.base_url=\"http://127.0.0.1:")
            && value.contains("/v1/codex-router/model-")
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

    let launch_config = build_codex_launch_config(&request);
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

    let launch_config = build_codex_launch_config(&request);

    assert_eq!(
        launch_config.model_provider.as_deref(),
        Some(codex_model_catalog::PROVIDER_ID)
    );
    assert!(launch_config.config_overrides.iter().any(|override_value| {
        override_value.starts_with("model_providers.wework-router.base_url=\"http://127.0.0.1:")
            && override_value.contains("/v1/codex-router/model-")
    }));
    assert!(!launch_config
        .config_overrides
        .iter()
        .any(|override_value| override_value.contains("experimental_bearer_token")));
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

    let launch_config = build_codex_launch_config(&request);

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
fn codex_launch_config_does_not_forward_task_identity() {
    let request = ExecutionRequest {
        task_id: "task-525".to_owned(),
        auth_token: Some("task-jwt".to_owned()),
        skill_identity_token: Some("skill-jwt".to_owned()),
        user_name: Some("alice".to_owned()),
        prompt: Value::String("create a file".to_owned()),
        model_config: json!({
            "model_id": "gpt-5.5-codex",
        }),
        ..ExecutionRequest::default()
    };

    let launch_config = build_codex_launch_config(&request);
    let params = thread_start_params(&request, &launch_config);
    let config = params
        .get("config")
        .and_then(Value::as_object)
        .expect("thread config should include shell env");

    assert!(!launch_config.env.contains_key("WEGENT_TASK_ID"));
    assert!(!launch_config.env.contains_key("AUTH_TOKEN"));
    assert!(config
        .get("shell_environment_policy.set.WEGENT_TASK_ID")
        .is_none());
    assert!(config
        .get("shell_environment_policy.set.AUTH_TOKEN")
        .is_none());
    assert!(config
        .get("shell_environment_policy.set.WEGENT_SKILL_IDENTITY_TOKEN")
        .is_none());
    assert!(config
        .get("shell_environment_policy.set.WEGENT_SKILL_USER_NAME")
        .is_none());
}

#[test]
fn persistent_codex_app_server_launch_config_keeps_only_process_settings() {
    let request_launch_config = CodexLaunchConfig {
        env: BTreeMap::from([("HTTP_PROXY".to_owned(), "http://127.0.0.1:7890".to_owned())]),
        config_overrides: vec![
            "model_provider=wecode-openai".to_owned(),
            "model_catalog_json=\"/tmp/wework-models.json\"".to_owned(),
            "mcp_servers.wework.command=\"node\"".to_owned(),
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
    assert!(launch_config
        .config_overrides
        .contains(&"goals=true".to_owned()));
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
fn codex_run_state_keeps_commentary_agent_delta_out_of_final_content() {
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
            content: String::new()
        }
    );
}

#[test]
fn goal_created_during_turn_keeps_notification_reader_alive() {
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

    assert!(should_wait_for_goal_continuation(&outcome, &state));
}

#[test]
fn codex_run_state_keeps_commentary_channel_delta_out_of_final_content() {
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
            content: String::new()
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
fn codex_permission_profile_is_applied_to_thread_and_turn_requests() {
    let request = ExecutionRequest::default();
    let launch_config = CodexLaunchConfig::default();
    let thread_start = thread_start_params(&request, &launch_config);
    let thread_resume = thread_resume_params("thread-1", &request, &launch_config);
    let thread_fork = thread_fork_params("thread-1", None, &request, &launch_config);
    let turn_start = turn_start_params("thread-1", &request, &launch_config, Vec::new());

    for params in [thread_start, thread_resume, thread_fork, turn_start] {
        assert_eq!(
            params["permissions"],
            CODEX_DANGER_FULL_ACCESS_PERMISSION_PROFILE
        );
        assert!(params.get("sandboxPolicy").is_none());
        assert!(params.get("sandbox").is_none());
    }
}

#[test]
fn codex_permission_profile_validation_rejects_effective_downgrade() {
    let response = json!({
        "activePermissionProfile": {"id": ":workspace"},
        "sandbox": {"type": "workspaceWrite", "networkAccess": false},
    });

    let error = validate_codex_permission_profile("thread/resume", &response)
        .expect_err("workspace-write must not be accepted");

    assert!(error.contains("active_profile=:workspace"));
    assert!(error.contains("sandbox=workspaceWrite"));
}

#[test]
fn codex_permission_profile_validation_accepts_effective_full_access() {
    let response = json!({
        "activePermissionProfile": {"id": ":danger-full-access"},
        "sandbox": {"type": "dangerFullAccess"},
    });

    validate_codex_permission_profile("thread/resume", &response).unwrap();
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
    env::set_var("WEGENT_EXECUTOR_HOME", &home);
    env::set_var(WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR_ENV, "127.0.0.1:43127");
    let request = ExecutionRequest {
        task_id: "task:123".to_owned(),
        ..ExecutionRequest::default()
    };

    let launch_config = build_codex_launch_config(&request);
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
    assert_eq!(
        config["features.code_mode.direct_only_tool_namespaces"],
        json!([WEWORK_BROWSER_MCP_SERVER_NAME])
    );
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
fn active_root_turn_notification_uses_item_turn_id_and_ignores_completed_or_child_turns() {
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
        active_root_turn_notification_id(&active_item, &state).as_deref(),
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
        active_root_turn_notification_id(&completed_turn, &state),
        None
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
    assert_eq!(active_root_turn_notification_id(&child_item, &state), None);
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
