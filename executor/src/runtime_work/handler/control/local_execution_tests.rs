use super::tests::{context, seed, EnvGuard};
use super::*;

#[test]
fn continuation_resumes_the_original_native_thread_once_and_injects_control() {
    run_native_control(false);
}

#[test]
fn local_cloud_conversation_uses_materialization_and_device_dispatch() {
    run_native_control(true);
}

fn run_native_control(cloud_bound: bool) {
    use std::os::unix::fs::PermissionsExt;
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _native_env: Vec<_> = [
                "CODEX_HOME",
                "WEGENT_CODEX_HOME",
                "WEGENT_WORKBENCH_HOME",
                "WEGENT_CAPABILITIES_HOME",
                "CODEX_SQLITE_HOME",
            ]
            .into_iter()
            .map(|key| EnvGuard::set(key, root.path().join(key).to_str().unwrap()))
            .collect();
            let log = root.path().join("native-calls.jsonl");
            let binary = root.path().join("codex-test.sh");
            fs::write(&binary, crate::test_env::with_codex_bundled_catalog(&format!(r#"#!/bin/sh
        active_thread=thread-target
        while IFS= read -r line; do
          printf '%s\n' "$line" >> '{}'
          request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
          case "$line" in
            *'"method":"initialize"'*) printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}' ;;
            *'"method":"initialized"'*) ;;
            *'"method":"thread/unsubscribe"'*) printf '%s\n' '{{"id":'"$request_id"',"result":{{"status":"notLoaded"}}}}' ;;
            *'"method":"thread/resume"'*) active_thread=thread-target; printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-target"}}}}}}' ;;
            *'"method":"thread/start"'*) active_thread=thread-automation; printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-automation"}}}}}}' ;;
            *'"method":"thread/read"'*) printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-target","cwd":"/tmp","status":"idle","turns":[]}}}}}}' ;;
            *'"method":"turn/start"'*)
              printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-control"}}}}}}'
              printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"'"$active_thread"'","turn":{{"id":"turn-control","status":"inProgress"}}}}}}'
              printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"'"$active_thread"'","turn":{{"id":"turn-control","status":"completed"}}}}}}'
              ;;
            *) [ -z "$request_id" ] || printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}' ;;
          esac
        done
        "#, log.display()))).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
            let attachment = root.path().join("resource.txt");
            fs::write(&attachment, "owned resource").unwrap();
            let workspace = root.path().to_string_lossy().into_owned();
            let app = axum::Router::new()
                .route("/api/v1/runtime-tasks/cloud-context", axum::routing::get(|| async {
                    axum::Json(json!({"task_id":"target","cloud_project_id":"project"}))
                }))
                // APP devices must never use remote control, even when bound to a cloud project.
                .route("/api/runtime-work/send", axum::routing::post(|| async { axum::http::StatusCode::FORBIDDEN }))
                .route("/api/runtime-work/create", axum::routing::post(|| async { axum::http::StatusCode::FORBIDDEN }))
                .route("/api/runtime-work/materialize", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let workspace = workspace.clone();
                    let attachment = attachment.clone();
                    async move {
                        assert_eq!(body["schemaVersion"], 2);
                        assert_eq!(body["compileOnDevice"], true);
                        assert!(body.get("executionRequest").is_none());
                        let creating = body["newSession"] == true;
                        if creating {
                            assert_eq!(body["projectId"], 7);
                            assert_eq!(body["attachmentIds"], json!([43]));
                            assert_eq!(body["modelId"], "creation-model");
                        } else {
                            assert_eq!(body["taskId"], "target");
                            assert_eq!(body["origin"]["cloudProjectId"], "project");
                            assert_eq!(body["modelId"], "test");
                        }
                        assert_eq!(body["modelType"], "runtime");
                        let mut request = ExecutionRequest {
                            task_id: body["taskId"].as_str().unwrap().into(),
                            subtask_id: "materialized-turn".into(),
                            prompt: body["message"].clone(),
                            new_session: creating,
                            bot: json!([{"id":0,"shell_type":"Codex"}]),
                            model_config: json!({}),
                            ..Default::default()
                        };
                        if creating {
                            request.extra.insert("attachments".into(), json!([{"file_path":attachment}]));
                        } else {
                            request.extra.insert("origin".into(), body["origin"].clone());
                        }
                        axum::Json(json!({"payload":{
                            "schemaVersion":2,"taskId":body["taskId"],"runtime":"codex",
                            "workspacePath":workspace,"message":body["message"],
                            "executionRequest":request
                        }}))
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let backend = format!("http://{}/api", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(backend);
            ctx.request.auth_token = Some("synthetic-token".into());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", binary.to_str().unwrap());
            seed(&handler, "caller");
            let mut target = seed(&handler, "target");
            target.workspace_path = root.path().to_string_lossy().into_owned();
            if cloud_bound {
                target.runtime_handle["cloudProjectId"] = json!("project");
                target.runtime_handle["origin"] = json!({"type":"project_chat","cloudProjectId":"project","projectStore":"cloud"});
            }
            handler.store.upsert_task(target);
            handler.retain_runtime_model_config(
                "target",
                &json!({"model_id":"test","protocol":"openai-responses"}),
            );
            let args = json!({"conversation_id":workbench_control::conversation_id("control-test-device","target"),"message":"Fix failed checks in this workspace","request_key":"repo:pr:head:run:attempt"});
            let first = handler
                .control_operation(&ctx, "continue_conversation", args.clone())
                .await
                .unwrap();
            assert_eq!(first["operation"]["delivery_status"], "accepted");
            let second = handler
                .control_operation(&ctx, "continue_conversation", args)
                .await
                .unwrap();
            assert_eq!(second["duplicate"], true);
            assert_eq!(
                second["operation"]["operation_id"],
                first["operation"]["operation_id"]
            );
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let calls = loop {
                let calls: Vec<Value> = fs::read_to_string(&log)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect();
                if calls.iter().any(|call| call["method"] == "turn/start")
                    && !handler.is_busy_local_task("target")
                {
                    break calls;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Native continuation did not finish: {:?}",
                    handler.store.get_task("target")
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            assert_eq!(
                calls
                    .iter()
                    .filter(|call| call["method"] == "turn/start")
                    .count(),
                1
            );
            let resumed = calls
                .iter()
                .find(|call| call["method"] == "thread/resume")
                .unwrap();
            let unloaded_at = calls
                .iter()
                .position(|call| call["method"] == "thread/unsubscribe")
                .unwrap();
            let resumed_at = calls
                .iter()
                .position(|call| call["method"] == "thread/resume")
                .unwrap();
            assert!(unloaded_at < resumed_at);
            assert_eq!(calls[unloaded_at]["params"]["threadId"], "thread-target");
            assert_eq!(resumed["params"]["threadId"], "thread-target");
            assert_eq!(
                resumed["params"]["config"]["mcp_servers.wework_control.enabled"],
                true
            );
            let instructions = resumed["params"]["developerInstructions"].as_str().unwrap();
            assert!(instructions.contains("wework-runtime"));
            assert!(instructions.contains("personal Wework operations use wework_control"));
            assert!(!instructions.contains("For weekly reports"));
            if cloud_bound {
                let error = handler.control_operation(&ctx, "create_automation", json!({"name":"CI monitor","prompt":"Check CI","schedule":{"type":"interval","value":5,"unit":"minutes"},"timezone":"Asia/Shanghai","conversation_id":workbench_control::conversation_id("control-test-device","target"),"enabled":false})).await.unwrap_err();
                assert_eq!(error.code, "project_automation_required");
            } else {
            let automation = handler.control_operation(&ctx, "create_automation", json!({"name":"CI monitor","prompt":"Check CI and continue the matching conversation","schedule":{"type":"interval","value":5,"unit":"minutes"},"timezone":"Asia/Shanghai","conversation_id":workbench_control::conversation_id("control-test-device","target"),"enabled":false})).await.unwrap();
            let run = handler
                .control_operation(
                    &ctx,
                    "run_automation",
                    json!({"automation_id":automation["automation"]["id"]}),
                )
                .await
                .unwrap();
            assert_eq!(run["run"]["status"], "running");
            let automation_task = run["run"]["taskId"].as_str().unwrap();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let calls = fs::read_to_string(&log).unwrap();
                if calls.contains("thread/start") && !handler.is_busy_local_task(automation_task) {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Scheduled native execution did not finish"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let calls: Vec<Value> = fs::read_to_string(&log)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let started = calls
                .iter()
                .find(|call| call["method"] == "thread/start")
                .unwrap();
            assert_eq!(
                started["params"]["config"]["mcp_servers.wework_control.enabled"],
                true
            );
            let runs = handler
                .control_operation(
                    &ctx,
                    "list_automation_runs",
                    json!({"automation_id":automation["automation"]["id"]}),
                )
                .await
                .unwrap();
            assert_eq!(runs["items"][0]["status"], "succeeded");
            }
            handler
                .sync_creation_model_profiles(
                    json!({"profiles":[{"runtime":"codex","modelName":"creation-model",
                "modelConfig":{"model_id":"test","protocol":"openai-responses"}}]}),
                )
                .unwrap();
            let mut creation = json!({
                "message":"Start an independent configured conversation","title":"Configured creation",
                "workspace_path":root.path(),"options":{"runtime":"codex",
                "modelSelection":{"modelName":"creation-model","modelType":"runtime","options":{
                    "reasoningEffort":"high","permissionMode":"read-only","collaborationMode":"plan"}}}
            });
            if cloud_bound {
                creation["options"]["projectId"] = json!(7);
                creation["options"]["attachmentIds"] = json!([43]);
            }
            let created = handler.control_operation(&ctx, "create_conversation", creation).await.unwrap();
            assert_eq!(created["accepted"], true);
            let created_id = created["taskId"].as_str().unwrap();
            assert!(created.get("runtimeHandle").is_none());
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let calls: Vec<Value> = fs::read_to_string(&log)
                    .unwrap()
                    .lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect();
                let plan_turn = calls
                    .iter()
                    .find(|call| call.pointer("/params/collaborationMode/mode") == Some(&json!("plan")));
                if let Some(turn) = plan_turn {
                    assert_eq!(
                        turn["params"]["permissions"],
                        CODEX_READ_ONLY_PERMISSION_PROFILE
                    );
                    assert_eq!(
                        turn["params"]["collaborationMode"]["settings"]["reasoning_effort"],
                        "high"
                    );
                    assert_eq!(
                        handler.store.get_task(created_id).unwrap().workspace_path,
                        root.path().to_string_lossy()
                    );
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Configured creation did not reach the native runtime: {calls:?}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            handler.codex_app_server.restart().await;
            server.abort();
        });
}
