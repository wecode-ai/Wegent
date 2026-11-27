//! Protocol integration: real local persistence, simulated Backend event pages.
use super::*;
use axum::{extract::Query, routing::get, Json, Router};

#[tokio::test]
async fn assigned_issue_event_is_durable_before_cursor_advances() {
    let issue = "WEGENTF6A670-206";
    let assignment = "8405062532670463856";
    let cursors = Arc::new(Mutex::new(Vec::new()));
    let observed = cursors.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":52})) }))
        .route("/api/v1/stand-in-issue-events", get(move |Query(query): Query<std::collections::HashMap<String,String>>| {
            let after = query["after"].parse::<i64>().unwrap();
            observed.lock().unwrap().push(after);
            async move {
                Json(if after == 0 {
                    json!({"events":[{"sequence":7,"payload":{"projectId":"8308220868516891581","itemId":issue,"assignmentId":assignment}}],"cursor":7,"has_more":false})
                } else {
                    json!({"events":[],"cursor":after,"has_more":false})
                })
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: backend.clone(),
        auth_token: "test".into(),
        authenticated_user_id: Some(52),
        ..Default::default()
    })));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(52, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"Review","preferences":"","collaboration":{"enabled":true,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[],"policy":{"automatic":true,"askBeforeAct":true}}});
    store.save_personal_stand_in(52, "mac", settings).unwrap();

    handler.collect_stand_in_issue_events().await.unwrap();
    let pending = store.pending_stand_in_dispatches().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1["notification"]["itemId"], issue);
    assert_eq!(pending[0].1["notification"]["assignmentId"], assignment);
    assert_eq!(pending[0].1["notification"]["recipientUserId"], 52);
    let source = json!({"providerId":"wework/issue-events","profile":"52","kind":"issue_inbox","id":backend});
    assert_eq!(store.stand_in_source(52, &source).unwrap()["cursor"], 7);

    // Reopening the durable store must resume at the checkpoint without losing intent.
    handler.collect_stand_in_issue_events().await.unwrap();
    assert_eq!(*cursors.lock().unwrap(), vec![0, 7]);
    assert_eq!(store.pending_stand_in_dispatches().unwrap().len(), 1);
    server.abort();
}
