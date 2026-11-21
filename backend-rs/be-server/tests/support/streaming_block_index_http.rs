// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! User story: a long streaming turn retains ordered blocks and tool results,
//! including provider IDs that resemble internal metadata, through completion.
use std::{sync::Arc, time::Duration};

use brz_mysql::Json;
use brz_redis::Redis;
use serde_json::{Value, json};
use wegent_backend_rs::{build_app_state, task_store::DefaultTaskStore};

use super::{fixture::Fixture, http_e2e};

pub async fn verify(fixture: &Fixture) {
    http_e2e::require_loopback_services();
    let task_id = 181_i64;
    let subtask_id = 182_i64;
    http_e2e::seed_task(&fixture.mysql, "tasks", task_id, 7).await;
    fixture.seed_running_subtask(task_id, subtask_id, 7).await;
    fixture
        .mysql
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'RUNNING') WHERE id = ?",
            (task_id,),
        )
        .await
        .unwrap();
    let mut state = build_app_state().await.unwrap();
    state.mysql = fixture.mysql.clone();
    state.task_store = Arc::new(DefaultTaskStore::new(fixture.mysql.clone()));
    let redis = state.redis.clone().expect("real Redis");
    let list_key = format!("chat:streaming:blocks:{subtask_id}");
    let index_key = format!("chat:streaming:blocks_index:{subtask_id}");
    let (url, stop, server) = http_e2e::start_callback_server(state).await;
    let client = brz_http::Client::builder()
        .timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let send = async |event_type: &str, data: Value| {
        let response = client
            .post(&url)
            .unwrap()
            .json(&json!({
                "task_id": task_id, "subtask_id": subtask_id,
                "event_type": event_type, "data": data,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200, "{event_type}");
    };
    let mut expected_ids = Vec::new();
    for id in ["_watermark_id", "_watermark", "block:a"] {
        send(
            "response.block.created",
            json!({"block": {
                "id": id, "type": "tool", "tool_use_id": id,
                "status": "pending", "tool_output": "original",
            }}),
        )
        .await;
        expected_ids.push(id.to_string());
    }
    for number in 0..40 {
        let tool = format!("tool-{number}");
        let text = format!("text-{number}");
        send(
            "response.block.created",
            json!({"block": {
                "id": tool, "type": "tool", "tool_use_id": tool, "status": "pending",
            }}),
        )
        .await;
        send(
            "response.block.updated",
            json!({"block_id": tool,
                "updates": {"status": "done", "tool_output": format!("output-{number}")}
            }),
        )
        .await;
        send(
            "response.reasoning_summary_text.delta",
            json!({"delta": format!("reason-{number}")}),
        )
        .await;
        send(
            "response.output_text.delta",
            json!({"delta": format!("text-{number}"),
            "block_id": text, "block_offset": 0}),
        )
        .await;
    }
    // Another writer's unindexed append must be found beyond the current watermark.
    redis
        .rpush(
            &list_key,
            (r#"{"id":"legacy","type":"tool","status":"pending"}"#,),
        )
        .await
        .unwrap();
    send(
        "response.block.updated",
        json!({"block_id": "legacy", "updates": {"status": "done"}}),
    )
    .await;
    for id in &expected_ids {
        send(
            "response.block.updated",
            json!({"block_id": id,
            "updates": {"status": "done", "tool_output": "updated"}}),
        )
        .await;
    }
    // Stored metadata keeps every block in original order before completion.
    let raw: Vec<String> = redis.lrange(&list_key, 0, -1).await.unwrap();
    let blocks: Vec<Value> = raw
        .iter()
        .map(|raw| serde_json::from_str(raw).unwrap())
        .collect();
    assert_eq!(blocks.len(), 124);
    assert_eq!(
        blocks
            .iter()
            .filter(|block| block["id"] == "_watermark_id")
            .count(),
        1
    );
    assert_eq!(blocks[0]["tool_output"], "updated");
    for number in 0..40 {
        let tool = &blocks[3 + number * 3];
        assert_eq!(tool["id"], format!("tool-{number}"));
        assert_eq!(tool["tool_output"], format!("output-{number}"));
        assert_eq!(blocks[4 + number * 3]["type"], "thinking");
        assert_eq!(blocks[5 + number * 3]["id"], format!("text-{number}"));
    }
    let mut completed = redis
        .subscribe(format!("callback:channel:{subtask_id}"))
        .await
        .unwrap();
    send("response.completed", json!({"response": {"output": []}})).await;
    let event = http_e2e::next_callback(&mut completed).await;
    assert_eq!(event["type"], "done");
    let saved: Json<Value> = fixture
        .mysql
        .fetch_one("SELECT result FROM subtasks WHERE id = ?", (subtask_id,))
        .await
        .unwrap();
    let stored = saved.0["blocks"]
        .as_array()
        .expect("persisted streaming blocks");
    assert_eq!(stored.len(), 124);
    assert!(
        stored
            .iter()
            .all(|block| block.get("_content_key").is_none())
    );
    assert!(stored.iter().all(|block| block["status"] == "done"));
    assert_eq!(stored[5]["content"], "text-0");
    assert_eq!(stored[122]["content"], "text-39");
    let remaining: i64 = redis
        .command({
            let mut command = brz_redis::cmd("EXISTS");
            command
                .arg_encoded(&list_key)
                .unwrap()
                .arg_encoded(&index_key)
                .unwrap();
            command
        })
        .await
        .unwrap();
    assert_eq!(remaining, 0, "completion cleans both list and index");
    completed.close().await.unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}
