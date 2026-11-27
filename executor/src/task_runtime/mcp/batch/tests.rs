use super::*;

#[path = "history_regressions.rs"]
mod history_regressions;

#[path = "query_regressions.rs"]
mod query_regressions;

#[path = "receipt_regressions.rs"]
mod receipt_regressions;

#[path = "read_regressions.rs"]
mod read_regressions;

#[test]
fn shared_contract_rejects_nested_ambiguity() {
    let tools = tools();
    assert_eq!(tools.len(), 12);
    let schema = &tools
        .iter()
        .find(|tool| tool["name"] == "batch_update_board_items")
        .unwrap()["inputSchema"];
    assert!(validate(schema, &json!({"operation_key":"test","items":[]})).is_err());
    assert!(validate(schema, &json!({"operation_key":"test","items":[{"request_id":"1","target":{"space":{"project_store":"backend","space_id":"1","device_id":"spoof"},"item_id":"I-1"},"expected_version":1,"patch":{"title":"Changed"}}]})).is_err());
    let search = &tools
        .iter()
        .find(|tool| tool["name"] == "search_board_items")
        .unwrap()["inputSchema"];
    assert!(validate(search, &json!({"limit":u64::MAX})).is_err());
    assert!(validate(search, &json!({"limit":0})).is_err());
    assert!(validate(search, &json!({"limit":200})).is_ok());
}

#[test]
fn canonical_payload_hash_is_key_order_independent() {
    assert_eq!(
        hash(&json!({"a":1,"b":{"c":2,"d":3}})),
        hash(&json!({"b":{"d":3,"c":2},"a":1}))
    );
}

fn fixture() -> (
    tempfile::TempDir,
    TaskRuntime,
    SpaceMcpRequestContext,
    Value,
) {
    let directory = tempfile::tempdir().unwrap();
    let store =
        crate::task_runtime::LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Batch project".into(),
            project_key: Some("BATCH".into()),
            description: String::new(),
            task_provider: crate::task_runtime::TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let mut context = SpaceMcpRequestContext::new(None, None, None);
    context.current_device_id = Some("device-1".into());
    let space = json!({"project_store":"local","device_id":"device-1","space_id":project.id});
    (directory, runtime, context, space)
}

async fn invoke(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    arguments: Value,
) -> Value {
    let result = call(runtime, name, arguments, context).await;
    assert_eq!(result["isError"], false, "{result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn pages_and_aggregates_all_items_without_the_old_200_item_truncation() {
    let (_directory, runtime, context, space) = fixture();
    for index in 0..205 {
        runtime
            .stand_in_store()
            .create_task(
                space["space_id"].as_str().unwrap(),
                serde_json::from_value(
                    json!({"title":format!("Evidence {index}"),"tags":["review","feature"]}),
                )
                .unwrap(),
            )
            .unwrap();
    }
    let mut page = invoke(
        &runtime,
        &context,
        "search_board_items",
        json!({"scope":{"kind":"projects","spaces":[space]},"limit":80}),
    )
    .await;
    assert_eq!(page["matched_total"], 205);
    assert_eq!(page["coverage"]["complete"], true);
    let query = page["query_id"].clone();
    let mut ids = HashSet::new();
    loop {
        for item in page["items"].as_array().unwrap() {
            assert!(ids.insert(item["id"].clone().to_string()));
        }
        if page["next_cursor"].is_null() {
            break;
        }
        page = invoke(
            &runtime,
            &context,
            "search_board_items",
            json!({"cursor":page["next_cursor"],"limit":80}),
        )
        .await;
    }
    assert_eq!(ids.len(), 205);
    let aggregate = invoke(
        &runtime,
        &context,
        "aggregate_board_items",
        json!({"query_id":query,"group_by":["status"]}),
    )
    .await;
    assert_eq!(aggregate["buckets"][0]["count"], 205);
    let tags = invoke(
        &runtime,
        &context,
        "aggregate_board_items",
        json!({"query_id":query,"group_by":["tag"]}),
    )
    .await;
    assert_eq!(tags["count_mode"], "memberships");
    assert_eq!(
        tags["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bucket| bucket["count"].as_u64().unwrap())
            .sum::<u64>(),
        410
    );
    let discovered = invoke(&runtime, &context, "list_spaces", json!({})).await;
    assert!(discovered["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["space"] == space));
    let board = invoke(
        &runtime,
        &context,
        "describe_space_board",
        json!({"space":space}),
    )
    .await;
    assert_eq!(board["board_config"]["statuses"][0]["id"], "inbox");
}

#[tokio::test]
async fn mutations_replay_after_restart_and_block_later_changes_after_a_conflict() {
    let (directory, runtime, context, space) = fixture();
    let created = invoke(&runtime,&context,"batch_create_board_items",json!({"operation_key":"create","items":[{"request_id":"create","space":space,"item":{"title":"Original"}}]})).await;
    assert_eq!(created["counts"]["succeeded"], 1, "{created}");
    let target = created["results"][0]["target"].clone();
    let values = json!({"operation_key":"update","items":[
        {"request_id":"first","target":target,"expected_version":1,"patch":{"title":"Reviewed"}},
        {"request_id":"stale","target":target,"expected_version":1,"patch":{"title":"Stale"}},
        {"request_id":"blocked","target":target,"expected_version":2,"patch":{"title":"Must not run"}}
    ]});
    let preview = invoke(
        &runtime,
        &context,
        "batch_update_board_items",
        json!({"preview":true,"operation_key":"preview","items":[values["items"][0]]}),
    )
    .await;
    assert_eq!(preview["results"][0]["committed"], false);
    let result = invoke(
        &runtime,
        &context,
        "batch_update_board_items",
        values.clone(),
    )
    .await;
    assert_eq!(result["results"][0]["state"], "succeeded", "{result}");
    assert_eq!(result["results"][1]["state"], "failed");
    assert_eq!(result["results"][2]["state"], "not_executed");
    assert_eq!(
        invoke(
            &runtime,
            &context,
            "batch_update_board_items",
            values.clone()
        )
        .await,
        result
    );
    drop(runtime);
    let runtime = TaskRuntime::new(
        crate::task_runtime::LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &runtime,
            &context,
            "get_board_operation",
            json!({"operation_key":"update"})
        )
        .await,
        result
    );
    assert_eq!(
        invoke(&runtime, &context, "batch_update_board_items", values).await,
        result
    );
    let current = individual(
        &runtime,
        &context,
        "get_board_item",
        json!({"space_id":space["space_id"],"item_id":target["item_id"]}),
    )
    .await
    .unwrap();
    assert_eq!(current["title"], "Reviewed");
    assert_eq!(current["version"], 2);
}

#[tokio::test]
async fn comments_preserve_history_paging_and_never_duplicate_on_replay() {
    let (_directory, runtime, context, space) = fixture();
    let created=invoke(&runtime,&context,"batch_create_board_items",json!({"operation_key":"create","items":[{"request_id":"one","space":space,"item":{"title":"History"}}]})).await;
    let target = created["results"][0]["target"].clone();
    let request = json!({"operation_key":"comments","items":(0..4).map(|index|json!({"request_id":index.to_string(),"target":target,"body":format!("Evidence {index}")})).collect::<Vec<_>>()});
    let written = invoke(
        &runtime,
        &context,
        "batch_add_board_item_comments",
        request.clone(),
    )
    .await;
    assert_eq!(written["counts"]["succeeded"], 4, "{written}");
    assert_eq!(
        invoke(&runtime, &context, "batch_add_board_item_comments", request).await,
        written
    );
    let first = invoke(
        &runtime,
        &context,
        "batch_list_board_item_comments",
        json!({"items":[{"request_id":"first","target":target,"mode":"oldest","limit":2}]}),
    )
    .await;
    let page = &first["results"][0]["result"];
    assert_eq!(page["comments"][0]["body"], "Evidence 0");
    assert_eq!(page["history_complete"], false);
    let last=invoke(&runtime,&context,"batch_list_board_item_comments",json!({"items":[{"request_id":"last","target":target,"mode":"after","cursor":page["next_cursor"],"limit":2}]})).await;
    assert_eq!(
        last["results"][0]["result"]["comments"][1]["body"],
        "Evidence 3"
    );
    assert_eq!(last["results"][0]["result"]["history_complete"], true);
}

#[tokio::test]
async fn nested_targets_do_not_expand_device_or_executor_authority() {
    let (_directory, runtime, mut context, space) = fixture();
    let created=invoke(&runtime,&context,"batch_create_board_items",json!({"operation_key":"create","items":[{"request_id":"one","space":space,"item":{"title":"Scoped"}}]})).await;
    let target = created["results"][0]["target"].clone();
    let mut foreign = target.clone();
    foreign["space"]["device_id"] = json!("another-device");
    let result=invoke(&runtime,&context,"batch_get_board_items",json!({"items":[{"request_id":"denied","target":foreign},{"request_id":"allowed","target":target}]})).await;
    assert_eq!(result["results"][0]["state"], "failed");
    assert_eq!(result["results"][1]["state"], "succeeded");
    context.grant = Some(SpaceContextGrant {
        version: 1,
        task_id: "delegated".into(),
        space_id: space["space_id"].as_str().map(str::to_owned),
        item_id: target["item_id"].as_str().map(str::to_owned),
        role: Some(SpaceContextRole::Executor),
        categories: context::role_categories(SpaceContextRole::Executor)
            .iter()
            .copied()
            .collect(),
        expires_at_unix: Local::now().timestamp() + 60,
        ..SpaceContextGrant::default()
    });
    let denied=invoke(&runtime,&context,"batch_update_board_items",json!({"operation_key":"denied","items":[{"request_id":"one","target":target,"expected_version":1,"patch":{"title":"Denied"}}]})).await;
    assert_eq!(denied["results"][0]["state"], "failed");
    assert!(authorize(&runtime,&context,&json!({"space":{"project_store":"backend","space_id":space["space_id"]},"item_id":target["item_id"]}),"get_board_item").await.is_err());
    assert_eq!(
        call(
            &runtime,
            "search_board_items",
            json!({"scope":{"kind":"projects","spaces":[space]}}),
            &context
        )
        .await["isError"],
        true
    );
}

#[tokio::test]
async fn cloud_batches_through_api_gateway_recover_lost_responses_by_key() {
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::AtomicUsize;
    let writes = Arc::new(AtomicUsize::new(0));
    let recorded = Arc::new(std::sync::Mutex::new(Value::Null));
    let writes_handler = writes.clone();
    let recorded_handler = recorded.clone();
    let backend=Router::new().route("/mcp/wework-space/sse",post(move |Json(request):Json<Value>|{
        let writes=writes_handler.clone();let recorded=recorded_handler.clone();
        async move {
            let args=&request["params"]["arguments"];
            if request["params"]["name"]=="batch_update_board_items" {
                writes.fetch_add(1,Ordering::SeqCst);
                *recorded.lock().unwrap()=args.clone();
                return (axum::http::StatusCode::BAD_GATEWAY,Json(json!({"error":"Response lost after commit"})));
            }
            assert_eq!(request["params"]["name"],"get_board_operation");
            let saved=recorded.lock().unwrap().clone();
            assert_eq!(args["operation_key"],saved["operation_key"]);
            let results=saved["items"].as_array().unwrap().iter().map(|entry|json!({"request_id":entry["request_id"],"target":entry["target"],"state":"succeeded","committed":true,"item_version":2,"result":{"id":entry["target"]["item_id"],"title":"Changed"}})).collect::<Vec<_>>();
            let receipt=json!({"operation_id":"cloud-receipt","state":"completed","results":results});
            (axum::http::StatusCode::OK,Json(json!({"jsonrpc":"2.0","id":request["id"],"result":{"content":[{"type":"text","text":receipt.to_string()}],"isError":false}})))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let gateway = Router::new().nest("/api", backend);
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let (_directory, runtime, mut context, _space) = fixture();
    context.backend_url = Some(format!("{url}/api/v1"));
    context.auth_token = Some("test-token".into());
    let request = json!({"operation_key":"remote","items":(0..3).map(|index|json!({"request_id":index.to_string(),"target":{"space":{"project_store":"backend","space_id":"42"},"item_id":format!("CLOUD-{index}")},"expected_version":1,"patch":{"title":"Changed"}})).collect::<Vec<_>>()});
    let first = invoke(
        &runtime,
        &context,
        "batch_update_board_items",
        request.clone(),
    )
    .await;
    assert_eq!(first["state"], "unknown");
    assert_eq!(first["counts"]["unknown"], 3);
    assert!(first["results"][0]["committed"].is_null());
    let recovered = invoke(
        &runtime,
        &context,
        "get_board_operation",
        json!({"operation_key":"remote"}),
    )
    .await;
    assert_eq!(recovered["counts"]["succeeded"], 3);
    assert_eq!(
        invoke(&runtime, &context, "batch_update_board_items", request).await,
        recovered
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    server.abort();
}
