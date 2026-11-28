// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL and Redis coverage for terminal callback delivery and cancellation.

use std::{sync::Arc, time::Duration};

use brz_mysql::{FromMysqlRow, MysqlService, MysqlServiceOptions};
use brz_redis::Redis;
use wegent_execution_runtime::stream_state;

use crate::internal_callback::completion::task_column;
use crate::sql_test_support::mysql_rows::{MysqlRows, Value as MysqlValue};

pub(super) async fn verify_terminal_callbacks(writer: &MysqlService) -> anyhow::Result<()> {
    use brz_redis::{RedisService, RedisServiceOptions};

    let address = std::env::var("WEGENT_TEST_REDIS_ADDRESS")?;
    anyhow::ensure!(address.starts_with("127.0.0.1:"));
    let redis = RedisService::noshard_with_options(
        address.clone(),
        [address],
        RedisServiceOptions::default(),
    )
    .await?;
    let mut app = crate::app_test_support::app(writer.clone());
    std::sync::Arc::get_mut(&mut app).unwrap().redis = Some(redis);

    verify_device_dispatch_persists_failure_without_redis(writer).await?;
    verify_subscription_cancel_lifecycle(writer, &app).await?;
    verify_cancel_access_and_device_routing(writer, &app).await?;
    verify_live_chat_cancel_preserves_registration(writer, &app).await?;
    verify_non_chat_cancel_liveness(writer, &app).await?;
    verify_chat_cancel_waits_for_runtime_then_falls_back(writer, &app).await?;
    verify_cancel_callback_order(writer, &app).await?;
    verify_online_device_cannot_dispatch_a_terminal_turn(writer, &app).await?;
    verify_device_dispatch_terminal_race(writer, &app).await?;
    verify_device_dispatch_retries_failed_terminal_read(writer, &app).await?;
    verify_device_dispatch_retries_failed_recovery_index(writer, &app).await?;
    verify_terminal_callback_retry(writer, &app).await
}

async fn verify_subscription_cancel_lifecycle(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    for (active, namespace, expected) in [
        (0, "default", "RUNNING"),
        (-1, "default", "RUNNING"),
        (3, "default", "RUNNING"),
        (2, "system", "RUNNING"),
        (2, "default", "CANCELLED"),
    ] {
        reset_callback_state(writer, "RUNNING").await?;
        writer
            .execute(
                "UPDATE tasks SET is_active = ?, namespace = ? WHERE id = 12",
                (active, namespace),
            )
            .await?;
        cancel_as(app, 999, serde_json::json!({"subtask_id": 43})).await?;
        assert_eq!(
            callback_statuses(writer).await?,
            ("RUNNING".into(), "RUNNING".into())
        );
        cancel_as(
            app,
            7,
            serde_json::json!({"subtask_id": 43, "shell_type": "Codex"}),
        )
        .await?;
        assert_eq!(
            callback_statuses(writer).await?,
            (expected.into(), expected.into()),
            "cancel state={active} namespace={namespace}"
        );
    }
    terminal_callback(app, "done", "late subscription result")
        .await
        .expect("late callback after subscription cancellation");
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    writer
        .execute("UPDATE tasks SET is_active = 1 WHERE id = 12", ())
        .await?;
    Ok(())
}

async fn verify_device_dispatch_persists_failure_without_redis(
    writer: &MysqlService,
) -> anyhow::Result<()> {
    reset_callback_state(writer, "PENDING").await?;
    writer
        .execute("UPDATE subtasks SET status = 'PENDING' WHERE id = 43", ())
        .await?;
    let app = crate::app_test_support::app(writer.clone());
    let mut request = crate::responses::create::dispatch::ExecutionRequest {
        task_id: 12,
        subtask_id: 43,
        user_id: 7,
        ..Default::default()
    };
    let failure = crate::responses::create::seam::dispatch_responses_device(
        &app,
        &mut request,
        "offline-test-device",
        false,
    )
    .await
    .expect_err("device submission requires Redis");
    assert_eq!(failure.status(), http::StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        callback_statuses(writer).await?,
        ("FAILED".into(), "FAILED".into())
    );
    Ok(())
}

async fn dispatch_to_offline_device(app: &crate::state::AppState, retry_index_write: bool) {
    let mut request = crate::responses::create::dispatch::ExecutionRequest {
        task_id: 12,
        subtask_id: 43,
        user_id: 7,
        ..Default::default()
    };
    let error = crate::responses::create::seam::dispatch_responses_device(
        app,
        &mut request,
        "offline-test-device",
        retry_index_write,
    )
    .await
    .expect_err("the fixture has no online device");
    assert_eq!(error.detail_message(), Some("Selected device is offline"));
}

/// A device dispatch that loses the PENDING/RUNNING transition race must
/// publish the already committed terminal outcome instead of waiting forever.
async fn verify_device_dispatch_terminal_race(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    let redis = app.redis.as_ref().expect("Redis fixture");
    for (kind, status) in [
        ("done", "COMPLETED"),
        ("error", "FAILED"),
        ("cancelled", "CANCELLED"),
    ] {
        reset_callback_state(writer, "RUNNING").await?;
        terminal_callback(app, kind, "committed outcome")
            .await
            .unwrap();
        assert_eq!(
            callback_statuses(writer).await?,
            (status.into(), status.into())
        );

        // No producer will publish again. The current subscription must still
        // receive the committed terminal even when the delivery idempotency
        // marker was written by the original callback.
        let mut subscription = redis.subscribe("callback:channel:43").await?;
        dispatch_to_offline_device(app, false).await;
        let message = tokio::time::timeout(Duration::from_secs(2), subscription.next_message())
            .await??
            .expect("replayed terminal callback");
        let event: serde_json::Value = serde_json::from_slice(&message.payload)?;
        assert_eq!(event["type"], kind);
        if kind == "error" {
            assert_eq!(event["error"], "committed outcome");
        }
        subscription.unsubscribe().await?;
    }

    reset_callback_state(writer, "RUNNING").await?;
    assert!(
        crate::socketio::chat_control::mark_cancelling(app, 12, 43)
            .await
            .unwrap()
    );
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLING".into(), "RUNNING".into())
    );

    dispatch_to_offline_device(app, false).await;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );

    // A cancellation committed on the writer must win even when the configured
    // task-store read still sees the previous running state on its replica.
    reset_callback_state(writer, "RUNNING").await?;
    assert!(
        crate::socketio::chat_control::mark_cancelling(app, 12, 43)
            .await
            .unwrap()
    );
    #[derive(FromMysqlRow)]
    struct Schema {
        name: String,
    }
    let schema: Schema = writer.fetch_one("SELECT DATABASE() AS name", ()).await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    let replica = MysqlRows::start_results(|sql| {
        if sql.starts_with("SELECT id, user_id, kind, name, namespace, json, is_active") {
            let task = vec![
                ("id", MysqlValue::I64(12)),
                ("user_id", MysqlValue::I32(7)),
                ("kind", MysqlValue::Text("Task".into())),
                ("name", MysqlValue::Text("lag-test".into())),
                ("namespace", MysqlValue::Text("default".into())),
                (
                    "json",
                    MysqlValue::Text(
                        serde_json::json!({"status": {"status": "RUNNING"}}).to_string(),
                    ),
                ),
                ("is_active", MysqlValue::I8(1)),
            ];
            (task.clone(), vec![task])
        } else {
            (vec![("id", MysqlValue::I64(43))], vec![])
        }
    })
    .await;
    let lagging = MysqlService::connect_lazy_read_write_named_with_options(
        &format!("mysql://root@{address}/{}?ssl-mode=disabled", schema.name),
        &replica.url,
        "device-terminal-cancel-race",
        MysqlServiceOptions::default()
            .with_query_timeout(Duration::from_secs(5))
            .with_acquire_timeout(Duration::from_secs(5)),
    )?;
    let mut lagging_app = crate::app_test_support::app(lagging.clone());
    Arc::get_mut(&mut lagging_app)
        .expect("unique lagging app")
        .redis = app.redis.clone();
    lagging_app
        .completion_app
        .set(Arc::downgrade(&lagging_app))
        .ok();

    let replica_task = lagging_app
        .task_store
        .get_task(12)
        .await?
        .expect("stale task");
    let replica_payload = task_column::<brz_mysql::Json<serde_json::Value>>(&replica_task, "json")
        .expect("replica task payload");
    assert_eq!(replica_payload.0["status"]["status"], "RUNNING");

    let mut subscription = redis.subscribe("callback:channel:43").await?;
    dispatch_to_offline_device(&lagging_app, false).await;
    let message = tokio::time::timeout(Duration::from_secs(2), subscription.next_message())
        .await??
        .expect("replayed cancellation callback");
    let event: serde_json::Value = serde_json::from_slice(&message.payload)?;
    assert_eq!(event["type"], "cancelled");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), subscription.next_message())
            .await
            .is_err(),
        "the cancellation terminal callback must be replayed exactly once"
    );
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    subscription.unsubscribe().await?;
    lagging.close().await;

    terminal_callback(app, "done", "late outcome")
        .await
        .unwrap();
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    Ok(())
}

async fn verify_online_device_cannot_dispatch_a_terminal_turn(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    use serde_json::json;

    const DEVICE_ROUTE: &str = "online-terminal-test";
    let redis = app.redis.as_ref().expect("Redis fixture");
    writer
        .execute(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) \
             VALUES (7, 'Device', ?, 'default', ?, 1, NOW(), NOW())",
            (
                DEVICE_ROUTE,
                brz_mysql::Json(json!({"spec": {"deviceType": "local", "deviceId": DEVICE_ROUTE}})),
            ),
        )
        .await?;
    let online_key = crate::device_online_state::online_key(7, DEVICE_ROUTE);
    redis
        .set_ex(&online_key, 30, r#"{"socket_id":"test-socket"}"#)
        .await?;
    reset_callback_state(writer, "RUNNING").await?;
    terminal_callback(app, "done", "committed before submission")
        .await
        .unwrap();

    let mut callback = redis.subscribe("callback:channel:43").await?;
    let mut socketio = redis
        .subscribe(crate::socketio_emit::SOCKETIO_CHANNEL)
        .await?;
    let mut request = crate::responses::create::dispatch::ExecutionRequest {
        task_id: 12,
        subtask_id: 43,
        user_id: 7,
        ..Default::default()
    };
    let error = crate::responses::create::seam::dispatch_responses_device(
        app,
        &mut request,
        DEVICE_ROUTE,
        false,
    )
    .await
    .expect_err("the RUNNING guard must reject the completed assistant");
    assert_eq!(error.status(), http::StatusCode::CONFLICT);

    let message = tokio::time::timeout(Duration::from_secs(2), callback.next_message())
        .await??
        .expect("replayed terminal callback");
    let event: serde_json::Value = serde_json::from_slice(&message.payload)?;
    assert_eq!(event["type"], "done");
    assert_eq!(event["result"]["value"], "committed before submission");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), socketio.next_message())
            .await
            .is_err(),
        "a rejected RUNNING transition must not start the device turn"
    );
    callback.unsubscribe().await?;
    socketio.unsubscribe().await?;
    redis.del(online_key).await?;
    Ok(())
}

async fn verify_device_dispatch_retries_failed_terminal_read(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    reset_callback_state(writer, "RUNNING").await?;
    terminal_callback(app, "done", "committed before the read failed")
        .await
        .unwrap();
    let redis = app.redis.as_ref().expect("Redis fixture");
    let mut subscription = redis.subscribe("callback:channel:43").await?;
    // Force the writer's terminal projection to fail, while the offline
    // submission check can still read the users and devices tables.
    writer
        .execute(
            "ALTER TABLE subtasks RENAME COLUMN error_message TO unavailable_error_message",
            (),
        )
        .await?;
    dispatch_to_offline_device(app, false).await;
    writer
        .execute(
            "ALTER TABLE subtasks RENAME COLUMN unavailable_error_message TO error_message",
            (),
        )
        .await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), subscription.next_message())
            .await
            .is_err(),
        "a failed writer read must not publish a synthetic failure"
    );

    crate::internal_callback::recovery::retry_device_dispatch(app, 12, 43).await?;
    let message = tokio::time::timeout(Duration::from_secs(2), subscription.next_message())
        .await??
        .expect("terminal recovery replays the committed callback");
    let event: serde_json::Value = serde_json::from_slice(&message.payload)?;
    assert_eq!(event["type"], "done");
    assert_eq!(event["result"]["value"], "committed before the read failed");
    assert_eq!(
        callback_statuses(writer).await?,
        ("COMPLETED".into(), "COMPLETED".into())
    );

    crate::internal_callback::recovery::retry_device_dispatch(app, 12, 43).await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), subscription.next_message())
            .await
            .is_err(),
        "successful recovery retires the pending device dispatch"
    );
    subscription.unsubscribe().await?;
    Ok(())
}

async fn verify_device_dispatch_retries_failed_recovery_index(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    use crate::internal_callback::recovery::{EVENTS, QUEUE, device_dispatch_member};

    reset_callback_state(writer, "RUNNING").await?;
    let redis = app.redis.as_ref().expect("Redis fixture");
    let mut subscription = redis.subscribe("callback:channel:43").await?;
    // ZADD succeeds, but the payload write fails with WRONGTYPE.
    redis.set(EVENTS, "temporarily unavailable").await?;
    let member = device_dispatch_member(12, 43);
    let wait_for_index_attempt = async {
        loop {
            let indexed: i64 = redis
                .eval(
                    "return redis.call('ZSCORE', KEYS[1], ARGV[1]) and 1 or 0",
                    [QUEUE],
                    [&member],
                )
                .await?;
            if indexed == 1 {
                return Ok::<_, brz_redis::RedisError>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let dispatch = dispatch_to_offline_device(app, true);
    tokio::pin!(dispatch);
    tokio::select! {
        biased;
        () = &mut dispatch => panic!("the admitted dispatch lost its failure before recovery accepted it"),
        attempted = tokio::time::timeout(Duration::from_secs(2), wait_for_index_attempt) => attempted??,
    }
    assert!(
        crate::socketio::chat_control::mark_cancelling(app, 12, 43)
            .await
            .unwrap()
    );
    redis.del(EVENTS).await?;
    tokio::time::timeout(Duration::from_secs(8), dispatch).await?;
    let message = tokio::time::timeout(Duration::from_secs(2), subscription.next_message())
        .await??
        .expect("recovery delivers the terminal callback");
    let event: serde_json::Value = serde_json::from_slice(&message.payload)?;
    assert_eq!(event["type"], "cancelled");
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    subscription.unsubscribe().await?;
    Ok(())
}

async fn reset_callback_state(writer: &MysqlService, parent_status: &str) -> anyhow::Result<()> {
    writer
        .execute(
            "UPDATE tasks SET json = JSON_OBJECT('status', JSON_OBJECT('status', ?)) WHERE id = 12",
            (parent_status,),
        )
        .await?;
    writer.execute(
        "UPDATE subtasks SET status = 'RUNNING', result = NULL, error_message = '' WHERE id = 43",
        (),
    ).await?;
    Ok(())
}

async fn configure_callback_pipeline(writer: &MysqlService) -> anyhow::Result<()> {
    use serde_json::json;

    let team = json!({"spec": {"collaborationModel": "pipeline", "members": [
        {"botRef": {"name": "first-bot", "namespace": "default"}},
        {"botRef": {"name": "second-bot", "namespace": "default"}}
    ]}});
    writer.execute(
        "INSERT INTO kinds (id, user_id, kind, name, namespace, json, is_active, created_at, updated_at) VALUES \
         (9, 7, 'Team', 'cancel-pipeline', 'default', ?, 1, NOW(), NOW()), \
         (10, 7, 'Bot', 'first-bot', 'default', '{}', 1, NOW(), NOW())",
        (team.to_string(),),
    ).await?;
    writer.execute(
        "UPDATE tasks SET json = JSON_SET(json, '$.spec', JSON_OBJECT('currentStage', 0, \
         'teamRef', JSON_OBJECT('user_id', 7, 'name', 'cancel-pipeline', 'namespace', 'default'))) WHERE id = 12",
        (),
    ).await?;
    writer
        .execute("UPDATE subtasks SET bot_ids = '[10]' WHERE id = 43", ())
        .await?;
    Ok(())
}

async fn terminal_callback(
    app: &crate::state::AppState,
    kind: &str,
    value: &str,
) -> Result<(), crate::http_compat::FastApiError> {
    let (event_type, data) = match kind {
        "done" => (
            "response.completed",
            serde_json::json!({
                "response": {
                    "output": [{"content": [{"type": "output_text", "text": value}]}],
                    "standalone_chat_workspace_path": "/workspace/replayed",
                },
            }),
        ),
        "error" => (
            "error",
            serde_json::json!({"message": value, "code": "execution_error"}),
        ),
        "cancelled" => ("response.incomplete", serde_json::json!({})),
        _ => unreachable!(),
    };
    crate::internal_callback::handle_callback(
        app,
        crate::internal_auth::InternalService,
        serde_json::json!({
            "task_id": 12,
            "subtask_id": 43,
            "event_type": event_type,
            "data": data,
        }),
    )
    .await
    .map(|_| ())
}

async fn callback_statuses(writer: &MysqlService) -> anyhow::Result<(String, String)> {
    let task: brz_mysql::Json<serde_json::Value> = writer
        .fetch_one("SELECT json FROM tasks WHERE id = 12", ())
        .await?;
    let subtask = writer
        .fetch_one("SELECT status FROM subtasks WHERE id = 43", ())
        .await?;
    Ok((
        task.0["status"]["status"].as_str().unwrap().to_owned(),
        subtask,
    ))
}

async fn verify_cancel_callback_order(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    for (first, second, status) in [
        ("done", "cancelled", "COMPLETED"),
        ("error", "cancelled", "FAILED"),
        ("cancelled", "done", "CANCELLED"),
        ("cancelled", "error", "CANCELLED"),
    ] {
        reset_callback_state(writer, "RUNNING").await?;
        if first == "done" {
            configure_callback_pipeline(writer).await?;
        }
        assert!(
            crate::socketio::chat_control::mark_cancelling(app, 12, 43)
                .await
                .unwrap()
        );
        assert_eq!(
            callback_statuses(writer).await?,
            ("CANCELLING".into(), "RUNNING".into())
        );
        terminal_callback(app, first, "first outcome")
            .await
            .unwrap();
        let expected = (status.to_owned(), status.to_owned());
        assert_eq!(callback_statuses(writer).await?, expected);
        let count: i64 = writer
            .fetch_one("SELECT COUNT(*) FROM subtasks WHERE task_id = 12", ())
            .await?;
        assert_eq!(count, 2, "a cancelled pipeline must not advance");
        let before: Option<brz_mysql::Json<serde_json::Value>> = writer
            .fetch_one("SELECT result FROM subtasks WHERE id = 43", ())
            .await?;
        terminal_callback(app, second, "late outcome")
            .await
            .unwrap();
        assert_eq!(callback_statuses(writer).await?, expected);
        assert!(
            !crate::socketio::chat_control::mark_cancelling(app, 12, 43)
                .await
                .unwrap()
        );
        assert_eq!(callback_statuses(writer).await?, expected);
        let after: Option<brz_mysql::Json<serde_json::Value>> = writer
            .fetch_one("SELECT result FROM subtasks WHERE id = 43", ())
            .await?;
        assert_eq!(before.map(|json| json.0), after.map(|json| json.0));
    }
    Ok(())
}

async fn verify_chat_cancel_waits_for_runtime_then_falls_back(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    reset_callback_state(writer, "RUNNING").await?;
    writer
        .execute("UPDATE tasks SET json = JSON_OBJECT('status', JSON_OBJECT('status', 'RUNNING')) WHERE id = 12", ())
        .await?;
    crate::internal_callback::session::add_text_content(
        app.redis.as_ref().expect("Redis fixture"),
        43,
        "server partial cancel result",
    )
    .await?;
    cancel_as(
        app,
        7,
        serde_json::json!({"subtask_id": 43, "shell_type": "Chat", "partial_content": "stale client result"}),
    )
    .await?;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    let result: brz_mysql::Json<serde_json::Value> = writer
        .fetch_one("SELECT result FROM subtasks WHERE id = 43", ())
        .await?;
    assert_eq!(
        result.0["value"].as_str().unwrap_or_default(),
        "server partial cancel result"
    );
    let cancel_key = stream_state::cancel_key(43);
    let intent_key = "chat:cancel-intent:43".to_string();
    let redis = app.redis.as_ref().expect("Redis fixture");
    let streaming_left = redis.get::<_, String>("chat:streaming:43").await;
    let cancel_left = redis.get::<_, String>(cancel_key.as_str()).await;
    let intent_left = redis.get::<_, String>(intent_key.as_str()).await;
    assert!(
        streaming_left.unwrap().is_none()
            && cancel_left.unwrap().is_none()
            && intent_left.unwrap().is_none()
    );

    terminal_callback(app, "done", "late outcome")
        .await
        .unwrap();
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    Ok(())
}

async fn cancel_as(
    app: &crate::state::AppState,
    user_id: i64,
    data: serde_json::Value,
) -> anyhow::Result<()> {
    use base64::Engine as _;

    let runtime = std::sync::Arc::new(crate::socketio::runtime::SocketRuntime::new().0);
    let server = crate::socketio::handlers::build_test_server()
        .await
        .map_err(|error| anyhow::anyhow!("build test Socket.IO server: {error}"))?;
    runtime.install_emitters(std::sync::Arc::new(
        crate::socketio::runtime::SocketEmitters::for_test(&server)
            .map_err(|error| anyhow::anyhow!("build test Socket.IO emitters: {error}"))?,
    ));
    let identity = crate::socketio::auth::Identity {
        user_id,
        user_name: String::new(),
        auth_type: "jwt",
        email: None,
    };
    let claims =
        serde_json::json!({"sub": "cancel-owner", "exp": chrono::Utc::now().timestamp() + 300});
    let payload =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
    let token = format!("header.{payload}.signature");
    let session = crate::socketio::chat_session::ChatSession::new(&identity, Some(&token), None);
    crate::socketio::chat_control::cancel(app, &runtime, &session, "test-socket", data).await?;
    Ok(())
}

async fn verify_cancel_access_and_device_routing(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    use serde_json::json;

    let redis = app.redis.as_ref().expect("Redis fixture");
    for (shell, executor) in [
        ("Chat", None),
        ("Codex", None),
        ("Chat", Some("device-test")),
    ] {
        reset_callback_state(writer, "RUNNING").await?;
        writer
            .execute(
                "UPDATE subtasks SET executor_name = ? WHERE id = 43",
                (executor,),
            )
            .await?;
        cancel_as(app, 999, json!({"subtask_id":43, "shell_type":shell})).await?;
        assert_eq!(
            callback_statuses(writer).await?,
            ("RUNNING".into(), "RUNNING".into())
        );
        for key in ["chat:cancel:43", "chat:cancel-intent:43"] {
            assert!(redis.get::<_, String>(key).await?.is_none());
        }
    }
    // An omitted shell still routes to the device without a Chat grace timeout.
    crate::internal_callback::session::set_task_streaming_status(redis, 12, 43, 7, "owner").await?;
    cancel_as(app, 7, json!({"subtask_id":43})).await?;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLING".into(), "RUNNING".into())
    );
    crate::internal_callback::session::clear_task_streaming_status(redis, 12).await?;
    cancel_as(app, 7, json!({"subtask_id":43})).await?;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    writer
        .execute("UPDATE subtasks SET executor_name = NULL WHERE id = 43", ())
        .await?;
    Ok(())
}

async fn verify_live_chat_cancel_preserves_registration(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    reset_callback_state(writer, "RUNNING").await?;
    let redis = app.redis.as_ref().expect("Redis fixture");
    let consumer = async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while redis.get::<_, String>("chat:cancel:43").await?.is_none() {
                tokio::task::yield_now().await;
            }
            anyhow::Ok(())
        })
        .await??;
        stream_state::register_stream(Some(redis), 43).await;
        assert_eq!(
            redis.get::<_, String>("chat:cancel:43").await?,
            Some("true".into())
        );
        terminal_callback(app, "cancelled", "")
            .await
            .expect("consumer terminal callback");
        stream_state::unregister_stream(Some(redis), 43).await;
        anyhow::Ok(())
    };
    let (request, consumer) = tokio::join!(
        cancel_as(
            app,
            7,
            serde_json::json!({"subtask_id":43, "shell_type":"Chat"})
        ),
        consumer,
    );
    request?;
    consumer?;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    Ok(())
}

async fn verify_non_chat_cancel_liveness(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    let redis = app.redis.as_ref().expect("Redis fixture");
    reset_callback_state(writer, "RUNNING").await?;
    crate::internal_callback::session::set_task_streaming_status(redis, 12, 43, 7, "owner").await?;
    cancel_as(
        app,
        7,
        serde_json::json!({"subtask_id":43, "shell_type":"Codex"}),
    )
    .await?;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLING".into(), "RUNNING".into())
    );
    crate::internal_callback::session::clear_task_streaming_status(redis, 12).await?;
    cancel_as(
        app,
        7,
        serde_json::json!({"subtask_id":43, "shell_type":"Codex"}),
    )
    .await?;
    assert_eq!(
        callback_statuses(writer).await?,
        ("CANCELLED".into(), "CANCELLED".into())
    );
    Ok(())
}

async fn verify_terminal_callback_retry(
    writer: &MysqlService,
    app: &crate::state::AppState,
) -> anyhow::Result<()> {
    reset_callback_state(writer, "RUNNING").await?;
    writer
        .execute(
            "CREATE TRIGGER reject_terminal_status BEFORE UPDATE ON tasks FOR EACH ROW \
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reject parent callback write'",
            (),
        )
        .await?;
    let error = terminal_callback(app, "done", "replay result")
        .await
        .unwrap_err();
    assert_eq!(error.status(), http::StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        callback_statuses(writer).await?,
        ("RUNNING".into(), "RUNNING".into())
    );
    writer
        .execute("DROP TRIGGER reject_terminal_status", ())
        .await?;

    terminal_callback(app, "done", "replay result")
        .await
        .unwrap();
    assert_eq!(
        callback_statuses(writer).await?,
        ("COMPLETED".into(), "COMPLETED".into())
    );
    terminal_callback(app, "error", "stale failure")
        .await
        .unwrap();
    assert_eq!(
        callback_statuses(writer).await?,
        ("COMPLETED".into(), "COMPLETED".into())
    );
    let result: brz_mysql::Json<serde_json::Value> = writer
        .fetch_one("SELECT result FROM subtasks WHERE id = 43", ())
        .await?;
    assert_eq!(result.0["value"], "replay result");
    let task: brz_mysql::Json<serde_json::Value> = writer
        .fetch_one("SELECT json FROM tasks WHERE id = 12", ())
        .await?;
    assert_eq!(task.0["status"]["result"]["value"], "replay result");
    assert_eq!(
        task.0["spec"]["standaloneChatWorkspacePath"],
        "/workspace/replayed"
    );
    Ok(())
}
