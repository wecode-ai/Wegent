use super::*;

async fn backend(
    respond: impl Fn(Value) -> Value + Clone + Send + Sync + 'static,
) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{
        extract::Path,
        http::HeaderMap,
        routing::{get, post},
        Json, Router,
    };

    let app = Router::new()
        .route(
            "/api/mcp/wework-space/sse",
            post(move |headers: HeaderMap, Json(request): Json<Value>| {
                let respond = respond.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer test-token");
                    let value = respond(request.clone());
                    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":{
                        "isError":false,"content":[{"type":"text","text":value.to_string()}]
                    }}))
                }
            }),
        )
        .route(
            "/api/v1/loop-items/{item}",
            get(|Path(item): Path<String>| async move {
                Json(json!({"id":item,"cloud_project_id":"42","parent_id":
                if item == "CHILD" { json!("PARENT") } else { Value::Null }}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, server)
}

fn remote_success(entry: &Value) -> Value {
    json!({"request_id":entry["request_id"],"target":entry["target"],
        "state":"succeeded","result":{"item":{"id":entry["target"]["item_id"]},"sections":{}}})
}

#[tokio::test]
async fn mixed_reads_keep_real_local_results_when_remote_entries_are_missing_or_invalid() {
    for (case, successful_remote) in [
        ("missing_results", 0),
        ("not_an_array", 0),
        ("short", 1),
        ("reversed", 2),
        ("duplicate", 1),
        ("wrong_target", 1),
        ("invalid_result", 1),
        ("unsolicited_local_identity", 1),
        ("backend_permission_failure", 0),
    ] {
        let (url, server) = backend(move |request| {
            let entries = request["params"]["arguments"]["items"].as_array().unwrap();
            let first = remote_success(&entries[0]);
            let second = remote_success(&entries[1]);
            match case {
                "missing_results" => json!({}),
                "not_an_array" => json!({"results":{}}),
                "backend_permission_failure" => json!({"error":{"code":"scope_violation","message":"Delegated category denied"}}),
                "short" => json!({"results":[first]}),
                "reversed" => json!({"results":[second,first]}),
                "duplicate" => json!({"results":[first.clone(),first,second]}),
                "wrong_target" => {
                    let mut invalid = first;
                    invalid["target"]["item_id"] = json!("SECRET");
                    invalid["result"] = json!({"private":"must not escape"});
                    json!({"results":[invalid,second]})
                }
                "invalid_result" => {
                    let mut invalid = first;
                    invalid["result"] = json!([]);
                    json!({"results":[invalid,second]})
                }
                "unsolicited_local_identity" => {
                    let mut invalid = first;
                    invalid["request_id"] = json!("local");
                    invalid["result"] = json!({"private":"must not escape"});
                    json!({"results":[invalid,second]})
                }
                _ => unreachable!(),
            }
        })
        .await;
        let (_directory, runtime, mut context, space) = fixture();
        context.backend_url = Some(url);
        context.auth_token = Some("test-token".into());
        let item = runtime
            .stand_in_store()
            .create_task(
                space["space_id"].as_str().unwrap(),
                serde_json::from_value(json!({"title":"Persisted local evidence"})).unwrap(),
            )
            .unwrap();
        let remote_space = json!({"project_store":"backend","space_id":"42"});
        let response = invoke(
            &runtime,
            &context,
            "batch_get_board_items",
            json!({"items":[
                {"request_id":"local","target":{"space":space,"item_id":item.id}},
                {"request_id":"first","target":{"space":remote_space,"item_id":"REMOTE-1"}},
                {"request_id":"second","target":{"space":remote_space,"item_id":"REMOTE-2"}}
            ]}),
        )
        .await;
        assert_eq!(
            response["results"].as_array().unwrap().len(),
            3,
            "{case}: {response}"
        );
        assert_eq!(
            response["counts"]["succeeded"],
            1 + successful_remote,
            "{case}: {response}"
        );
        assert_eq!(response["results"][0]["request_id"], "local");
        assert_eq!(
            response["results"][0]["result"]["item"]["title"],
            "Persisted local evidence"
        );
        for (index, expected_id) in [(1, "first"), (2, "second")] {
            let result = &response["results"][index];
            assert_eq!(result["request_id"], expected_id);
            if result["state"] == "failed" {
                let denied = case == "backend_permission_failure";
                assert_eq!(
                    result["error"]["code"],
                    if denied {
                        "scope_violation"
                    } else {
                        "source_unavailable"
                    },
                    "{case}: {response}"
                );
                assert_eq!(result["error"]["retryable"], !denied);
            }
        }
        assert!(!response.to_string().contains("must not escape"));
        server.abort();
    }
}

#[tokio::test]
async fn mixed_candidate_reads_correlate_backend_ids_before_restoring_original_positions() {
    for mode in ["complete", "incomplete", "denied"] {
        let (url, server) = backend(move |request| {
            let spaces = request["params"]["arguments"]["spaces"].as_array().unwrap();
            let result = |index: usize| {
                json!({"request_id":index.to_string(),"space":spaces[index],
                "state":"succeeded","result":{"members":[{"id":spaces[index]["space_id"]}]}})
            };
            let results = match mode {
                "incomplete" => vec![result(1)],
                "denied" => vec![
                    result(1),
                    json!({"request_id":"0","target":null,
                    "state":"failed","committed":false,"error":{"code":"not_found",
                    "message":"Target is unavailable","retryable":false}}),
                ],
                _ => vec![result(1), result(0)],
            };
            json!({"results":results})
        })
        .await;
        let (_directory, runtime, mut context, local) = fixture();
        context.backend_url = Some(url);
        context.auth_token = Some("test-token".into());
        let response = invoke(
            &runtime,
            &context,
            "batch_get_assignment_candidates",
            json!({"spaces":[
                local, {"project_store":"backend","space_id":"42"},
                {"project_store":"backend","space_id":"43"}
            ]}),
        )
        .await;
        assert_eq!(response["results"][0]["state"], "succeeded");
        assert_eq!(response["results"][1]["request_id"], "1");
        assert_eq!(response["results"][2]["request_id"], "2");
        assert_eq!(response["results"][2]["result"]["members"][0]["id"], "43");
        if mode == "incomplete" {
            assert_eq!(
                response["results"][1]["error"]["code"],
                "source_unavailable"
            );
        } else if mode == "denied" {
            assert_eq!(response["results"][1]["error"]["code"], "not_found");
            assert_eq!(response["results"][1]["error"]["retryable"], false);
            assert_eq!(
                response["results"][1]["space"],
                json!({"project_store":"backend","space_id":"42"})
            );
        } else {
            assert_eq!(response["results"][1]["result"]["members"][0]["id"], "42");
        }
        server.abort();
    }
}

#[tokio::test]
async fn malformed_parent_section_response_does_not_erase_the_authorized_child_read() {
    let (url, server) = backend(|request| {
        let args = &request["params"]["arguments"];
        let entry = &args["items"][0];
        let mut result = remote_success(entry);
        if entry["request_id"] == "parent" {
            assert_eq!(args["include"], json!(["permissions"]));
            result["request_id"] = json!("wrong-identity");
        }
        json!({"results":[result]})
    })
    .await;
    let (_directory, runtime, mut context, _) = fixture();
    context.backend_url = Some(url);
    context.auth_token = Some("test-token".into());
    context.grant = Some(SpaceContextGrant {
        version: 1,
        task_id: "child-runtime".into(),
        space_id: Some("42".into()),
        item_id: Some("CHILD".into()),
        role: Some(SpaceContextRole::Executor),
        categories: HashSet::from([BoardToolCategory::Execution]),
        expires_at_unix: Local::now().timestamp() + 60,
        ..SpaceContextGrant::default()
    });
    let space = json!({"project_store":"backend","space_id":"42"});
    let response = invoke(
        &runtime,
        &context,
        "batch_get_board_items",
        json!({"items":[
        {"request_id":"child","target":{"space":space,"item_id":"CHILD"}},
        {"request_id":"parent","target":{"space":space,"item_id":"PARENT"}}
    ],"include":["permissions","attachment_metadata"]}),
    )
    .await;
    assert_eq!(response["counts"]["succeeded"], 1, "{response}");
    assert_eq!(response["results"][0]["result"]["item"]["id"], "CHILD");
    assert_eq!(
        response["results"][1]["error"]["code"],
        "source_unavailable"
    );
    server.abort();
}

#[tokio::test]
async fn personal_default_catalog_metadata_does_not_restrict_an_independent_explicit_target() {
    let (_directory, runtime, mut context, space) = fixture();
    let default = runtime
        .stand_in_store()
        .create_project(ProjectCreate {
            name: "Incomplete personal default".into(),
            project_key: Some("DEFAULT".into()),
            description: String::new(),
            task_provider: crate::task_runtime::TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    rusqlite::Connection::open(runtime.stand_in_store().path()).unwrap().execute(
        "UPDATE loop_items SET metadata = json_remove(metadata, '$.project_store') WHERE id = ?1",
        [&default.id],
    ).unwrap();
    context.grant = Some(SpaceContextGrant {
        version: 1,
        task_id: "personal-runtime".into(),
        space_id: Some(default.id),
        item_id: Some("old-default".into()),
        expires_at_unix: Local::now().timestamp() + 60,
        ..SpaceContextGrant::default()
    });
    let item = runtime
        .stand_in_store()
        .create_task(
            space["space_id"].as_str().unwrap(),
            serde_json::from_value(json!({"title":"Independent explicitly selected Issue"}))
                .unwrap(),
        )
        .unwrap();
    let response = invoke(
        &runtime,
        &context,
        "batch_get_board_items",
        json!({"items":[{
            "request_id":"explicit","target":{"space":space,"item_id":item.id}
        }]}),
    )
    .await;
    assert_eq!(response["results"][0]["state"], "succeeded", "{response}");
    assert_eq!(
        response["results"][0]["result"]["item"]["title"],
        "Independent explicitly selected Issue"
    );
}
