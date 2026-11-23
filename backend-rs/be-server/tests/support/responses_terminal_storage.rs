// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP callbacks and the recovery worker against a migrated task and a stale base row.

use std::{sync::Arc, time::Duration};

use brz_mysql::{Json, MysqlService};
use brz_redis::{Redis, RedisService};
use serde_json::{Value, json};
use wegent_backend_rs::{
    build_app_state,
    task_store::{DefaultTaskStore, TableTemplates},
};

use super::{fixture::Fixture, http_e2e};

const TASK_ID: i64 = 161;
const SUBTASK_ID: i64 = 162;
const FAILED_TASK_ID: i64 = 163;
const FAILED_SUBTASK_ID: i64 = 164;
const USER_ID: i32 = 7;
const PENDING: &str = "wegent:terminal-delivery:pending:rust";
const EVENTS: &str = "{wegent:terminal-delivery:pending:rust}:events";

pub async fn verify(fixture: &Fixture) {
    http_e2e::require_loopback_services();
    seed(fixture).await;
    let mysql = &fixture.mysql;
    let mut state = build_app_state().await.unwrap();
    state.mysql = mysql.clone();
    state.task_store = Arc::new(DefaultTaskStore::new(mysql.clone()).with_migrated_tables(
        TableTemplates {
            tasks: "tasks_0007",
            subtasks: "subtasks_0007",
        },
    ));
    let redis = state
        .redis
        .clone()
        .expect("real Redis for terminal delivery");
    let (url, stop, server) = http_e2e::start_callback_server(state).await;
    let metrics_url = url.replace("/api/internal/callback", "/metrics");
    let client = brz_http::Client::builder()
        .timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let completed_before = scrape_chat_metrics(&client, &metrics_url).await;
    let failed_before = scrape_chat_metrics(&client, &metrics_url).await;
    let send = async |task_id, subtask_id, event_type: &str, data: Value| {
        client
            .post(&url)
            .unwrap()
            .json(&json!({ "task_id": task_id, "subtask_id": subtask_id,
                "event_type": event_type, "data": data }))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    };

    let channel = format!("callback:channel:{SUBTASK_ID}");
    let mut completed = redis.subscribe(channel.as_str()).await.unwrap();
    let mut socket_events = redis.subscribe("socketio").await.unwrap();
    let marker = format!("terminal-delivery-callback-{SUBTASK_ID}");
    let label_path = format!("$.metadata.labels.\"{marker}\"");
    mysql
        .execute(
            format!(
                "CREATE TRIGGER reject_migrated_ack BEFORE UPDATE ON tasks_0007 FOR EACH ROW
                 BEGIN
                   IF JSON_CONTAINS_PATH(OLD.json, 'one', '{label_path}')
                     AND NOT JSON_CONTAINS_PATH(NEW.json, 'one', '{label_path}') THEN
                     SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture acknowledgement failure';
                   END IF;
                 END"
            ),
            (),
        )
        .await
        .unwrap();
    let result = json!({"response": {"output": [
        {"type":"message","content":[{"type":"output_text","text":"migrated result"}]}
    ]}});
    assert_eq!(
        send(TASK_ID, SUBTASK_ID, "response.completed", result).await,
        500
    );
    let delivery = http_e2e::next_callback(&mut completed).await;
    assert_eq!(delivery["type"], "done");
    assert_eq!(delivery["subtask_id"], SUBTASK_ID);
    assert_eq!(delivery["result"]["value"], "migrated result");
    loop {
        let frame = http_e2e::next_callback(&mut socket_events).await;
        if frame["event"] == "task:status" && frame["data"][0]["task_id"] == TASK_ID {
            assert_eq!(frame["room"], format!("user:{USER_ID}"));
            assert_eq!(frame["data"][0]["status"], "COMPLETED");
            break;
        }
    }
    socket_events.close().await.unwrap();
    let pending: Json<Value> = mysql
        .fetch_one("SELECT json FROM tasks_0007 WHERE id = ?", (TASK_ID,))
        .await
        .unwrap();
    assert_eq!(pending.0["status"]["status"], "COMPLETED");
    assert!(pending.0["metadata"]["labels"].get(&marker).is_some());
    mysql
        .execute("DROP TRIGGER reject_migrated_ack", ())
        .await
        .unwrap();
    let retry = json!({"response": {"output": [
        {"type":"message","content":[{"type":"output_text","text":"late retry result"}]}
    ]}});
    assert_eq!(
        send(TASK_ID, SUBTASK_ID, "response.completed", retry).await,
        200
    );
    assert_terminal(
        mysql,
        TASK_ID,
        SUBTASK_ID,
        "COMPLETED",
        &delivery["result"],
        None,
    )
    .await;
    let completed_after = scrape_chat_metrics(&client, &metrics_url).await;
    assert_chat_counter_incremented(
        &completed_before,
        &completed_after,
        r#"wegent_chat_runs_total{outcome="success",entrypoint="web",shell="unknown",execution_mode="unknown"}"#,
        "the committed terminal transition must increment the success counter once",
    );
    assert_eq!(
        scrape_chat_metrics(&client, &metrics_url).await,
        completed_after,
        "a second scrape must not reset cumulative counters",
    );

    // The first delivery committed before its post-commit acknowledgement
    // failed. The retry above replayed that winner without incrementing again.

    // A queued stale dispatch failure can survive another producer committing
    // and acknowledging the winner. Recovery must read the completed row on
    // the shard and retire the event, even though the base row is still running.
    verify_recovery_readback(&redis).await;
    assert_terminal(
        mysql,
        TASK_ID,
        SUBTASK_ID,
        "COMPLETED",
        &delivery["result"],
        None,
    )
    .await;
    let barrier = json!({"type": "fixture-barrier"});
    redis
        .publish(channel.as_str(), barrier.to_string())
        .await
        .unwrap();
    assert_eq!(http_e2e::next_callback(&mut completed).await, barrier);
    completed.close().await.unwrap();

    let mut failed = redis
        .subscribe(format!("callback:channel:{FAILED_SUBTASK_ID}"))
        .await
        .unwrap();
    let message = "executor could not start";
    let error = json!({"message": message, "code": "EXECUTOR_DISPATCH_FAILED"});
    assert_eq!(
        send(FAILED_TASK_ID, FAILED_SUBTASK_ID, "error", error.clone()).await,
        200
    );
    let delivery = http_e2e::next_callback(&mut failed).await;
    assert_eq!(delivery["type"], "error");
    assert_eq!(delivery["error"], message);
    assert_eq!(delivery["result"]["error_type"], "EXECUTOR_DISPATCH_FAILED");
    assert_terminal(
        mysql,
        FAILED_TASK_ID,
        FAILED_SUBTASK_ID,
        "FAILED",
        &delivery["result"],
        Some(message),
    )
    .await;
    let failed_after = scrape_chat_metrics(&client, &metrics_url).await;
    assert_chat_counter_incremented(
        &failed_before,
        &failed_after,
        r#"wegent_chat_runs_total{outcome="failed",entrypoint="web",shell="unknown",execution_mode="unknown"}"#,
        "the committed failure must increment the failed counter once",
    );
    assert_chat_counter_incremented(
        &failed_before,
        &failed_after,
        r#"wegent_chat_run_failures_total{error_category="platform",error_code="dispatch_error",stage="dispatch",entrypoint="web",shell="unknown",execution_mode="unknown"}"#,
        "the failed attempt must increment its classified cause once",
    );
    failed.close().await.unwrap();

    assert_eq!(
        send(FAILED_TASK_ID, FAILED_SUBTASK_ID, "error", error).await,
        200
    );
    assert_eq!(
        scrape_chat_metrics(&client, &metrics_url).await,
        failed_after,
        "a duplicate terminal callback must not increment metrics",
    );

    stop.send(()).unwrap();
    server.await.unwrap();
}

async fn seed(fixture: &Fixture) {
    let mysql = &fixture.mysql;
    for task_id in [TASK_ID, FAILED_TASK_ID] {
        http_e2e::seed_task(mysql, "tasks", task_id, USER_ID).await;
    }
    fixture
        .seed_running_subtask(TASK_ID, SUBTASK_ID, USER_ID)
        .await;
    mysql
        .execute(
            "INSERT INTO subtasks (id,user_id,task_id,message_id,status,progress)
         VALUES (?,?,?,1,'RUNNING',0)",
            (FAILED_SUBTASK_ID, USER_ID, FAILED_TASK_ID),
        )
        .await
        .unwrap();
    for sql in [
        "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'RUNNING')",
        "UPDATE tasks SET client_origin = 'frontend'",
        "CREATE TABLE tasks_0007 LIKE tasks",
        "CREATE TABLE subtasks_0007 LIKE subtasks",
        "INSERT INTO tasks_0007 SELECT * FROM tasks",
        "INSERT INTO subtasks_0007 SELECT * FROM subtasks",
        "UPDATE tasks SET user_id = user_id + 1",
    ] {
        mysql.execute(sql, ()).await.unwrap();
    }
}

async fn assert_terminal(
    mysql: &MysqlService,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: &Value,
    error: Option<&str>,
) {
    let task: Json<Value> = mysql
        .fetch_one("SELECT json FROM tasks_0007 WHERE id = ?", (task_id,))
        .await
        .unwrap();
    let (actual, stored, stored_error): (String, Json<Value>, Option<String>) = mysql
        .fetch_one(
            "SELECT status, result, error_message FROM subtasks_0007 WHERE id = ?",
            (subtask_id,),
        )
        .await
        .unwrap();
    assert_eq!(task.0["status"]["status"], status);
    assert_eq!(actual, status);
    assert_eq!(&stored.0, result);
    assert_eq!(stored_error.as_deref(), error);
    let marker = format!("terminal-delivery-callback-{subtask_id}");
    assert!(
        task.0["metadata"]["labels"].get(&marker).is_none(),
        "callback acknowledges the shard's delivery marker"
    );
    let base_task: Json<Value> = mysql
        .fetch_one("SELECT json FROM tasks WHERE id = ?", (task_id,))
        .await
        .unwrap();
    let base_subtask: (String, Option<Json<Value>>) = mysql
        .fetch_one(
            "SELECT status, result FROM subtasks WHERE id = ?",
            (subtask_id,),
        )
        .await
        .unwrap();
    assert_eq!(base_task.0["status"]["status"], "RUNNING");
    assert_eq!(base_subtask.0, "RUNNING");
    assert!(base_subtask.1.is_none());
}

async fn verify_recovery_readback(redis: &RedisService) {
    let member = format!("{TASK_ID}:{SUBTASK_ID}");
    let stale = json!({"type": "error", "task_id": TASK_ID, "subtask_id": SUBTASK_ID,
        "error": "stale dispatch failure", "error_code": "EXECUTOR_DISPATCH_FAILED"});
    let _: i64 = redis
        .eval(
            "redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
         return redis.call('ZADD', KEYS[1], 0, ARGV[1])",
            [PENDING, EVENTS],
            [member.as_str(), &stale.to_string()],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        let mut poll = tokio::time::interval(Duration::from_millis(100));
        loop {
            poll.tick().await;
            if redis
                .hget::<_, _, String>(EVENTS, member.as_str())
                .await
                .unwrap()
                .is_none()
            {
                break;
            }
        }
    })
    .await
    .expect("recovery must retire a stale event after reading the migrated winner");
    let remaining: i64 = redis
        .eval(
            "return redis.call('ZSCORE', KEYS[1], ARGV[1]) and 1 or 0",
            [PENDING],
            [member.as_str()],
        )
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

async fn scrape_chat_metrics(client: &brz_http::Client, metrics_url: &str) -> String {
    let response = client.get(metrics_url).unwrap().send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    body.lines()
        .filter(|line| {
            line.starts_with("# HELP wegent_chat_")
                || line.starts_with("# TYPE wegent_chat_")
                || line.starts_with("wegent_chat_")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn chat_counter(metrics: &str, series: &str) -> Option<u64> {
    let prefix = format!("{series} ");
    metrics
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .and_then(|value| value.parse().ok())
}

fn assert_chat_counter_incremented(before: &str, after: &str, series: &str, message: &str) {
    let before = chat_counter(before, series).unwrap_or_default();
    let after =
        chat_counter(after, series).unwrap_or_else(|| panic!("{message}: missing {series}"));
    assert_eq!(after, before + 1, "{message}");
}
