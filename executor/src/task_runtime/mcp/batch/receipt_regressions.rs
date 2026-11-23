use super::*;

#[tokio::test]
async fn redacted_cloud_commit_still_requires_current_backend_authority() {
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    let denied = Arc::new(AtomicBool::new(false));
    let writes = Arc::new(AtomicUsize::new(0));
    let denied_backend = denied.clone();
    let backend_writes = writes.clone();
    let app = Router::new().route(
        "/api/mcp/wework-space/sse",
        post(move |Json(request): Json<Value>| {
            let denied = denied_backend.clone();
            let writes = backend_writes.clone();
            async move {
                let name = request["params"]["name"].as_str().unwrap();
                if name == "get_board_operation" && denied.load(Ordering::SeqCst) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                if name == "batch_create_board_items" {
                    writes.fetch_add(1, Ordering::SeqCst);
                } else {
                    assert_eq!(name, "get_board_operation");
                }
                let receipt = json!({
                    "operation_id":"backend-receipt","state":"completed",
                    "results":[{
                        "request_id":"cloud","state":"succeeded","committed":true,
                        "error":{"code":"result_unavailable","message":"Committed result is unavailable under current access","retryable":false}
                    }]
                });
                Json(json!({"jsonrpc":"2.0","id":request["id"],"result":{
                    "isError":false,"content":[{"type":"text","text":receipt.to_string()}]
                }})).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (_directory, runtime, mut context, _) = fixture();
    context.backend_url = Some(format!("http://{}", listener.local_addr().unwrap()));
    context.auth_token = Some("test-token".into());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let request = json!({"operation_key":"redacted-cloud-commit","items":[{
        "request_id":"cloud","space":{"project_store":"backend","space_id":"42"},
        "item":{"title":"Created before item access was lost"}
    }]});
    let committed = invoke(
        &runtime,
        &context,
        "batch_create_board_items",
        request.clone(),
    )
    .await;
    assert_hidden_commit(&committed["results"][0], "cloud");
    denied.store(true, Ordering::SeqCst);
    for (name, arguments) in [
        (
            "get_board_operation",
            json!({"operation_id":committed["operation_id"]}),
        ),
        ("batch_create_board_items", request),
    ] {
        let response = call(&runtime, name, arguments, &context).await;
        assert_eq!(response["isError"], true, "{response}");
        assert!(response.to_string().contains("403"), "{response}");
        assert!(!response.to_string().contains("committed"));
    }
    denied.store(false, Ordering::SeqCst);
    let restored = invoke(
        &runtime,
        &context,
        "get_board_operation",
        json!({
            "operation_id":committed["operation_id"]
        }),
    )
    .await;
    assert_eq!(restored, committed);
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn failed_create_does_not_block_independent_creates_in_the_same_space() {
    let (_directory, runtime, context, space) = fixture();
    let request = json!({"operation_key":"independent-creates","items":[
        {"request_id":"invalid","space":space,"item":{"title":"   "}},
        {"request_id":"second","space":space,"item":{"title":"Second"}},
        {"request_id":"third","space":space,"item":{"title":"Third"}}
    ]});
    let result = invoke(
        &runtime,
        &context,
        "batch_create_board_items",
        request.clone(),
    )
    .await;
    assert_eq!(result["counts"]["failed"], 1, "{result}");
    assert_eq!(result["counts"]["succeeded"], 2);
    assert_eq!(result["counts"]["not_executed"], 0);
    assert_eq!(result["results"][0]["committed"], false);
    assert_eq!(result["results"][1]["result"]["title"], "Second");
    assert_eq!(result["results"][2]["result"]["title"], "Third");
    assert_eq!(
        invoke(&runtime, &context, "batch_create_board_items", request).await,
        result
    );
    let tasks = runtime
        .stand_in_store()
        .list_tasks(space["space_id"].as_str().unwrap())
        .unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn failed_explicit_target_still_blocks_its_successor_but_not_other_targets() {
    let (_directory, runtime, context, space) = fixture();
    let created = invoke(
        &runtime,
        &context,
        "batch_create_board_items",
        json!({
            "operation_key":"seed-dependencies","items":[
                {"request_id":"first","space":space,"item":{"title":"First"}},
                {"request_id":"second","space":space,"item":{"title":"Second"}}
            ]
        }),
    )
    .await;
    let first = &created["results"][0]["target"];
    let second = &created["results"][1]["target"];
    let result = invoke(&runtime, &context, "batch_update_board_items", json!({
        "operation_key":"preserve-dependencies","items":[
            {"request_id":"conflict","target":first,"expected_version":99,"patch":{"title":"Conflict"}},
            {"request_id":"blocked","target":first,"expected_version":1,"patch":{"title":"Must not apply"}},
            {"request_id":"independent","target":second,"expected_version":1,"patch":{"title":"Independent"}}
        ]
    })).await;
    assert_eq!(result["results"][0]["state"], "failed");
    assert_eq!(result["results"][0]["error"]["code"], "version_conflict");
    assert_eq!(result["results"][1]["state"], "not_executed");
    assert_eq!(result["results"][1]["committed"], false);
    assert_eq!(result["results"][2]["state"], "succeeded");
    let unchanged = runtime
        .stand_in_store()
        .get_task(
            space["space_id"].as_str().unwrap(),
            first["item_id"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(unchanged.version, 1);
    assert_eq!(unchanged.title.as_deref(), Some("First"));
}

fn assert_hidden_commit(value: &Value, request_id: &str) {
    assert_eq!(
        value,
        &json!({
            "request_id":request_id,"state":"succeeded","committed":true,
            "error":{"code":"result_unavailable",
                "message":"Committed result is unavailable under current access","retryable":false}
        })
    );
}

#[tokio::test]
async fn committed_receipts_isolate_deleted_items_without_replaying_or_erasing_snapshots() {
    let (directory, runtime, context, space) = fixture();
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    // Delete the predecessor after its commit, before the initial response is projected.
    connection
        .execute_batch(
            "CREATE TRIGGER hide_predecessor AFTER INSERT ON loop_items
         WHEN NEW.resource_type='task' AND NEW.title='Visible successor'
         BEGIN UPDATE loop_items SET deleted_at='2026-01-01T00:00:00Z'
           WHERE resource_type='task' AND title='Hidden predecessor'
             AND cloud_project_id=NEW.cloud_project_id; END;",
        )
        .unwrap();
    let request = json!({"operation_key":"deleted-receipt","items":[
        {"request_id":"hidden","space":space,"item":{"title":"Hidden predecessor"}},
        {"request_id":"visible","space":space,"item":{"title":"Visible successor"}}
    ]});
    let result = invoke(
        &runtime,
        &context,
        "batch_create_board_items",
        request.clone(),
    )
    .await;
    assert_eq!(result["state"], "completed");
    assert_eq!(result["counts"]["succeeded"], 2);
    assert_eq!(result["counts"]["failed"], 0);
    assert_hidden_commit(&result["results"][0], "hidden");
    assert_eq!(result["results"][1]["result"]["title"], "Visible successor");
    let operation = result["operation_id"].as_str().unwrap();
    let saved = runtime
        .stand_in_store()
        .board_operation(operation, &owner(&runtime, &context))
        .unwrap()
        .unwrap();
    let hidden_id = saved["results"][0]["target"]["item_id"].as_str().unwrap();
    assert_eq!(saved["results"][0]["result"]["title"], "Hidden predecessor");
    assert!(!result.to_string().contains(hidden_id));
    assert_eq!(
        invoke(&runtime, &context, "batch_create_board_items", request).await,
        result
    );
    assert_eq!(
        invoke(
            &runtime,
            &context,
            "get_board_operation",
            json!({"operation_id":operation})
        )
        .await,
        result
    );
    let task_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM loop_items WHERE resource_type='task' AND cloud_project_id=?1",
            [space["space_id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_count, 2);
    connection
        .execute(
            "UPDATE loop_items SET deleted_at=NULL WHERE id=?1",
            [hidden_id],
        )
        .unwrap();
    let restored = invoke(
        &runtime,
        &context,
        "get_board_operation",
        json!({"operation_id":operation}),
    )
    .await;
    assert_eq!(restored["results"], saved["results"]);
    assert_eq!(restored["results"][0]["item_version"], 1);
}

#[tokio::test]
async fn revoked_device_authority_hides_the_whole_receipt_without_replaying() {
    let (_directory, runtime, mut context, space) = fixture();
    let request = json!({"operation_key":"revoked-device","items":[
        {"request_id":"one","space":space,"item":{"title":"Private committed title"}}
    ]});
    let committed = invoke(
        &runtime,
        &context,
        "batch_create_board_items",
        request.clone(),
    )
    .await;
    let principal = owner(&runtime, &context);
    context.current_device_id = Some("another-device".into());
    assert_eq!(owner(&runtime, &context), principal);
    let denied = call(
        &runtime,
        "get_board_operation",
        json!({"operation_id":committed["operation_id"]}),
        &context,
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(denied.to_string().contains("scope_violation"));
    assert!(!denied.to_string().contains("Private committed title"));
    assert!(!denied.to_string().contains(
        committed["results"][0]["target"]["item_id"]
            .as_str()
            .unwrap()
    ));
    let replay = call(&runtime, "batch_create_board_items", request, &context).await;
    assert_eq!(replay["isError"], true);
    assert!(!replay.to_string().contains("Private committed title"));
    context.current_device_id = Some("device-1".into());
    assert_eq!(
        invoke(
            &runtime,
            &context,
            "get_board_operation",
            json!({"operation_id":committed["operation_id"]})
        )
        .await,
        committed
    );
    assert_eq!(
        runtime
            .stand_in_store()
            .list_tasks(space["space_id"].as_str().unwrap())
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn unavailable_project_authority_hides_the_whole_committed_operation() {
    let (directory, runtime, context, space) = fixture();
    let request = json!({"operation_key":"removed-project","items":[
        {"request_id":"one","space":space,"item":{"title":"Project-private title"}}
    ]});
    let committed = invoke(
        &runtime,
        &context,
        "batch_create_board_items",
        request.clone(),
    )
    .await;
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection.execute(
        "UPDATE loop_items SET deleted_at='2026-01-01T00:00:00Z' WHERE id=?1 AND resource_type='project'",
        [space["space_id"].as_str().unwrap()]
    ).unwrap();
    let denied = call(
        &runtime,
        "get_board_operation",
        json!({"operation_id":committed["operation_id"]}),
        &context,
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(!denied.to_string().contains("Project-private title"));
    assert!(!denied.to_string().contains(
        committed["results"][0]["target"]["item_id"]
            .as_str()
            .unwrap()
    ));
    let replay = call(&runtime, "batch_create_board_items", request, &context).await;
    assert_eq!(replay["isError"], true);
    connection
        .execute(
            "UPDATE loop_items SET deleted_at=NULL WHERE id=?1",
            [space["space_id"].as_str().unwrap()],
        )
        .unwrap();
    assert_eq!(
        invoke(
            &runtime,
            &context,
            "get_board_operation",
            json!({"operation_id":committed["operation_id"]})
        )
        .await,
        committed
    );
    assert_eq!(
        runtime
            .stand_in_store()
            .list_tasks(space["space_id"].as_str().unwrap())
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn completed_local_receipts_recover_after_root_save_failures_without_reapplying() {
    for fail_progress_save in [false, true] {
        let (directory, runtime, context, space) = fixture();
        let created = invoke(
            &runtime,
            &context,
            "batch_create_board_items",
            json!({"operation_key":"seed","items":[{"request_id":"seed","space":space,"item":{"title":"Original"}}]}),
        )
        .await;
        let target = created["results"][0]["target"].clone();
        let request = json!({"operation_key":"recover-update","items":[{"request_id":"update","target":target,"expected_version":1,"patch":{"title":"Committed once"}}]});
        let principal = owner(&runtime, &context);
        let operation = hash(&json!([principal, request["operation_key"]]));
        let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
        let failure_condition = if fail_progress_save {
            "json_extract(NEW.metadata,'$.results[0].state')='succeeded'"
        } else {
            "json_extract(NEW.metadata,'$.state')='completed'"
        };
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_root_save BEFORE UPDATE ON loop_items
             WHEN NEW.id='{operation}' AND {failure_condition}
             BEGIN SELECT RAISE(ABORT,'Injected root save failure'); END;"
            ))
            .unwrap();
        let failed = call(
            &runtime,
            "batch_update_board_items",
            request.clone(),
            &context,
        )
        .await;
        assert_eq!(failed["isError"], true, "{failed}");
        let saved = runtime
            .stand_in_store()
            .board_operation(&operation, &principal)
            .unwrap()
            .unwrap();
        assert_eq!(saved["state"], "running");
        assert_eq!(
            saved["results"][0]["state"],
            if fail_progress_save {
                "not_executed"
            } else {
                "succeeded"
            }
        );
        let recovery_error = call(
            &runtime,
            "get_board_operation",
            json!({"operation_id":operation}),
            &context,
        )
        .await;
        assert_eq!(
            recovery_error["isError"], true,
            "Recovery must report a failed durable save: {recovery_error}"
        );
        connection
            .execute_batch("DROP TRIGGER reject_root_save")
            .unwrap();
        let recovered = invoke(
            &runtime,
            &context,
            "get_board_operation",
            json!({"operation_key":"recover-update"}),
        )
        .await;
        assert_eq!(recovered["state"], "completed");
        assert_eq!(recovered["counts"]["succeeded"], 1);
        assert_eq!(recovered["results"][0]["item_version"], 2);
        assert_eq!(recovered["results"][0]["result"]["title"], "Committed once");
        assert_eq!(
            invoke(&runtime, &context, "batch_update_board_items", request).await,
            recovered
        );
        assert_eq!(
            runtime
                .stand_in_store()
                .board_operation(&operation, &principal)
                .unwrap()
                .unwrap()["state"],
            "completed"
        );
        let current = runtime
            .stand_in_store()
            .get_task(
                space["space_id"].as_str().unwrap(),
                target["item_id"].as_str().unwrap(),
            )
            .unwrap();
        assert_eq!(current.version, 2);
        assert_eq!(current.title.as_deref(), Some("Committed once"));
    }
}

#[tokio::test]
async fn recovery_keeps_running_while_an_entry_or_remote_operation_is_unresolved() {
    let (_directory, runtime, context, space) = fixture();
    let created = invoke(&runtime, &context, "batch_create_board_items", json!({"operation_key":"active-root","items":[{"request_id":"seed","space":space,"item":{"title":"Original"}}]})).await;
    let operation = created["operation_id"].as_str().unwrap();
    let principal = owner(&runtime, &context);
    let completed = runtime
        .stand_in_store()
        .board_operation(operation, &principal)
        .unwrap()
        .unwrap();
    for pending in ["entry", "remote"] {
        let mut state = completed.clone();
        state["state"] = json!("running");
        if pending == "entry" {
            // There is no leaf receipt for this distinct, still-unstarted entry.
            state["request"]["items"][0]["request_id"] = json!("pending");
            state["results"][0] =
                json!({"request_id":"pending","state":"not_executed","committed":false});
        } else {
            state["remote"] =
                json!({"operation_key":"pending-remote","indexes":[],"state":"unknown"});
        }
        runtime
            .stand_in_store()
            .save_board_operation(operation, &principal, &state)
            .unwrap();
        let observed = invoke(
            &runtime,
            &context,
            "get_board_operation",
            json!({"operation_id":operation}),
        )
        .await;
        assert_eq!(observed["state"], "running", "{pending}: {observed}");
        assert_eq!(
            runtime
                .stand_in_store()
                .board_operation(operation, &principal)
                .unwrap()
                .unwrap()["state"],
            "running"
        );
    }
}
