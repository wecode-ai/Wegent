//! Protocol checks use the real MySQL decoder with controlled stored rows.
use super::*;
use brz_mysql::Json;
use wegent_backend_test_support::{
    KindQueryCapture,
    mysql_rows::{MysqlRows, Row, Value as Cell},
};

fn issue() -> store::Node {
    store::Node {
        id: "issue-1".into(),
        resource_type: "task".into(),
        cloud_project_id: "7".into(),
        parent_id: String::new(),
        loop_item_id: String::new(),
        name: String::new(),
        project_key: String::new(),
        next_item_number: 1,
        local_project_id: 0,
        assignee_user_id: 3,
        assignee_team_id: 0,
        priority: "high".into(),
        title: "Work".into(),
        description: String::new(),
        status: "pending".into(),
        source: String::new(),
        created_by_user_id: 3,
        user_id: 0,
        task_user_id: 0,
        task_id: String::new(),
        task_title: String::new(),
        device_id: String::new(),
        backend_task_id: 0,
        assignee_agent_id: String::new(),
        metadata: Json(json!({})),
        due_at: None,
        version: 1,
    }
}

fn stored(intent: Value, state: &str) -> Row {
    vec![
        ("id", Cell::I64(41)),
        ("executor_owner_user_id", Cell::I64(3)),
        ("cloud_project_id", Cell::Text("7".into())),
        ("loop_item_id", Cell::Text("issue-1".into())),
        (
            "execution_scope",
            Cell::Text(format!(
                "assistant-request:{}",
                intent["assistant_request"]["requestId"].as_str().unwrap()
            )),
        ),
        ("status", Cell::Text(state.into())),
        ("observed_state", Cell::Text("running".into())),
        ("runtime_device_id", Cell::Text("owned-device".into())),
        ("execution_device_id", Cell::Text("owned-device".into())),
        (
            "runtime_task_id",
            Cell::Text(format!(
                "assistant-request-{}",
                intent["assistant_request"]["requestId"].as_str().unwrap()
            )),
        ),
        ("execution_payload", Cell::Text(intent.to_string())),
        ("updated_at", Cell::DateTime),
    ]
}

fn intent(id: &str) -> Value {
    json!({"origin_context":{"assignment_id":"assignment-1","assignment_version":1,"human_assistant_dispatch":"dispatch-1","assistant_request_id":id},
        "assistant_request":{"requestId":id,"commands":[],"actions":{},"message":"private prompt"}})
}

fn assignment_row() -> Row {
    vec![("loop_items_id",Cell::Text("assignment-1".into())),("loop_items_loop_item_id",Cell::Text("issue-1".into())),("loop_items_description",Cell::Text(String::new())),("loop_items_created_by_user_id",Cell::I32(3)),("loop_items_created_at",Cell::DateTime),("loop_items_updated_at",Cell::DateTime),
        ("loop_items_metadata",Cell::Text(json!({"event_type":"assignment","action":"assign","target_type":"human","target_id":"3","assignment_version":1,"human_assistant_dispatch":{"dispatchId":"dispatch-1","assignmentVersion":1}}).to_string()))]
}

fn receipt_row(id: &str) -> Row {
    let mut row=vec![("id",Cell::I64(17)),("metadata",Cell::Text(json!({"activity_type":"assistant_request_receipt","request_id":id,"state":"accepted"}).to_string())),("created_at",Cell::DateTime),("updated_at",Cell::DateTime)];
    for (key, value) in [
        ("message_id", format!("assistant-request-receipt:{id}")),
        (
            "client_message_id",
            format!("assistant-request-receipt:{id}"),
        ),
        ("project_id", "7".into()),
        ("task_id", "issue-1".into()),
        ("sender_type", "user".into()),
        ("sender_id", "3".into()),
        ("sender_name", "Owner".into()),
        ("message_type", "text".into()),
        ("content", format!("Request {id}: accepted")),
        ("trigger_message_id", String::new()),
        ("reply_to_message_id", String::new()),
        ("thread_root_message_id", String::new()),
        ("agent_id", String::new()),
        ("runtime_device_id", String::new()),
        ("runtime_task_id", String::new()),
        ("status", "completed".into()),
    ] {
        row.push((key, Cell::Text(value)));
    }
    row
}

async fn bound_fixture(saved: Value) -> MysqlRows {
    bound_fixture_state(saved, "completed", true).await
}

async fn bound_fixture_state(saved: Value, state: &'static str, consent: bool) -> MysqlRows {
    MysqlRows::start_results(move|sql|{
        if sql.starts_with("INSERT ")||sql.starts_with("UPDATE "){return(vec![],vec![]);}
        let mut present=true;
        let row=if sql.contains("FROM loop_item_executions") {stored(saved.clone(),state)}
        else if sql.contains("FROM kinds") {vec![("kinds_id",Cell::I64(9)),("kinds_name",Cell::Text("owned-device".into())),("kinds_json",Cell::Text(json!({"spec":{"personalAssistantDispatch":{"version":1,"roles":[{"id":"@primary","userId":3,"enabled":consent,"enabledSince":"2020-01-01T00:00:00Z","handlingPolicy":{"automatic":true},"collaboration":{"enabled":true,"allProjects":true}}]}}}).to_string()))]}
        else if sql.contains("resource_type='execution'"){vec![("id",Cell::Text("binding-1".into()))]}
        else if sql.contains("FROM loop_items"){assignment_row()}
        else if sql.contains("SELECT id FROM users"){vec![("id",Cell::I64(3))]}
        else if sql.contains("SELECT user_name FROM users"){vec![("user_name",Cell::Text("Owner".into()))]}
        else if sql.contains("SELECT id FROM project_chat_messages"){present=false;vec![("id",Cell::I64(0))]}
        else if sql.contains("FROM project_chat_messages"){receipt_row(saved["assistant_request"]["requestId"].as_str().unwrap())}
        else {panic!("Unexpected bound request query: {sql}")};
        (row.clone(),if present{vec![row]}else{vec![]})
    }).await
}

#[tokio::test]
async fn active_followup_rechecks_frozen_device_consent_before_any_write() {
    let id = "a".repeat(32);
    let db = bound_fixture_state(intent(&id), "running", false).await;
    let action: Action = serde_json::from_value(json!({
        "action":"followup", "requestId":id, "idempotencyKey":"followup-1",
        "message":"more detail"
    }))
    .unwrap();
    let error = db
        .mysql
        .with_transaction(async |tx| service::act_on(tx, &issue(), 3, &action).await)
        .await
        .unwrap_err();
    assert!(
        matches!(error,brz_mysql::MysqlError::InvalidQuery { reason } if reason.starts_with("ASSISTANT_REQUEST:403:"))
    );
    assert!(
        db.queries()
            .iter()
            .all(|query| query.starts_with("SELECT "))
    );
}

#[tokio::test]
async fn stale_command_ack_is_rejected_even_for_the_current_runtime_binding() {
    let id = "a".repeat(32);
    let mut saved = intent(&id);
    saved["assistant_request"]["commands"] =
        json!([{"id":"old-command","action":"merge","executionId":"40","acknowledged":false}]);
    let db = bound_fixture(saved).await;
    let event:events::Event=serde_json::from_value(json!({"deviceId":"owned-device","runtimeTaskId":format!("assistant-request-{id}"),"executionId":"41","commandId":"old-command"})).unwrap();
    let error = db
        .mysql
        .with_transaction(async |tx| events::acknowledge_on(tx, &issue(), 3, &id, event).await)
        .await
        .unwrap_err();
    assert!(is_rejection(&error));
    assert!(
        db.queries()
            .iter()
            .all(|query| query.starts_with("SELECT "))
    );
}

#[tokio::test]
async fn prepare_merge_recovers_completed_requests_without_a_model_or_new_execution() {
    let id = "a".repeat(32);
    let db = bound_fixture(intent(&id)).await;
    let action: Action = serde_json::from_value(
        json!({"action":"prepare_merge","requestId":id,"idempotencyKey":"recheck-1"}),
    )
    .unwrap();
    action.validate().unwrap();
    let (response, cancellations, message) = db
        .mysql
        .with_transaction(async |tx| service::act_on(tx, &issue(), 3, &action).await)
        .await
        .unwrap();
    assert_eq!(response["state"], "completed");
    assert_eq!(response["executionId"], "41");
    assert!(cancellations.is_empty() && message.is_none());
    assert!(
        db.queries()
            .iter()
            .all(|query| !query.starts_with("INSERT "))
    );
    assert_eq!(
        db.queries()
            .iter()
            .filter(|query| query.starts_with("UPDATE loop_item_executions SET execution_payload="))
            .count(),
        1
    );
}

#[tokio::test]
async fn preparation_error_without_command_is_visible_and_successful_evidence_clears_it() {
    let id = "a".repeat(32);
    let mut saved = intent(&id);
    saved["assistant_request"]["reasonCode"] = json!("previous_error");
    let db = bound_fixture(saved).await;
    let event:events::Event=serde_json::from_value(json!({"deviceId":"owned-device","runtimeTaskId":format!("assistant-request-{id}"),"executionId":"41","commandError":"worktree_merge_preparation_failed"})).unwrap();
    let (response, shared) = db
        .mysql
        .with_transaction(async |tx| events::acknowledge_on(tx, &issue(), 3, &id, event).await)
        .await
        .unwrap();
    assert_eq!(response["reasonCode"], "worktree_merge_preparation_failed");
    assert!(shared.is_some());
    let success:events::Event=serde_json::from_value(json!({"deviceId":"owned-device","runtimeTaskId":format!("assistant-request-{id}"),"executionId":"41","worktree":{"request":{"requestId":id,"ownerUserId":3,"deviceId":"owned-device","conversationId":format!("assistant-request-{id}")},"state":"ready","baseRevision":"a".repeat(40)}})).unwrap();
    let (response, _) = db
        .mysql
        .with_transaction(async |tx| events::acknowledge_on(tx, &issue(), 3, &id, success).await)
        .await
        .unwrap();
    assert!(response["reasonCode"].is_null());
    assert_eq!(response["worktree"]["state"], "ready");
}

#[tokio::test]
async fn acceptance_persists_execution_and_safe_receipt_before_returning() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let id = "a".repeat(32);
    let request_id = id.clone();
    let inserted = Arc::new(AtomicBool::new(false));
    let db=MysqlRows::start_results(move|sql|{
        if sql.starts_with("UPDATE loop_item_executions SET execution_payload="){inserted.store(true,Ordering::SeqCst);}
        if sql.starts_with("INSERT ")||sql.starts_with("UPDATE "){return (vec![],vec![]);}
        let (row,present)=if sql.contains("FROM kinds"){
            (vec![("kinds_id",Cell::I64(9)),("kinds_name",Cell::Text("owned-device".into())),("kinds_json",Cell::Text(json!({"spec":{"personalAssistantDispatch":{"version":1,"roles":[{"id":"@primary","userId":3,"enabled":true,"enabledSince":"2020-01-01T00:00:00Z","handlingPolicy":{"automatic":true},"collaboration":{"enabled":true,"allProjects":true}}]}}}).to_string()))],true)
        }else if sql.contains("FROM loop_items"){
            (assignment_row(),true)
        }else if sql.contains("SELECT id,attempt_no"){
            (vec![("id",Cell::I64(1)),("attempt_no",Cell::I64(1))],false)
        }else if sql.contains("FROM loop_item_executions"){
            let mut row=stored(intent(&request_id),"waiting_runtime");row[0].1=Cell::I64(17);
            (row,inserted.load(Ordering::SeqCst))
        }else if sql.contains("FROM users"){
            (vec![("user_name",Cell::Text("Owner".into()))],true)
        }else if sql.contains("FROM project_chat_messages"){
            (receipt_row(&request_id),true)
        }else{panic!("Unexpected acceptance query: {sql}");};
        (row.clone(),if present{vec![row]}else{vec![]})
    }).await;
    let action: Action = serde_json::from_value(
        json!({"action":"new_request","idempotencyKey":"first-message","message":"private prompt"}),
    )
    .unwrap();
    let (request, message) = db
        .mysql
        .with_transaction(async |tx| {
            service::create_on(tx, &issue(), 3, &action, &id, None, None).await
        })
        .await
        .unwrap();
    assert_eq!(request.id, 17);
    assert_eq!(request.runtime_task_id, format!("assistant-request-{id}"));
    assert!(message.runtime_device_id.is_empty() && message.runtime_task_id.is_empty());
    assert!(!message.content.contains("private prompt"));
    let queries = db.queries();
    let execution = queries
        .iter()
        .position(|query| query.starts_with("INSERT INTO loop_item_executions"))
        .unwrap();
    let receipt = queries
        .iter()
        .position(|query| query.starts_with("INSERT INTO project_chat_messages"))
        .unwrap();
    assert!(execution < receipt);
    assert_eq!(
        queries
            .iter()
            .filter(|query| query.starts_with("INSERT INTO loop_item_executions"))
            .count(),
        1
    );
    assert_eq!(
        queries
            .iter()
            .filter(|query| query.starts_with("INSERT INTO project_chat_messages"))
            .count(),
        1
    );
}

#[tokio::test]
async fn device_evidence_rejects_stale_attempt_before_any_write() {
    let id = "a".repeat(32);
    let row = stored(intent(&id), "completed");
    let db = MysqlRows::start(move |_| row.clone()).await;
    let event:events::Event=serde_json::from_value(json!({"deviceId":"owned-device","runtimeTaskId":format!("assistant-request-{id}"),"executionId":"40"})).unwrap();
    let error = db
        .mysql
        .with_transaction(async |tx| events::acknowledge_on(tx, &issue(), 3, &id, event).await)
        .await
        .unwrap_err();
    assert!(is_rejection(&error));
    assert!(
        db.queries()
            .iter()
            .all(|query| query.starts_with("SELECT "))
    );
}

#[tokio::test]
async fn private_lookup_is_fenced_by_owner_project_issue_and_latest_attempt() {
    let db = KindQueryCapture::default();
    assert!(
        request_on(&mut &db, "7", "issue-1", 3, &"a".repeat(32))
            .await
            .is_err()
    );
    let query = &db.queries()[0];
    for predicate in [
        "cloud_project_id=?",
        "loop_item_id=?",
        "executor_owner_user_id=?",
        "execution_scope=?",
        "ORDER BY id DESC LIMIT 1 FOR UPDATE",
    ] {
        assert!(query.sql.contains(predicate));
    }
    assert_eq!(query.args, 4);
    let failing = KindQueryCapture::failing_reads();
    let error = optional_request_on(&mut &failing, "7", "issue-1", 3, &"a".repeat(32))
        .await
        .unwrap_err();
    assert!(
        !is_rejection(&error),
        "Storage failure cannot become a not-found or permission decision"
    );
}

#[tokio::test]
async fn repeated_acceptance_returns_stored_identity_and_never_queues_twice() {
    let action: Action = serde_json::from_value(
        json!({"action":"new_request","idempotencyKey":"same-message","message":"private prompt"}),
    )
    .unwrap();
    let id = model::request_id("7", "issue-1", 3, "same-message");
    let mut saved = intent(&id);
    saved["assistant_request"]["creationFingerprint"] = json!(action.fingerprint());
    let row = stored(saved, "running");
    let db = MysqlRows::start(move |sql| {
        assert!(sql.contains("FROM loop_item_executions"));
        row.clone()
    })
    .await;
    for _ in 0..2 {
        let (value, effects, message) = db
            .mysql
            .with_transaction(async |tx| service::act_on(tx, &issue(), 3, &action).await)
            .await
            .unwrap();
        assert_eq!(value["requestId"], id);
        assert_eq!(value["executionId"], "41");
        assert!(effects.is_empty() && message.is_none());
    }
    let mut changed = action;
    changed.message = Some("different private prompt".into());
    let error = db
        .mysql
        .with_transaction(async |tx| service::act_on(tx, &issue(), 3, &changed).await)
        .await
        .unwrap_err();
    assert!(is_rejection(&error));
    assert!(
        db.queries()
            .iter()
            .all(|query| query.starts_with("SELECT "))
    );
}

#[test]
fn merge_confirmation_requires_session_authentication_and_cannot_be_an_agent_action() {
    fn session_route<F>(_handler: F)
    where
        F: for<'a> std::ops::AsyncFn(
                &'a AppState,
                &'a str,
                &'a str,
                &'a str,
                SessionUser,
                &'a [u8],
            ) -> Result<Value, FastApiError>,
    {
    }
    session_route(approve_request_merge);
    let config = crate::config::AuthConfig {
        jwt_key: "merge-confirmation-test-key".into(),
        legacy_jwt_keys: vec![],
        algorithm: "HS256".into(),
    };
    let sign = |claims: &Value| {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            claims,
            &jsonwebtoken::EncodingKey::from_secret(config.jwt_key.as_bytes()),
        )
        .unwrap()
    };
    let expiry = chrono::Utc::now().timestamp() + 60;
    let task = sign(
        &json!({"type":"task_token","task_id":1,"subtask_id":2,"user_id":3,"user_name":"owner","exp":expiry}),
    );
    assert!(crate::auth::verify_session_token(&config, Some(&format!("Bearer {task}"))).is_err());
    assert!(
        crate::auth::verify_session_token(&config, Some("Bearer wg-personal-api-key")).is_err()
    );
    let session = sign(&json!({"sub":"owner","exp":expiry}));
    assert!(crate::auth::verify_session_token(&config, Some(&format!("Bearer {session}"))).is_ok());
    let action: Action = serde_json::from_value(
        json!({"action":"merge","requestId":"a".repeat(32),"idempotencyKey":"agent-attempt"}),
    )
    .unwrap();
    assert!(action.validate().is_err());
}

#[test]
fn all_new_handlers_are_selected_in_the_active_route_inventory() {
    let config: toml::Value = toml::from_str(include_str!("../../config/routes.toml")).unwrap();
    let routes = config["routes"].as_array().unwrap();
    let base = "/api/v1/cloud-projects/:project_id/loop-items/:item_id/assistant-requests";
    for (method, suffix) in [
        ("GET", ""),
        ("POST", ""),
        ("POST", "/:request_id/events"),
        ("POST", "/:request_id/merge"),
    ] {
        let path = format!("{base}{suffix}");
        assert!(
            routes
                .iter()
                .any(|route| route["path"].as_str() == Some(path.as_str())
                    && route["methods"].as_array().is_some_and(|methods| methods
                        .iter()
                        .any(|value| value.as_str() == Some(method))))
        );
    }
}
