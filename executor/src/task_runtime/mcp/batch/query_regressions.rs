use super::*;

fn create_item(runtime: &TaskRuntime, space: &Value, title: &str) -> String {
    runtime
        .stand_in_store()
        .create_task(
            space["space_id"].as_str().unwrap(),
            serde_json::from_value(json!({"title":title})).unwrap(),
        )
        .unwrap()
        .id
}

#[tokio::test]
async fn repeated_project_refs_do_not_duplicate_pages_coverage_or_aggregates() {
    let (_directory, runtime, context, space) = fixture();
    create_item(&runtime, &space, "First");
    create_item(&runtime, &space, "Second");
    let project = runtime
        .stand_in_store()
        .create_project(ProjectCreate {
            name: "Another project".into(),
            project_key: Some("OTHER".into()),
            description: String::new(),
            task_provider: crate::task_runtime::TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let other = json!({"project_store":"local","device_id":"device-1","space_id":project.id});
    create_item(&runtime, &other, "Third");
    let reordered =
        json!({"space_id":space["space_id"],"device_id":"device-1","project_store":"local"});
    let mut page = invoke(
        &runtime,
        &context,
        "search_board_items",
        json!({"scope":{"kind":"projects","spaces":[space,other,reordered,other]},"limit":1}),
    )
    .await;
    assert_eq!(page["matched_total"], 3);
    assert_eq!(page["coverage"]["complete"], true);
    let sources = page["coverage"]["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0]["space"], space);
    assert_eq!(sources[1]["space"], other);
    let query = page["query_id"].clone();
    let mut targets = HashSet::new();
    loop {
        for item in page["items"].as_array().unwrap() {
            assert!(targets.insert(hash(&item["target"])));
        }
        if page["next_cursor"].is_null() {
            break;
        }
        page = invoke(
            &runtime,
            &context,
            "search_board_items",
            json!({"cursor":page["next_cursor"],"limit":1}),
        )
        .await;
    }
    assert_eq!(targets.len(), 3);
    let aggregate = invoke(
        &runtime,
        &context,
        "aggregate_board_items",
        json!({"query_id":query,"group_by":["space"]}),
    )
    .await;
    assert_eq!(aggregate["count_mode"], "distinct_items");
    let mut counts = aggregate["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|bucket| bucket["count"].as_u64().unwrap())
        .collect::<Vec<_>>();
    counts.sort();
    assert_eq!(counts, vec![1, 2]);
}

#[tokio::test]
async fn deduplication_keeps_distinct_device_refs_subject_to_authorization() {
    let (_directory, runtime, context, space) = fixture();
    create_item(&runtime, &space, "Visible");
    let mut denied = space.clone();
    denied["device_id"] = json!("another-device");
    let result = invoke(
        &runtime,
        &context,
        "search_board_items",
        json!({"scope":{"kind":"projects","spaces":[space,denied,space]}}),
    )
    .await;
    assert_eq!(result["matched_total"], 1);
    assert_eq!(result["state"], "partial");
    assert_eq!(result["coverage"]["complete"], false);
    let sources = result["coverage"]["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0]["space"], space);
    assert_eq!(sources[1]["space"], denied);
    assert_eq!(sources[1]["state"], "unavailable");
    assert!(sources[1]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("another device"));
}

fn create_timed_item(runtime: &TaskRuntime, space: &Value, title: &str, stamp: Option<&str>) {
    let id = create_item(runtime, space, title);
    // Real provider fixtures may contain offsets or timezone-free ISO dates.
    let connection = rusqlite::Connection::open(runtime.stand_in_store().path()).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET created_at=?1,updated_at=?1,metadata=json_set(metadata,'$.due_at',?2) WHERE id=?3",
            rusqlite::params![stamp.unwrap_or("2026-01-01T00:00:00Z"), stamp, id],
        )
        .unwrap();
}

async fn sorted_titles(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    space: &Value,
    field: &str,
    direction: &str,
) -> Vec<String> {
    let mut page = invoke(
        runtime,
        context,
        "search_board_items",
        json!({"scope":{"kind":"projects","spaces":[space]},"sort":[{"field":field,"direction":direction},{"field":"title","direction":"asc"}],"limit":2}),
    )
    .await;
    let mut titles = Vec::new();
    loop {
        titles.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["title"].as_str().unwrap().to_owned()),
        );
        if page["next_cursor"].is_null() {
            break;
        }
        page = invoke(
            runtime,
            context,
            "search_board_items",
            json!({"cursor":page["next_cursor"],"limit":2}),
        )
        .await;
    }
    titles
}

#[tokio::test]
async fn time_sorts_compare_instants_across_offsets_and_keep_secondary_order_across_pages() {
    let (_directory, runtime, context, space) = fixture();
    for (title, stamp) in [
        ("early", "2026-01-01T08:00:00+08:00"),
        ("tie-b", "2026-01-01T02:00:00+01:00"),
        ("tie-a", "2026-01-01T01:00:00Z"),
        ("fraction", "2026-01-01T01:00:00.050"),
        ("later", "2026-01-01T00:30:00-01:00"),
        ("space-naive", "2026-01-01 01:00:00.100"),
        ("date-only", "2026-01-01"),
    ] {
        create_timed_item(&runtime, &space, title, Some(stamp));
    }
    for field in ["created_at", "updated_at", "due_at"] {
        assert_eq!(
            sorted_titles(&runtime, &context, &space, field, "asc").await,
            [
                "date-only",
                "early",
                "tie-a",
                "tie-b",
                "fraction",
                "space-naive",
                "later"
            ],
            "{field} ascending"
        );
        assert_eq!(
            sorted_titles(&runtime, &context, &space, field, "desc").await,
            [
                "later",
                "space-naive",
                "fraction",
                "tie-a",
                "tie-b",
                "date-only",
                "early"
            ],
            "{field} descending"
        );
    }
}

#[tokio::test]
async fn missing_due_dates_remain_first_ascending_and_last_descending() {
    let (_directory, runtime, context, space) = fixture();
    create_timed_item(&runtime, &space, "missing", None);
    create_timed_item(&runtime, &space, "early", Some("2026-01-01T08:00:00+08:00"));
    create_timed_item(&runtime, &space, "later", Some("2026-01-01T01:00:00Z"));
    assert_eq!(
        sorted_titles(&runtime, &context, &space, "due_at", "asc").await,
        ["missing", "early", "later"]
    );
    assert_eq!(
        sorted_titles(&runtime, &context, &space, "due_at", "desc").await,
        ["later", "early", "missing"]
    );
}

#[tokio::test]
async fn invalid_source_timestamps_cannot_be_silently_sorted_as_text() {
    let (_directory, runtime, context, space) = fixture();
    create_timed_item(&runtime, &space, "invalid", Some("not-a-timestamp"));
    for field in ["created_at", "updated_at", "due_at"] {
        let result = call(
            &runtime,
            "search_board_items",
            json!({"scope":{"kind":"projects","spaces":[space]},"sort":[{"field":field,"direction":"asc"}]}),
            &context,
        )
        .await;
        assert_eq!(result["isError"], true, "{result}");
        assert!(result
            .to_string()
            .contains("unsupported_sort: invalid source timestamp"));
    }
}

#[tokio::test]
async fn search_uses_raw_quotes_backslashes_and_tags_without_serializing_nulls() {
    let (_directory, runtime, context, space) = fixture();
    let item = runtime
        .stand_in_store()
        .create_task(
            space["space_id"].as_str().unwrap(),
            serde_json::from_value(json!({
                "title":"say \"hi\"",
                "description":r"C:\tmp",
                "tags":["tag \"quoted\"",r"tag\path"]
            }))
            .unwrap(),
        )
        .unwrap();
    let empty = create_item(&runtime, &space, "Empty source title");
    rusqlite::Connection::open(runtime.stand_in_store().path())
        .unwrap()
        .execute("UPDATE loop_items SET title=NULL WHERE id=?1", [empty])
        .unwrap();
    for query in [r#"say "hi""#, r"C:\tmp", r#"tag "quoted""#, r"tag\path"] {
        let page = invoke(
            &runtime,
            &context,
            "search_board_items",
            json!({"scope":{"kind":"projects","spaces":[space]},"query":query}),
        )
        .await;
        assert_eq!(page["matched_total"], 1, "{query}: {page}");
        assert_eq!(page["items"][0]["id"], item.id);
    }
    let page = invoke(
        &runtime,
        &context,
        "search_board_items",
        json!({"scope":{"kind":"projects","spaces":[space]},"query":"null"}),
    )
    .await;
    assert_eq!(page["matched_total"], 0);
}

#[tokio::test]
async fn issued_query_cursors_reject_owner_changes_tampering_and_query_mismatches() {
    let (_directory, runtime, context, space) = fixture();
    create_item(&runtime, &space, "First");
    create_item(&runtime, &space, "Second");
    let request = json!({"scope":{"kind":"projects","spaces":[space]},"limit":1});
    let first = invoke(&runtime, &context, "search_board_items", request.clone()).await;
    let second = invoke(&runtime, &context, "search_board_items", request).await;
    let mut foreign_owner = context.clone();
    foreign_owner.principal_id = Some("another-owner".into());
    let denied = call(
        &runtime,
        "search_board_items",
        json!({"cursor":first["next_cursor"]}),
        &foreign_owner,
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(denied.to_string().contains("cursor_expired"));
    let mismatch = call(
        &runtime,
        "search_board_items",
        json!({"query_id":second["query_id"],"cursor":first["next_cursor"]}),
        &context,
    )
    .await;
    assert_eq!(mismatch["isError"], true);
    assert!(mismatch.to_string().contains("Query cursor mismatch"));
    let bytes = STANDARD
        .decode(first["next_cursor"].as_str().unwrap())
        .unwrap();
    let mut tampered: Value = serde_json::from_slice(&bytes).unwrap();
    tampered["query_id"] = second["query_id"].clone();
    let denied = call(
        &runtime,
        "search_board_items",
        json!({"cursor":STANDARD.encode(tampered.to_string())}),
        &context,
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(denied.to_string().contains("cursor_expired"));
}

#[tokio::test]
async fn stand_in_project_discovery_keeps_local_results_and_reports_backend_failure() {
    let (_directory, runtime, mut context, space) = fixture();
    let app =
        axum::Router::new().fallback(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    context.backend_url = Some(format!("http://{}", listener.local_addr().unwrap()));
    context.auth_token = Some("test-token".into());
    context.stand_in = Some(crate::task_runtime::mcp::StandInMcpIdentity {
        task_id: "stand-in-project-discovery".into(),
        user: 7,
        device: "device-1".into(),
        role: None,
        work: None,
        ask_before_act: false,
        coordinator_batch: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
    });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let result =
        super::super::super::stand_in::call(&runtime, "list_projects", json!({}), &context).await;
    server.abort();
    assert_eq!(result["isError"], false, "{result}");
    let result: Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|project| project["space"] == space));
    assert_eq!(result["coverage"]["complete"], false);
    assert!(result["coverage"]["sources"]
        .as_array()
        .unwrap()
        .contains(&json!({"store":"backend","state":"unavailable"})));
}
