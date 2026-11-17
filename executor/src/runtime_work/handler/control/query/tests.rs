use super::*;

fn item(id: &str, updated: i64) -> Value {
    json!({"conversation_id":id,"updated_at":updated,"updatedAt":updated,"title":id})
}
fn source(id: &str, items: Vec<Value>, more: bool) -> Value {
    json!({"source_id":id,"status":"available","result":{"items":items,"has_more":more}})
}
#[test]
fn federation_deduplicates_addresses_and_pages_equal_timestamps_without_loss() {
    let sources = vec![
        source("local", vec![item("local-z", 100), item("same", 90)], false),
        source(
            "remote",
            vec![item("remote-z", 100), item("same", 90), item("cloud", 80)],
            false,
        ),
    ];
    let first = merge_pages(sources.clone(), &json!({"limit":2})).unwrap();
    assert_eq!(first["items"][0]["conversation_id"], "remote-z");
    assert_eq!(first["items"][1]["conversation_id"], "local-z");
    assert_eq!(first["has_more"], true);
    let second = merge_pages(sources, &json!({"limit":2,"after":first["next_cursor"]})).unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert_eq!(second["items"][0]["conversation_id"], "same");
    assert_eq!(second["items"][1]["conversation_id"], "cloud");
    assert_eq!(second["has_more"], false);
}
#[test]
fn unavailable_and_partially_readable_sources_prevent_complete_coverage() {
    let mut local = source("local", vec![item("one", 1)], false);
    local["result"]["coverage"] = json!({"unavailable_reasons":{"permission_denied":2}});
    let result = merge_pages(
        vec![
            local,
            json!({"source_id":"offline","status":"unavailable","code":"device_offline"}),
        ],
        &json!({}),
    )
    .unwrap();
    assert_eq!(result["coverage"]["authorized_index_complete"], false);
    assert_eq!(result["coverage"]["unavailable_count"], 3);
    assert_eq!(result["coverage"]["sources"].as_array().unwrap().len(), 2);
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
}

#[test]
fn malformed_device_pages_do_not_discard_other_sources() {
    let result = merge_pages(
        vec![
            source("local", vec![item("local-result", 1)], false),
            json!({"source_id":"incompatible-device","status":"available","result":{}}),
        ],
        &json!({}),
    )
    .unwrap();
    assert_eq!(result["items"][0]["conversation_id"], "local-result");
    assert_eq!(result["coverage"]["authorized_index_complete"], false);
    assert_eq!(
        result["coverage"]["unavailable_reasons"]["invalid_response"],
        1
    );
}
#[test]
fn control_queries_use_the_desktop_read_channel_and_existing_cloud_apis() {
    use super::super::tests::{context, seed, EnvGuard};
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _sidebar = EnvGuard::set("CODEX_HOME", root.path().to_str().unwrap());
            let _native = EnvGuard::set("WEGENT_CODEX_HOME", root.path().to_str().unwrap());
            let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "");
            let _domain = EnvGuard::set("TASK_API_DOMAIN", "");
            let (mut connection, servers) =
                crate::runtime_work::reader::tests::start_server_with_separate_socket().await;
            let mut handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let url = connection.backend_url.clone();
            connection.auth_token = "desktop-token-must-not-replace-caller-authorization".into();
            handler.backend_connection = std::sync::Arc::new(std::sync::Mutex::new(Some(connection)));
            crate::runtime_work::handler::tests::install_native_history(
                &mut handler,
                root.path(),
                vec![],
                None,
            );
            seed(&handler, "caller");
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(url);
            ctx.request.auth_token = Some("synthetic-token".into());
            let result = handler
                .control_operation(
                    &ctx,
                    "search_conversations",
                    json!({"query":"weekly work","include_archived":true,"limit":100}),
                )
                .await
                .unwrap();
            let remote_id = workbench_control::conversation_id("other-device", "remote-task");
            let ids: Vec<_> = result["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|item| item["conversation_id"].as_str())
                .collect();
            assert!(ids.contains(&remote_id.as_str()), "{result}");
            assert!(ids.contains(&"cloudconv_123"));
            assert_eq!(result["coverage"]["authorized_index_complete"], true);
            assert!(!result.to_string().contains("private-secret"));
            let archived = handler.control_operation(&ctx, "get_conversation", json!({
                "conversation_id":workbench_control::conversation_id("other-device", "archived-task")
            })).await.unwrap();
            assert_eq!(archived["status"], "archived");
            assert_eq!(archived["title"], "Archived remote conversation");
            let history = handler
                .control_operation(
                    &ctx,
                    "read_conversation",
                    json!({"conversation_id":remote_id,"before_cursor":"native-cursor"}),
                )
                .await
                .unwrap();
            assert!(history["messages"][0]["content"]
                .as_str()
                .unwrap()
                .ends_with("FULL_HISTORY_SUFFIX"));
            let cloud = handler
                .control_operation(
                    &ctx,
                    "read_conversation",
                    json!({"conversation_id":"cloudconv_123","limit":100}),
                )
                .await
                .unwrap();
            assert_eq!(cloud["messages"].as_array().unwrap().len(), 100);
            assert_eq!(cloud["has_more_before"], true);
            let older = handler.control_operation(&ctx,"read_conversation",json!({"conversation_id":"cloudconv_123","limit":100,"before_cursor":cloud["before_cursor"]})).await.unwrap();
            assert_eq!(older["messages"].as_array().unwrap().len(), 100);
            let oldest = handler.control_operation(&ctx,"read_conversation",json!({"conversation_id":"cloudconv_123","limit":100,"before_cursor":older["before_cursor"]})).await.unwrap();
            assert_eq!(oldest["messages"].as_array().unwrap().len(), 52);
            assert_eq!(oldest["messages"][0]["content"], "inherited weekly history");
            assert_eq!(
                oldest["messages"][0]["attachments"][0]["name"],
                "inherited-file.txt"
            );
            let denied = handler
                .control_operation(
                    &ctx,
                    "get_conversation",
                    json!({"conversation_id":"cloudconv_999"}),
                )
                .await
                .unwrap_err();
            assert_eq!(denied.code, "permission_denied");
            let selected = handler
                .control_operation(
                    &ctx,
                    "list_conversations",
                    json!({"device_id":"control-test-device"}),
                )
                .await
                .unwrap();
            assert_eq!(selected["coverage"]["scope"], "device");
            assert_eq!(selected["coverage"]["device_id"], "control-test-device");
            assert_eq!(selected["coverage"]["sources"].as_array().unwrap().len(), 1);
            assert_eq!(selected["coverage"]["authorized_index_complete"], true);
            let conflict = handler
                .control_operation(
                    &ctx,
                    "list_conversations",
                    json!({"scope":"current_device","device_id":"other-device"}),
                )
                .await
                .unwrap_err();
            assert_eq!(conflict.code, "bad_request");
            ctx.request.auth_token = None;
            let partial = handler
                .control_operation(&ctx, "list_conversations", json!({}))
                .await
                .unwrap();
            assert_eq!(partial["coverage"]["authorized_index_complete"], false);
            assert_eq!(partial["items"].as_array().unwrap().len(), 1);
            handler.codex_app_server.restart().await;
            for server in servers {
                server.abort();
            }
        });
}

#[test]
fn control_reader_requires_the_current_desktop_connection() {
    use super::super::tests::{context, EnvGuard};
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "");
            let _domain = EnvGuard::set("TASK_API_DOMAIN", "");
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let (connection, servers) =
                crate::runtime_work::reader::tests::start_server_with_separate_socket().await;
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(connection.backend_url.clone());
            ctx.request.auth_token = Some("synthetic-token".into());
            let missing = handler
                .control_runtime_reader(&ctx, ReadBudget::default())
                .await
                .map(|_| ())
                .unwrap_err();
            assert_eq!(missing.code, "backend_connection_unavailable");
            *handler.backend_connection.lock().unwrap() = Some(connection);
            let reader = handler
                .control_runtime_reader(&ctx, ReadBudget::default())
                .await
                .unwrap();
            assert_eq!(
                reader
                    .request("other-device", "runtime.tasks.list", json!({}))
                    .await
                    .unwrap()["success"],
                true
            );
            reader.close().await;
            *handler.backend_connection.lock().unwrap() = None;
            let disconnected = handler
                .control_runtime_reader(&ctx, ReadBudget::default())
                .await
                .map(|_| ())
                .unwrap_err();
            assert_eq!(disconnected.code, "backend_connection_unavailable");
            for server in servers {
                server.abort();
            }
        });
}

#[test]
fn control_query_deadline_preserves_fast_sources_and_device_selection_avoids_slow_sources() {
    use super::super::tests::{context, EnvGuard};
    use std::time::Duration;

    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "");
            let _domain = EnvGuard::set("TASK_API_DOMAIN", "");
            let (connection, server) =
                crate::runtime_work::reader::tests::start_server_with_slow_device().await;
            let mut handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut ctx = context("caller");
            ctx.request.backend_url = Some(connection.backend_url.clone());
            handler.backend_connection = std::sync::Arc::new(std::sync::Mutex::new(Some(connection)));
            ctx.request.auth_token = Some("synthetic-token".into());
            let args = json!({"include_archived":true,"limit":100});
            let sources = tokio::time::timeout(
                Duration::from_secs(5),
                handler.control_other_sources(
                    &ctx,
                    "list_conversations",
                    args.clone(),
                    ReadBudget::new(Duration::from_secs(1)),
                ),
            )
            .await
            .expect("A silent device must not outlive the shared read deadline");
            let result = merge_pages(sources, &args).unwrap();
            let remote_id = workbench_control::conversation_id("other-device", "remote-task");
            let items = result["items"].as_array().unwrap();
            assert!(
                items
                    .iter()
                    .any(|item| item["conversation_id"] == remote_id),
                "{result}"
            );
            assert!(
                items
                    .iter()
                    .any(|item| item["conversation_id"] == "cloudconv_123"),
                "{result}"
            );
            assert_eq!(result["coverage"]["authorized_index_complete"], false);
            assert!(
                result["coverage"]["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|source| {
                        source["source_id"] == "slow-device" && source["code"] == "query_timeout"
                    }),
                "{result}"
            );

            for device in ["other-device", "missing-device"] {
                let args = json!({"device_id":device,"workspace_path":"/code/aigc-video-agent","include_archived":true,"limit":100});
                let sources = handler
                    .control_other_sources(
                        &ctx,
                        "list_conversations",
                        args.clone(),
                        ReadBudget::new(Duration::from_secs(1)),
                    )
                    .await;
                let page = merge_pages(sources, &args).unwrap();
                assert_eq!(page["coverage"]["scope"], "device");
                assert_eq!(page["coverage"]["device_id"], device);
                assert_eq!(page["coverage"]["sources"].as_array().unwrap().len(), 1);
                if device == "other-device" {
                    assert_eq!(
                        page["coverage"]["authorized_index_complete"], true,
                        "{page}"
                    );
                    assert_eq!(page["items"].as_array().unwrap().len(), 1);
                    assert_eq!(page["items"][0]["conversation_id"], remote_id);
                } else {
                    assert_eq!(page["coverage"]["authorized_index_complete"], false);
                    assert_eq!(page["coverage"]["sources"][0]["code"], "not_found");
                }
            }
            server.abort();
        });
}
