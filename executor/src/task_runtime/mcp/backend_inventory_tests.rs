use super::*;
use axum::{extract::State, http::HeaderMap, Json, Router};
use std::sync::Mutex;

#[tokio::test]
async fn memory_asset_download_limits_apply_to_sized_and_chunked_responses() {
    use axum::{
        body::{Body, Bytes},
        routing::get,
    };
    let app = Router::new()
        .route("/sized", get(|| async { "0123456789" }))
        .route(
            "/chunked",
            get(|| async {
                Body::from_stream(futures_util::stream::iter([
                    Ok::<_, std::io::Error>(Bytes::from_static(b"01234")),
                    Ok(Bytes::from_static(b"56789")),
                ]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let client = reqwest::Client::new();
    for kind in ["sized", "chunked"] {
        let path = directory.path().join(kind);
        let access = json!({"url":format!("http://{address}/{kind}")});
        assert!(download_backend_object(&client, &access, &path, Some(6))
            .await
            .unwrap_err()
            .contains("limit"));
        assert!(!path.exists());
        download_backend_object(&client, &access, &path, Some(10))
            .await
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"0123456789");
    }
    server.abort();
}

#[tokio::test]
async fn backend_inventories_reject_malformed_lists_instead_of_reporting_empty_coverage() {
    let body = Arc::new(Mutex::new(json!({})));
    let app = Router::new()
        .fallback(
            |State(body): State<Arc<Mutex<Value>>>, headers: HeaderMap| async move {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer fixture-token"
                );
                Json(body.lock().unwrap().clone())
            },
        )
        .with_state(body.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let url = format!("http://{address}");
    let context = BackendToolContext {
        backend_url: &url,
        auth_token: "fixture-token",
        project_id: "project",
        grant: None,
        collaboration_dispatcher: None,
    };
    for name in ["list_spaces", "list_board_items", "list_deliveries"] {
        for invalid in [
            json!({}),
            json!({"error":"unavailable"}),
            json!({"items":null}),
            json!({"items":{}}),
            json!([]),
        ] {
            *body.lock().unwrap() = invalid;
            let error = call_backend_tool(&context, name, &json!({"item_id":"issue"}))
                .await
                .unwrap_err();
            assert!(error.contains("coverage is incomplete"), "{name}: {error}");
        }
        for items in [json!([]), json!([{"id":"one"},{"id":"two"}])] {
            *body.lock().unwrap() = json!({"items":items});
            assert_eq!(
                call_backend_tool(&context, name, &json!({"item_id":"issue"}))
                    .await
                    .unwrap(),
                items
            );
        }
    }
    server.abort();
}
