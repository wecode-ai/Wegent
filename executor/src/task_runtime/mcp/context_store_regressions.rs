use super::*;
use crate::task_runtime::{mcp, ProjectStoreKind};
use axum::{http::HeaderMap, routing::post, Json, Router};
use serde_json::json;
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

async fn call(
    runtime: &TaskRuntime,
    context: &mcp::SpaceMcpRequestContext,
    name: &str,
    arguments: Value,
) -> Value {
    let response = mcp::handle_request_with_context(
        runtime,
        &json!({
            "id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}
        }),
        context,
    )
    .await
    .unwrap();
    assert_eq!(response["result"]["isError"], false, "{response}");
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn dingtalk_context_keeps_catalogued_storage_identity_through_board_description() {
    for store_kind in [ProjectStoreKind::Backend, ProjectStoreKind::Local] {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let config = json!({"base_id":"base-1","table_id":"table-1",
            "board_mapping":{"title_field_id":"fld_title","status_field_id":"fld_status"}});
        let project = if store_kind == ProjectStoreKind::Backend {
            store
                .configure_external_project(ProjectDescriptor {
                    id: "backend-aitable".into(),
                    public_id: None,
                    project_key: "AIT".into(),
                    name: "Backend DingTalk catalog entry".into(),
                    description: String::new(),
                    project_store: store_kind,
                    task_provider: TaskProviderKind::DingtalkAitable,
                    provider_config: config,
                    version: 1,
                })
                .unwrap()
        } else {
            store
                .create_project(ProjectCreate {
                    name: "Local DingTalk project".into(),
                    project_key: Some("AIT".into()),
                    description: String::new(),
                    task_provider: TaskProviderKind::DingtalkAitable,
                    provider_config: config,
                })
                .unwrap()
        };
        let mut runtime = TaskRuntime::new(store).unwrap();
        let dws = directory.path().join("dws");
        std::fs::write(&dws, r#"#!/bin/sh
case "$*" in
  *"field get"*) printf '%s\n' '{"success":true,"result":[]}' ;;
  *"record query"*) printf '%s\n' '{"success":true,"result":[{"recordId":"record-1","cells":{"fld_title":"DingTalk context evidence","fld_status":"pending"}}]}' ;;
  *"get-primary-doc-id"*) printf '%s\n' '{"success":true,"result":{}}' ;;
  *) printf '%s\n' '{"success":false,"error":{"message":"unexpected command"}}'; exit 1 ;;
esac
"#).unwrap();
        std::fs::set_permissions(&dws, std::fs::Permissions::from_mode(0o755)).unwrap();
        runtime.aitable_provider.set_binary(dws);
        let expected = if store_kind == ProjectStoreKind::Backend {
            json!({"project_store":"backend","space_id":project.id})
        } else {
            json!({"project_store":"local","space_id":project.id,"device_id":"device-1"})
        };
        let reads = Arc::new(AtomicUsize::new(0));
        let observed = reads.clone();
        let expected_request = expected.clone();
        let app = Router::new().route(
            "/api/mcp/wework-space/sse",
            post(move |headers: HeaderMap, Json(request): Json<Value>| {
                let reads = observed.clone();
                let expected = expected_request.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer test-token");
                    assert_eq!(request["params"]["name"], "describe_space_board");
                    assert_eq!(request["params"]["arguments"]["space"], expected);
                    reads.fetch_add(1, Ordering::SeqCst);
                    let value = json!({"space":expected,"board_config":{"statuses":[]}});
                    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":{
                        "isError":false,"content":[{"type":"text","text":value.to_string()}]
                    }}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let grant = serde_json::from_value(json!({
            "version":1,"task_id":"bound-runtime","space_id":project.id,
            "item_id":"aitable:AIT:record-1","device_id":"device-1",
            "role":"manager","categories":["management","execution"],
            "expires_at_unix":chrono::Local::now().timestamp()+60
        }))
        .unwrap();
        let context =
            mcp::SpaceMcpRequestContext::new(Some(grant), Some(url), Some("test-token".into()));
        let current = call(&runtime, &context, "get_current_context", json!({})).await;
        assert_eq!(current["item"]["title"], "DingTalk context evidence");
        assert_eq!(current["space_ref"], expected);
        assert!(current.get("space_ref_error").is_none());
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        let board = call(
            &runtime,
            &context,
            "describe_space_board",
            json!({"space":current["space_ref"]}),
        )
        .await;
        assert_eq!(board["space"], expected);
        assert_eq!(
            reads.load(Ordering::SeqCst),
            usize::from(store_kind == ProjectStoreKind::Backend)
        );
        if store_kind == ProjectStoreKind::Backend {
            let forged = call(
                &runtime,
                &context,
                "batch_get_board_items",
                json!({"items":[{
                    "request_id":"forged","target":{"space":{
                        "project_store":"local","space_id":project.id,"device_id":"device-1"
                    },"item_id":"aitable:AIT:record-1"}
                }]}),
            )
            .await;
            assert_eq!(forged["results"][0]["state"], "failed");
            assert!(forged["results"][0].get("result").is_none());
            assert_eq!(reads.load(Ordering::SeqCst), 1);
        }
        server.abort();
    }
}
