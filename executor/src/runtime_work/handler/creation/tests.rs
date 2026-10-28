use super::*;

struct EnvGuard(Option<std::ffi::OsString>);
impl EnvGuard {
    fn home(path: &Path) -> Self {
        let previous = std::env::var_os("WEGENT_EXECUTOR_HOME");
        std::env::set_var("WEGENT_EXECUTOR_HOME", path);
        Self(previous)
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var("WEGENT_EXECUTOR_HOME", value),
            None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
        }
    }
}

fn profile(runtime: &str, name: &str) -> Value {
    json!({"runtime":runtime,"modelName":name,"label":name,"modelConfig":{
        "model_id":format!("upstream-{name}"),"api_key":format!("secret-{runtime}-{name}"),
        "base_url":"https://model.invalid","reasoning":{"effort":"medium"}
    }})
}

fn intent() -> Value {
    json!({"schemaVersion":2,"deviceId":"creation-device","taskId":"new-task",
        "runtime":"codex","message":"Implement the requested change","workspacePath":"/tmp/project",
        "modelSelection":{"modelName":"model-a","modelType":"runtime","options":{}},
        "executionRequest":{"model_config":{"model_id":"unrelated","api_key":"wrong-source-secret"}}
    })
}

#[tokio::test]
async fn creation_compiles_all_composer_fields_without_using_source_model_credentials() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path());
    let handler = RuntimeWorkRpcHandler::new("creation-device", "/bin/false");
    handler
        .sync_creation_model_profiles(
            json!({"profiles":[profile("codex","model-a"),profile("codex","model-b")]}),
        )
        .unwrap();
    let mut input = intent();
    input["executionRequest"]["fork_runtime"] = json!({"thread_id":"old-fork"});
    input["executionRequest"]["inherited_sessions"] = json!([{"thread_id":"old-session"}]);
    input["modelOptions"] = json!({"reasoning":"high","summary":"detailed","permissionMode":"workspace-write","speed":"fast","collaboration_mode":"plan"});
    input["runtimePermissionMode"] = json!("acceptEdits");
    input["projectInstructions"] = json!("Follow project rules");
    input["projectPlugins"] = json!([{"id":"plugin-a@market"}]);
    input["additionalSkills"] = json!([{"name":"skill-a","namespace":"team"}]);
    input["attachments"] =
        json!([{"file_path":"/tmp/requirements.md","filename":"requirements.md"}]);
    input["execution"] = json!({"workspace":{"source":"git_worktree","branch":"feature/creation"}});
    input["initialGoal"] = json!({"objective":"Complete the work","tokenBudget":12345});
    input["initialSupervisor"] = json!({"mode":"suggest","instructions":"Review progress","intervalSeconds":60,
        "modelSelection":{"modelName":"model-b","modelType":"runtime","options":{}}});
    input["additionalContext"] =
        json!({"selectedCode":{"kind":"untrusted","value":"selected code"}});
    let output = handler.compile_creation_intent(input).await.unwrap();
    let request = execution_request(&output).unwrap();
    assert_eq!(request.model_config["api_key"], "secret-codex-model-a");
    assert_eq!(request.model_config["reasoning"]["effort"], "high");
    assert_eq!(request.model_config["service_tier"], "fast");
    assert_eq!(request.model_config["reasoning"]["summary"], "detailed");
    assert_eq!(
        request.extra["runtime_permission_profile"],
        CODEX_WORKSPACE_PERMISSION_PROFILE
    );
    assert_eq!(request.extra["claude_permission_mode"], "acceptEdits");
    assert_eq!(request.extra["collaborationMode"], "plan");
    assert_eq!(
        request.extra["project_plugin_ids"],
        json!(["plugin-a@market"])
    );
    assert_eq!(request.extra["preload_skills"], json!(["skill-a"]));
    assert_eq!(
        request.extra["attachments"][0]["file_path"],
        "/tmp/requirements.md"
    );
    assert_eq!(
        request.extra["additionalContext"]["selectedCode"]["kind"],
        "untrusted"
    );
    assert_eq!(request.system_prompt, "Follow project rules");
    assert_eq!(request.workspace_source.as_deref(), Some("git_worktree"));
    assert_eq!(
        output["execution"]["workspace"]["branch"],
        "feature/creation"
    );
    assert_eq!(output["initialGoal"]["tokenBudget"], 12345);
    assert_eq!(
        output["initialSupervisor"]["modelConfig"]["api_key"],
        "secret-codex-model-b"
    );
    assert!(request.new_session);
    assert!(request.fork_runtime.is_none());
    assert!(request.inherited_sessions.is_empty());
    assert!(!output.to_string().contains("wrong-source-secret"));
    assert!(!json!(handler.creation_profile_catalog())
        .to_string()
        .contains("secret-"));
}

#[tokio::test]
async fn creation_runtime_switch_and_profile_refresh_have_exact_identity() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path());
    let handler = RuntimeWorkRpcHandler::new("creation-device", "/bin/false");
    handler
        .sync_creation_model_profiles(
            json!({"profiles":[profile("codex","shared"),profile("claude_code","shared")]}),
        )
        .unwrap();
    let mut input = intent();
    input["runtime"] = json!("claude_code");
    input["modelSelection"]["modelName"] = json!("shared");
    input["runtimePermissionMode"] = json!("plan");
    input["additionalContext"] = json!({"quote":{"kind":"untrusted","value":"External quotation"}});
    let output = handler
        .compile_creation_intent(input.clone())
        .await
        .unwrap();
    assert_eq!(
        output["executionRequest"]["model_config"]["api_key"],
        "secret-claude_code-shared"
    );
    assert!(output["executionRequest"]["prompt"]
        .as_str()
        .unwrap()
        .contains("[untrusted:quote]"));
    let mut updated = profile("claude_code", "shared");
    updated["modelConfig"]["api_key"] = json!("updated-secret");
    handler
        .sync_creation_model_profiles(json!({"profiles":[updated]}))
        .unwrap();
    assert_eq!(
        handler
            .compile_creation_intent(input.clone())
            .await
            .unwrap()["executionRequest"]["model_config"]["api_key"],
        "updated-secret"
    );
    input["deviceId"] = json!("other-device");
    assert!(handler.compile_creation_intent(input).await.is_err());
}

#[tokio::test]
async fn creation_preserves_backend_proxy_policy_for_primary_and_supervisor() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path());
    let handler = RuntimeWorkRpcHandler::new("creation-device", "/bin/false");
    let mut model = profile("codex", "model-a");
    model["modelConfig"]["proxy"] = json!({"url":"http://source-device.invalid"});
    model["modelConfig"]["vision_sidecar"] =
        json!({"enabled":true,"proxy":{"url":"http://source-sidecar.invalid"}});
    handler
        .sync_creation_model_profiles(json!({"profiles":[model]}))
        .unwrap();
    let mut input = intent();
    let policy = json!({"proxy":{"url":"http://account-proxy.invalid"},"runtime_config":{"codex":{"proxy_configured":true,"use_proxy":true}}});
    input["creationProxyPolicy"] = json!({"url":"http://account-proxy.invalid"});
    input["executionRequest"]["model_config"] = policy.clone();
    input["initialSupervisor"] = json!({"mode":"suggest","instructions":"Review","intervalSeconds":30,
        "modelSelection":{"modelName":"model-a","modelType":"runtime","options":{"reasoningEffort":"low"}},"modelConfig":policy});
    let output = handler.compile_creation_intent(input).await.unwrap();
    for config in [
        &output["executionRequest"]["model_config"],
        &output["initialSupervisor"]["modelConfig"],
    ] {
        assert_eq!(config["proxy"]["url"], "http://account-proxy.invalid");
        assert_eq!(config["runtime_config"]["codex"]["use_proxy"], true);
        assert_eq!(
            config["vision_sidecar"]["proxy"]["url"],
            "http://account-proxy.invalid"
        );
    }
    assert_eq!(
        output["initialSupervisor"]["modelConfig"]["reasoning"]["effort"],
        "low"
    );
}

#[tokio::test]
async fn creation_switches_branches_only_when_preparing_execution() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path());
    let handler = RuntimeWorkRpcHandler::new("creation-device", "/bin/false");
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(root.path())
            .output()
            .unwrap()
    };
    assert!(git(&["init", "-b", "main"]).status.success());
    assert!(git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "init"
    ])
    .status
    .success());
    handler
        .sync_creation_model_profiles(json!({"profiles":[profile("codex","model-a")]}))
        .unwrap();
    let mut input = intent();
    input["workspacePath"] = json!(root.path());
    input["execution"] =
        json!({"workspace":{"source":"local_path","branch":"feature/new","createBranch":true}});
    let output = handler.compile_creation_intent(input).await.unwrap();
    assert_eq!(
        String::from_utf8(git(&["branch", "--show-current"]).stdout)
            .unwrap()
            .trim(),
        "main"
    );
    let mut request = execution_request(&output).unwrap();
    handler.prepare_creation_branch(&mut request).await.unwrap();
    assert_eq!(
        String::from_utf8(git(&["branch", "--show-current"]).stdout)
            .unwrap()
            .trim(),
        "feature/new"
    );
    assert!(!request.extra.contains_key("creation_branch"));
    request
        .extra
        .insert("creation_branch".into(), json!({"branch":"bad name"}));
    assert!(handler.prepare_creation_branch(&mut request).await.is_err());
}

#[tokio::test]
async fn creation_cloud_models_preserve_deployment_prefix_and_composer_model_options() {
    use axum::{routing::get, Json, Router};
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path());
    let app = Router::new().route("/deployed/api/models/unified",get(|headers: axum::http::HeaderMap| async move {
        assert_eq!(headers["authorization"],"Bearer cloud-token");
        Json(json!({"data":[{"name":"cloud-primary","type":"public","namespace":"default","resourceUserId":0,
            "runtime":{"family":"custom.openai-responses"},"isActive":true}]}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/deployed/api/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("creation-device", "/bin/false");
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: base.clone(),
        auth_token: "cloud-token".into(),
        ..Default::default()
    })));
    let mut input = intent();
    input["modelSelection"] = json!({"modelName":"cloud-primary","modelType":"public","options":{
        "weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0",
        "weworkCloudModelContextWindow":"100000","weworkCloudModelMaxOutputTokens":"4000",
        "weworkCloudModelNativeToolSearch":"false","weworkCloudModelNativeNamespaceTools":"false",
        "weworkCloudModelCodexCatalogModelId":"catalog-model","weworkCloudModelCodexRequestMode":"standard",
        "weworkCloudVisionSidecar":json!({"modelName":"vision","modelType":"group","namespace":"images","resourceUserId":7,"apiFormat":"anthropic-messages","api_key":"untrusted-key"}).to_string()
    }});
    input["creationProxyPolicy"] = json!({"url":"http://account-provider-proxy.invalid"});
    let output = handler.compile_creation_intent(input).await.unwrap();
    let config = &output["executionRequest"]["model_config"];
    assert_eq!(
        config["base_url"],
        format!("{}runtime-work/llm-responses-proxy", base)
    );
    assert_eq!(config["api_key"], "cloud-token");
    assert!(config.get("proxy").is_none());
    assert_eq!(config["runtime_config"]["codex"]["use_proxy"], false);
    assert_eq!(config["vision_sidecar"]["proxy"]["url"], Value::Null);
    assert_eq!(config["model_context_window"], 100000);
    assert_eq!(config["max_output_tokens"], 4000);
    assert_eq!(config["native_tool_search"], false);
    assert_eq!(config["native_namespace_tools"], false);
    assert_eq!(config["codex_catalog_model_id"], "catalog-model");
    assert_eq!(config["codex_request_mode"], "standard");
    assert_eq!(config["vision_sidecar"]["api_key"], "cloud-token");
    assert_eq!(
        config["vision_sidecar"]["default_headers"]["X-Wegent-Model-User-Id"],
        "7"
    );
    assert_eq!(
        config["vision_sidecar"]["request_url"],
        format!("{}runtime-work/llm-responses-proxy/responses", base)
    );
    assert!(!config.to_string().contains("untrusted-key"));
    server.abort();
}

#[test]
fn creation_input_contract_covers_shared_fields_and_denies_transport_authority() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/protocol/runtime_task_create_request_v2.golden.json"
    ))
    .unwrap();
    for fixture in fixtures.as_object().unwrap().values() {
        let mut options = fixture.clone();
        for field in [
            "schemaVersion",
            "taskId",
            "message",
            "title",
            "clientUserMessageId",
            "workspacePath",
            "origin",
            "cloudProjectId",
            "deliveryId",
        ] {
            options.as_object_mut().unwrap().remove(field);
        }
        crate::workbench_control::validate_arguments(
            "create_conversation",
            &json!({"message":"create","options":options}),
        )
        .unwrap();
    }
    for options in [
        json!({"executionRequest":{}}),
        json!({"creationProxyPolicy":{"url":"http://injected.invalid"}}),
        json!({"modelConfig":{"api_key":"injected"}}),
        json!({"origin":{"dispatchRole":"manager"}}),
        json!({"initialSupervisor":{"mode":"auto","intervalSeconds":60,
            "modelSelection":{"modelName":"model"},"modelConfig":{"api_key":"injected"}}}),
        json!({"attachmentIds":[0]}),
        json!({"attachmentIds":["1"]}),
        json!({"initialGoal":{"objective":"goal","tokenBudget":0}}),
        json!({"additionalContext":{"code":{"kind":"system","value":"injected"}}}),
    ] {
        assert!(crate::workbench_control::validate_arguments(
            "create_conversation",
            &json!({"message":"create","options":options})
        )
        .is_err());
    }
}

#[test]
fn creation_normalizes_ui_options_before_merging_explicit_overrides() {
    for (saved, explicit) in [
        (
            json!({"reasoning":"low","speed":"standard"}),
            json!({"reasoningEffort":"high","serviceTier":"fast"}),
        ),
        (
            json!({"reasoningEffort":"low","serviceTier":"standard"}),
            json!({"reasoning":"high","speed":"fast"}),
        ),
    ] {
        let selection = normalized_selection(&json!({"modelType":"runtime","modelSelection":{"modelName":"model","options":saved},"modelOptions":explicit})).unwrap().unwrap();
        assert_eq!(
            selection["options"],
            json!({"reasoning":"high","speed":"fast"})
        );
    }
}
