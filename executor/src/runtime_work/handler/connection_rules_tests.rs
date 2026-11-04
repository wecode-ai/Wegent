use super::*;
use axum::{
    routing::{get, post},
    Json, Router,
};
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn switching_accounts_while_hook_lookup_is_pending_never_posts_the_private_publication() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    let start = entered.clone();
    let finish = resume.clone();
    let posts = Arc::new(AtomicUsize::new(0));
    let observed = posts.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let webhook = format!("{base}/api/v1/incoming-hooks/test-token");
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/cloud-projects/project/automations", get(|| async { Json(json!([{"id":"shared-rule","enabled":true,"eventType":"connection.result_published","eventConfig":{"subscription_id":"hook"}}])) }))
        .route("/api/v1/cloud-projects/project/incoming-hooks", get(move || {
            let start = start.clone(); let finish = finish.clone(); let webhook = webhook.clone();
            async move { start.notify_one(); finish.notified().await; Json(json!([{"id":"hook","status":"active","webhookUrl":webhook}])) }
        }))
        .route("/api/v1/incoming-hooks/test-token", post(move || { observed.fetch_add(1, Ordering::SeqCst); async { Json(json!({"eventId":"receipt"})) } }));
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let connection = ConnectionConfig {
        backend_url: base,
        auth_token: "account-a".into(),
        ..Default::default()
    };
    handler
        .update_local_account_identity(Some(&connection))
        .unwrap();
    *handler.backend_connection.lock().unwrap() = Some(connection.clone());
    let actor = handler.verify_local_connection_actor(7).await.unwrap();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let rule = store.save_connection_rule(7, "mac", json!({"id":"rule","version":0,"name":"Private source","enabled":true,"accountBound":true,"source":{"providerId":"@test/source","id":"records","profile":"private-account","kind":"record","name":"Records"},"eventType":"record.received","project":{"id":"project","store":"cloud"},"targetKind":"human","targetId":"7","cloudRuleId":"shared-rule","cloudHookId":"hook","publication":{"title":"Allowed result","instruction":"Only publish the approved summary"}})).unwrap();
    store
        .enqueue_connection_rule(
            7,
            &rule,
            &rule["source"],
            &json!({"id":"event","eventType":"record.received","text":"PRIVATE ORIGINAL"}),
        )
        .unwrap();
    let mut run = store.connection_rule_runs(7).unwrap().remove(0);
    run["publication"] = json!({"title":"Allowed result","description":"Approved summary"});
    let worker = handler.clone();
    let publishing = tokio::spawn(async move {
        worker
            .publish_connection_rule(&store, 7, &actor, &rule, &mut run)
            .await
    });
    entered.notified().await;
    let next = ConnectionConfig {
        auth_token: "account-b".into(),
        ..connection
    };
    handler.update_local_account_identity(Some(&next)).unwrap();
    *handler.backend_connection.lock().unwrap() = Some(next);
    resume.notify_one();
    assert_eq!(
        publishing.await.unwrap().unwrap_err().code,
        "connection_account_changed"
    );
    assert_eq!(posts.load(Ordering::SeqCst), 0);
    server.abort();
}
#[tokio::test]
async fn receipt_observation_waits_for_scheduled_retries_and_reports_terminal_failure() {
    let phase = Arc::new(AtomicUsize::new(0));
    let state = phase.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/cloud-projects/project/incoming-hooks/hook/events", get(move || {
            let phase = state.load(Ordering::SeqCst);
            async move { Json(match phase {
                0 => json!([{"id":"receipt","status":"failed","nextRetryAt":"2099-01-01T00:00:00"}]),
                1 => json!([{"id":"receipt","status":"failed","nextRetryAt":null}]),
                _ => json!([{"id":"receipt","status":"processed","matchedRuns":["project-run"]}]),
            }) }
        }))
        .route("/api/v1/cloud-projects/project/automations/shared-rule/runs", get(|| async { Json(json!([{"id":"project-run","status":"running","taskId":"published-issue"}])) }));
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let connection = ConnectionConfig {
        backend_url: base,
        auth_token: "account-a".into(),
        ..Default::default()
    };
    handler
        .update_local_account_identity(Some(&connection))
        .unwrap();
    *handler.backend_connection.lock().unwrap() = Some(connection);
    let actor = handler.verify_local_connection_actor(7).await.unwrap();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let rule = store.save_connection_rule(7, "mac", json!({"id":"rule","version":0,"name":"Source","enabled":true,"source":{"providerId":"@test/source","id":"records","profile":"account","kind":"record","name":"Records"},"eventType":"record.received","project":{"id":"project","store":"cloud"},"targetKind":"human","targetId":"7","cloudRuleId":"shared-rule","cloudHookId":"hook","publication":{"title":"Allowed result","instruction":"Approved summary only"}})).unwrap();
    store
        .enqueue_connection_rule(
            7,
            &rule,
            &rule["source"],
            &json!({"id":"event","eventType":"record.received","text":"Private original"}),
        )
        .unwrap();
    let mut run = store.connection_rule_runs(7).unwrap().remove(0);
    run["status"] = json!("delivered");
    run["receiptId"] = json!("receipt");
    store.save_connection_rule_run(7, &run).unwrap();
    handler
        .refresh_connection_publication(&store, 7, &actor, &rule, &mut run)
        .await
        .unwrap();
    assert_eq!(
        store.connection_rule_runs(7).unwrap()[0]["status"],
        "delivered"
    );
    phase.store(1, Ordering::SeqCst);
    assert_eq!(
        handler
            .refresh_connection_publication(&store, 7, &actor, &rule, &mut run)
            .await
            .unwrap_err()
            .code,
        "publication_processing_failed"
    );
    assert_eq!(run["retryable"], false);
    phase.store(2, Ordering::SeqCst);
    handler
        .refresh_connection_publication(&store, 7, &actor, &rule, &mut run)
        .await
        .unwrap();
    let final_run = store.connection_rule_runs(7).unwrap().remove(0);
    assert_eq!(final_run["status"], "published");
    assert_eq!(final_run["issueId"], "published-issue");
    assert!(final_run["error"].is_null());
    server.abort();
}

#[tokio::test]
async fn project_denials_preserve_local_rules_but_account_denials_retire_evidence() {
    use axum::http::StatusCode;
    use std::sync::atomic::AtomicU16;
    let status = Arc::new(AtomicU16::new(503));
    let calls = Arc::new(AtomicUsize::new(0));
    let delete_calls = Arc::new(AtomicUsize::new(0));
    let denied_deletes = delete_calls.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let denied_writes = writes.clone();
    let response_status = status.clone();
    let request_count = calls.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/cloud-projects/cloud/automations", get(move || {
            let code = response_status.load(Ordering::SeqCst);
            request_count.fetch_add(1, Ordering::SeqCst);
            async move { (StatusCode::from_u16(code).unwrap(), Json(json!([
                {"id":"shared-one","name":"Updated shared one","enabled":true,"targetKind":"human","targetId":"7","prompt":"Current instruction","version":9},
                {"id":"shared-two","name":"Updated shared two","enabled":true,"targetKind":"human","targetId":"7","prompt":"Current instruction","version":9},
                {"id":"shared-delete","name":"Delete denied","enabled":true,"targetKind":"human","targetId":"7","prompt":"Instruction","version":1}
            ]))) }
        }))
        .route("/api/v1/cloud-projects/cloud/automations/shared-delete", axum::routing::delete(move || {
            denied_deletes.fetch_add(1, Ordering::SeqCst);
            async { StatusCode::FORBIDDEN }
        }))
        .route("/api/v1/cloud-projects/cloud/incoming-hooks", get(|| async { StatusCode::FORBIDDEN }).post(move || {
            denied_writes.fetch_add(1, Ordering::SeqCst);
            async { StatusCode::FORBIDDEN }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let connection = ConnectionConfig {
        backend_url: format!("http://{}", listener.local_addr().unwrap()),
        auth_token: "test".into(),
        ..Default::default()
    };
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler
        .update_local_account_identity(Some(&connection))
        .unwrap();
    *handler.backend_connection.lock().unwrap() = Some(connection.clone());
    handler.verify_local_connection_actor(7).await.unwrap();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Local"})).unwrap())
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            serde_json::from_value(
                json!({"name":"Processor","runtime":"claude_code","local_project_id":7}),
            )
            .unwrap(),
        )
        .unwrap();
    let base = json!({"id":"local","version":0,"name":"Stored private rule","enabled":true,"accountBound":true,"source":{"providerId":"test/source","id":"record","profile":"private","kind":"record","name":"Records"},"eventType":"record.received","project":{"id":project.id,"store":"local"},"targetKind":"agent","targetId":agent.id,"publication":{"title":"Summary","instruction":"Anonymize"}});
    store.save_connection_rule(7, "mac", base.clone()).unwrap();
    for (id, shared) in [("cloud-one", "shared-one"), ("cloud-two", "shared-two")] {
        let mut rule = base.clone();
        rule["id"] = json!(id);
        rule["project"] = json!({"id":"cloud","store":"cloud"});
        rule["cloudRuleId"] = json!(shared);
        store.save_connection_rule(7, "mac", rule).unwrap();
    }
    let result = handler
        .connection_rules_rpc("runtime.connection_rules.list", json!({"userId":7}))
        .await
        .unwrap();
    let items = result["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert!(items.iter().find(|r| r["id"] == "local").unwrap()["cloudSyncError"].is_null());
    assert!(items
        .iter()
        .filter(|r| r["project"]["store"] == "cloud")
        .all(|r| r["cloudSyncError"] == "cloud_request_failed"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "Failed lookups must be shared by rules in the same project"
    );
    let cached = items
        .iter()
        .find(|r| r["id"] == "cloud-one")
        .unwrap()
        .clone();
    store.save_connection_rule(7, "mac", cached).unwrap();
    status.store(200, Ordering::SeqCst);
    let result = handler
        .connection_rules_rpc("runtime.connection_rules.list", json!({"userId":7}))
        .await
        .unwrap();
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["project"]["store"] == "cloud")
        .all(|r| r["instruction"] == "Current instruction" && r["cloudSyncError"].is_null()));
    let fingerprint =
        crate::runtime_work::handler::connection_identity::connection_fingerprint(&connection);
    let identity = store.connection_identity("mac").unwrap();
    for (code, error) in [
        (403, "cloud_project_forbidden"),
        (404, "cloud_project_unavailable"),
    ] {
        status.store(code, Ordering::SeqCst);
        let denied = handler
            .connection_rules_rpc("runtime.connection_rules.list", json!({"userId":7}))
            .await
            .unwrap();
        assert!(denied["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["project"]["store"] == "cloud")
            .all(|rule| rule["cloudSyncError"] == error));
        assert_eq!(store.connection_identity("mac").unwrap(), identity);
        assert_eq!(
            store.verified_connection_user("mac", &fingerprint).unwrap(),
            Some(7)
        );
    }
    let local = handler
        .connection_rules_rpc(
            "runtime.connection_rules.list",
            json!({"userId":7,"project":{"id":project.id,"store":"local"}}),
        )
        .await
        .unwrap();
    assert_eq!(local["items"].as_array().unwrap().len(), 1);
    let before_save = store
        .connection_rules(7)
        .unwrap()
        .into_iter()
        .find(|rule| rule["id"] == "cloud-two")
        .unwrap();
    let mut paused = before_save.clone();
    paused["enabled"] = json!(false);
    assert_eq!(
        handler
            .connection_rules_rpc(
                "runtime.connection_rules.save",
                json!({"userId":7,"rule":paused})
            )
            .await
            .unwrap_err()
            .code,
        "cloud_project_forbidden"
    );
    assert_eq!(
        store
            .connection_rules(7)
            .unwrap()
            .into_iter()
            .find(|rule| rule["id"] == "cloud-two")
            .unwrap(),
        before_save
    );
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        store.verified_connection_user("mac", &fingerprint).unwrap(),
        Some(7)
    );
    let owned = store
        .connection_rules(7)
        .unwrap()
        .into_iter()
        .find(|rule| rule["id"] == "cloud-one")
        .unwrap();
    status.store(403, Ordering::SeqCst);
    assert_eq!(handler.connection_rules_rpc("runtime.connection_rules.remove", json!({"userId":7,"id":owned["id"],"version":owned["version"].as_i64().unwrap() - 1})).await.unwrap_err().code, "version_conflict");
    assert_eq!(
        handler
            .connection_rules_rpc(
                "runtime.connection_rules.remove",
                json!({"userId":7,"id":owned["id"],"version":owned["version"]})
            )
            .await
            .unwrap()["removed"],
        true
    );
    assert!(!store
        .connection_rules(7)
        .unwrap()
        .iter()
        .any(|rule| rule["id"] == "cloud-one"));
    assert_eq!(
        store.verified_connection_user("mac", &fingerprint).unwrap(),
        Some(7)
    );

    status.store(200, Ordering::SeqCst);
    let mut denied_delete = owned;
    denied_delete["id"] = json!("cloud-delete");
    denied_delete["version"] = json!(0);
    denied_delete["cloudRuleId"] = json!("shared-delete");
    let denied_delete = store.save_connection_rule(7, "mac", denied_delete).unwrap();
    assert_eq!(
        handler
            .connection_rules_rpc(
                "runtime.connection_rules.remove",
                json!({"userId":7,"id":"cloud-delete","version":denied_delete["version"]})
            )
            .await
            .unwrap()["removed"],
        true
    );
    assert_eq!(delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.verified_connection_user("mac", &fingerprint).unwrap(),
        Some(7)
    );

    status.store(404, Ordering::SeqCst);
    let mut missing_project = denied_delete;
    missing_project["id"] = json!("missing-project");
    missing_project["version"] = json!(0);
    let missing_project = store
        .save_connection_rule(7, "mac", missing_project)
        .unwrap();
    assert_eq!(
        handler
            .connection_rules_rpc(
                "runtime.connection_rules.remove",
                json!({"userId":7,"id":missing_project["id"],"version":missing_project["version"]})
            )
            .await
            .unwrap()["removed"],
        true
    );
    assert_eq!(
        store.verified_connection_user("mac", &fingerprint).unwrap(),
        Some(7)
    );

    status.store(401, Ordering::SeqCst);
    let error = handler
        .connection_rules_rpc("runtime.connection_rules.list", json!({"userId":7}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "permission_denied");
    assert_eq!(
        store.verified_connection_user("mac", &fingerprint).unwrap(),
        None
    );
    server.abort();
    let _ = server.await;
    assert!(handler.verify_local_connection_actor(7).await.is_err());
}
