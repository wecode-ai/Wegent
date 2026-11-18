use super::tests::{connection_event, fixture};
use super::*;

#[tokio::test]
async fn unavailable_cloud_event_cannot_block_local_connection_intake() {
    use axum::{routing::get, Json, Router};
    for status in [
        axum::http::StatusCode::NOT_FOUND,
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let router = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
            .route(
                "/api/v1/loop-items/missing",
                get(move || async move { status }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let (handler, store, mut settings) = fixture(root.path());
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url,
            auth_token: "test".into(),
            ..Default::default()
        });
        settings["roles"][0]["collaboration"] = json!({"enabled":true,"allProjects":false,
            "projects":[{"id":"cloud","store":"cloud"}],"excludedProjects":[],"tags":[],
            "policy":{"automatic":true,"askBeforeAct":true}});
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let blocked = store
            .enqueue_stand_in_event(
                7,
                json!("unavailable"),
                json!({
                    "kind":"assignment","projectId":"cloud","projectStore":"cloud",
                    "issueId":"missing","assignmentId":"assignment","roleIds":["default"]
                }),
            )
            .unwrap();
        let local = store
            .enqueue_stand_in_event(7, json!("local"), connection_event())
            .unwrap();
        let events = handler
            .authorized_coordination_events(&store, 7, &settings)
            .await
            .unwrap();
        assert!(events.iter().any(|event| event["id"] == local["id"]));
        assert!(!events.iter().any(|event| event["id"] == blocked["id"]));
        assert_eq!(
            store
                .stand_in_event(7, blocked["id"].as_str().unwrap())
                .unwrap()["status"],
            "pending"
        );
        assert!(handler.local_task_links(true).is_empty());
        server.abort();
    }
}
