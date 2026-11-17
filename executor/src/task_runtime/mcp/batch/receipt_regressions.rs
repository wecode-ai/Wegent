use super::*;

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
