use super::*;
use crate::local::event_scope::{account, RAW_ACCOUNT, REQUEST_ACCOUNT};

#[test]
fn local_turn_event_ownership_survives_account_switch_and_saved_request_recovery() {
    let connection = |token: &str| ConnectionConfig {
        backend_url: "https://backend.example".into(),
        auth_token: token.into(),
        ..Default::default()
    };
    let snapshot = Arc::new(Mutex::new(Some(connection("account-a"))));
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false")
        .with_backend_connection(Arc::clone(&snapshot));
    let mut request = ExecutionRequest::default();
    request
        .extra
        .insert("origin".into(), json!({"projectStore":"local"}));
    handler.apply_backend_connection(&mut request);
    assert!(request.auth_token.is_none());
    assert!(request.backend_url.is_none());
    let original = request.extra[REQUEST_ACCOUNT].clone();
    assert_eq!(original, json!(account(&connection("account-a")).unwrap()));
    let mut link = RuntimeTaskLink {
        local_task_id: "task-a".into(),
        ..Default::default()
    };
    store_runtime_execution_request(&mut link.runtime_handle, &request);
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("index.json");
    RuntimeWorkStore::new(path.clone()).upsert_task(link);
    let link = RuntimeWorkStore::new(path)
        .get_task_summary("task-a")
        .unwrap();
    let mut restored = runtime_event_request_from_link(&link);
    *snapshot.lock().unwrap() = Some(connection("account-b"));
    handler.apply_backend_connection(&mut restored);
    assert_eq!(restored.extra[REQUEST_ACCOUNT], original);
    assert!(restored.auth_token.is_none());
    let (sender, mut events) = broadcast::channel(4);
    crate::runtime_work::events::emit_response_event(
        &Some(sender),
        "device-1",
        "response.completed",
        "task-a",
        &restored,
        json!({"value":"private-a"}),
    );
    let late = events.try_recv().unwrap();
    assert_eq!(late[RAW_ACCOUNT], original);
    assert_eq!(late["payload"]["data"]["value"], "private-a");
    let mut next = ExecutionRequest::default();
    handler.capture_runtime_event_account(&mut next);
    assert_ne!(next.extra[REQUEST_ACCOUNT], original);
}

#[test]
fn ipc_cannot_supply_event_account_ownership() {
    let connection = |token: &str| ConnectionConfig {
        backend_url: "https://backend.example".into(),
        auth_token: token.into(),
        ..Default::default()
    };
    let snapshot = Arc::new(Mutex::new(Some(connection("account-a"))));
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false")
        .with_backend_connection(Arc::clone(&snapshot));
    for key in ["executionRequest", "execution_request"] {
        *snapshot.lock().unwrap() = Some(connection("account-a"));
        let mut payload =
            json!({key:{"task_id":"task-a", "_runtime_event_account":"forged-account"}});
        handler.admit_runtime_event_account(&mut payload);
        *snapshot.lock().unwrap() = Some(connection("account-b"));
        let mut parsed = execution_request(&payload).unwrap();
        handler.apply_backend_connection(&mut parsed);
        assert_eq!(
            parsed.extra[REQUEST_ACCOUNT],
            json!(account(&connection("account-a")).unwrap())
        );
        assert!(parsed.auth_token.is_none());
    }
}

#[test]
fn queued_work_cannot_borrow_a_new_accounts_backend_credentials() {
    let connection = |token: &str| ConnectionConfig {
        backend_url: "https://backend.example".into(),
        auth_token: token.into(),
        runtime_auth_token: format!("runtime-{token}"),
        ..Default::default()
    };
    let snapshot = Arc::new(Mutex::new(Some(connection("account-a"))));
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false")
        .with_backend_connection(Arc::clone(&snapshot));
    let mut queued = ExecutionRequest::default();
    handler.capture_runtime_event_account(&mut queued);
    *snapshot.lock().unwrap() = Some(connection("account-b"));
    handler.apply_backend_connection(&mut queued);
    assert!(queued.auth_token.is_none());
    assert!(queued.runtime_auth_token.is_none());
    assert!(queued.backend_url.is_none());
    queued.auth_token = Some("original-actor-a".into());
    handler.apply_backend_connection(&mut queued);
    assert_eq!(queued.auth_token.as_deref(), Some("original-actor-a"));
    *snapshot.lock().unwrap() = Some(connection("account-a"));
    handler.apply_backend_connection(&mut queued);
    assert_eq!(queued.auth_token.as_deref(), Some("original-actor-a"));
    assert_eq!(
        queued.runtime_auth_token.as_deref(),
        Some("runtime-account-a")
    );
}
