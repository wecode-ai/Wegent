use super::*;

async fn append_comments(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    target: &Value,
    operation: &str,
    indexes: std::ops::Range<usize>,
) {
    let count = indexes.len();
    let entries = indexes
        .map(|index| {
            json!({"request_id":index.to_string(),"target":target,"body":format!("Evidence {index}")})
        })
        .collect::<Vec<_>>();
    let written = invoke(
        runtime,
        context,
        "batch_add_board_item_comments",
        json!({"operation_key":operation,"items":entries}),
    )
    .await;
    assert_eq!(written["counts"]["succeeded"], count, "{written}");
}

async fn read_history(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    target: &Value,
    mode: &str,
    cursor: Option<Value>,
) -> Value {
    let mut entry = json!({"request_id":"history","target":target,"mode":mode,"limit":2});
    if let Some(cursor) = cursor {
        entry["cursor"] = cursor;
    }
    let response = invoke(
        runtime,
        context,
        "batch_list_board_item_comments",
        json!({"items":[entry]}),
    )
    .await;
    assert_eq!(response["results"][0]["state"], "succeeded", "{response}");
    response["results"][0]["result"].clone()
}

#[tokio::test]
async fn continuation_preserves_history_coverage_across_new_comments_and_empty_pages() {
    for initial_mode in ["latest", "oldest"] {
        let (_directory, runtime, context, space) = fixture();
        let created = invoke(
            &runtime,
            &context,
            "batch_create_board_items",
            json!({"operation_key":"create","items":[{"request_id":"one","space":space,"item":{"title":"History coverage"}}]}),
        )
        .await;
        let target = created["results"][0]["target"].clone();
        append_comments(&runtime, &context, &target, "initial-history", 0..4).await;
        let mut page = read_history(&runtime, &context, &target, initial_mode, None).await;
        assert_eq!(
            page["comments"][0]["body"],
            if initial_mode == "latest" {
                "Evidence 2"
            } else {
                "Evidence 0"
            }
        );
        assert_eq!(page["history_complete"], false);
        append_comments(&runtime, &context, &target, "new-history", 4..7).await;
        loop {
            let cursor = page["next_cursor"].clone();
            page = read_history(&runtime, &context, &target, "after", Some(cursor)).await;
            assert_eq!(
                page["history_complete"],
                initial_mode == "oldest" && page["has_later"] == false
            );
            if page["has_later"] == false {
                break;
            }
        }
        assert_eq!(
            page["comments"].as_array().unwrap().last().unwrap()["body"],
            "Evidence 6"
        );
        let empty = read_history(
            &runtime,
            &context,
            &target,
            "after",
            Some(page["next_cursor"].clone()),
        )
        .await;
        assert_eq!(empty["comments"], json!([]));
        assert_eq!(empty["history_complete"], initial_mode == "oldest");
    }
}

#[tokio::test]
async fn history_pages_do_not_decode_rows_outside_the_requested_window() {
    for mode in ["oldest", "latest"] {
        let (_directory, runtime, context, space) = fixture();
        let created = invoke(
            &runtime,
            &context,
            "batch_create_board_items",
            json!({"operation_key":"create","items":[{"request_id":"one","space":space,"item":{"title":"Bounded history"}}]}),
        )
        .await;
        let target = created["results"][0]["target"].clone();
        append_comments(&runtime, &context, &target, "bounded-history", 0..6).await;
        let sequence = if mode == "oldest" { 6 } else { 1 };
        // An unreadable distant row makes accidental whole-history decoding observable.
        rusqlite::Connection::open(runtime.stand_in_store().path())
            .unwrap()
            .execute(
                "UPDATE loop_item_comments SET content=x'00' WHERE task_id=?1 AND sequence_number=?2",
                rusqlite::params![target["item_id"].as_str().unwrap(), sequence],
            )
            .unwrap();
        assert!(runtime
            .list_comments(
                space["space_id"].as_str().unwrap(),
                target["item_id"].as_str().unwrap(),
                0,
            )
            .is_err());
        let page = read_history(&runtime, &context, &target, mode, None).await;
        assert_eq!(page["comments"].as_array().unwrap().len(), 2);
        assert_eq!(
            page["comments"][0]["body"],
            if mode == "oldest" {
                "Evidence 0"
            } else {
                "Evidence 4"
            }
        );
        assert_eq!(page["has_earlier"], mode == "latest");
        assert_eq!(page["has_later"], mode == "oldest");
        assert_eq!(page["history_complete"], false);
    }
}
