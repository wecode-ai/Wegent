use super::*;

#[test]
fn cloud_query_keeps_active_pages_when_archived_history_is_denied() {
    use crate::runtime_work::handler::tests::ScalarEnv;
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
            let _backend = ScalarEnv::set("WEGENT_BACKEND_URL", "");
            let _domain = ScalarEnv::set("TASK_API_DOMAIN", "");
            let (connection, server) =
                crate::runtime_work::reader::tests::start_server_with_archive_failure(true).await;
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut context = crate::runtime_work::handler::control::tests::context("caller");
            context.request.backend_url = Some(connection.backend_url);
            context.request.auth_token = Some("synthetic-token".into());
            let result = handler
                .control_cloud_query(
                    &context,
                    "list_conversations",
                    &json!({"include_archived":true}),
                    ReadBudget::default(),
                )
                .await
                .unwrap();
            assert_eq!(result["items"][0]["conversation_id"], "cloudconv_123");
            assert_eq!(result["items"].as_array().unwrap().len(), 1);
            assert_eq!(result["coverage"]["authorized_index_complete"], false);
            assert_eq!(
                result["coverage"]["unavailable_reasons"]["permission_denied"],
                1
            );
            server.abort();
        });
}

#[test]
fn cloud_search_matches_workspace_titles_and_history_without_extra_matches() {
    use crate::runtime_work::handler::tests::ScalarEnv;
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all().build().unwrap().block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
            let _backend = ScalarEnv::set("WEGENT_BACKEND_URL", "");
            let _domain = ScalarEnv::set("TASK_API_DOMAIN", "");
            let app = axum::Router::new()
                .route("/api/tasks", axum::routing::get(|| async { axum::Json(json!({"total":4,"items":[
                    {"id":123,"client_origin":"wework","title":"Workspace only","execution_workspace_path":"/work/alpha"},
                    {"id":124,"client_origin":"wework","title":"Alpha title"},
                    {"id":125,"client_origin":"wework","title":"History only"},
                    {"id":126,"client_origin":"wework","title":"Unrelated"}
                ]})) }))
                .route("/api/tasks/{id}", axum::routing::get(|axum::extract::Path(id): axum::extract::Path<i64>| async move {
                    assert!(id == 125 || id == 126, "Metadata matches must not need a history read");
                    axum::Json(json!({"id":id,"client_origin":"wework","subtasks":[]}))
                }))
                .route("/api/subtasks", axum::routing::get(|axum::extract::Query(params): axum::extract::Query<HashMap<String,String>>| async move {
                    let items = if params["task_id"] == "125" {json!([{"id":1,"role":"ASSISTANT","result":"alpha history"}])} else {json!([])};
                    axum::Json(json!({"total":items.as_array().unwrap().len(),"items":items}))
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let backend = format!("http://{}/api", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {axum::serve(listener, app).await.unwrap()});
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut context = crate::runtime_work::handler::control::tests::context("caller");
            context.request.backend_url = Some(backend);
            context.request.auth_token = Some("synthetic-token".into());
            let result = handler.control_cloud_query(&context, "search_conversations", &json!({"query":"ALPHA"}), ReadBudget::default()).await.unwrap();
            let ids: HashSet<_> = result["items"].as_array().unwrap().iter().map(|item| item["conversation_id"].as_str().unwrap()).collect();
            assert_eq!(ids, HashSet::from(["cloudconv_123", "cloudconv_124", "cloudconv_125"]));
            assert_eq!(result["coverage"]["authorized_index_complete"], true);
            server.abort();
        });
}

#[test]
fn cloud_metadata_preserves_frontend_fields_and_redacts_secrets() {
    let view = cloud_view(&json!({"id":123,"title":"Weekly work","git_repo":"team/repo","branch_name":"feature/week", "modelConfig":{"api_key":"private-secret"},"updated_at":"2026-10-30T00:00:00Z"})).unwrap();
    crate::workbench_control::assert_output_contract("get_conversation", &view);
    assert_eq!(view["git_repo"], "team/repo");
    assert_eq!(view["branch_name"], "feature/week");
    assert!(view["updated_at"].as_i64().unwrap() > 0);
    assert!(!view.to_string().contains("private-secret"));
}
