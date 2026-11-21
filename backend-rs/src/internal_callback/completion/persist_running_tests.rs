// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the writer transaction that prepares a subtask for dispatch.
//!
//! `ExecutionDispatcher._update_subtask_to_running` ->
//! `db_handler.update_subtask_status` -> `_update_subtask_sync` reads the
//! assistant subtask (and eager-loads its contexts) before the status flush
//! (`app/services/execution/dispatcher.py:347`,
//! `app/services/chat/storage/db.py:130`). The recorded create case issues that
//! read as `SELECT ... FROM subtasks_0711 WHERE subtasks_0711.id = ? LIMIT 1`
//! followed by `SELECT ... FROM subtask_contexts WHERE subtask_id IN (?)
//! ORDER BY id ASC`, then the `status='RUNNING'` update.
use std::{sync::Arc, time::Duration};

use brz_mysql::{
    FromMysqlRow, MysqlResult, MysqlRouteKey, MysqlRouteOutput, MysqlRouting, MysqlService,
    MysqlServiceOptions,
};
use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, Redis, RedisResult, RedisValues};

use super::{commit_subtask_running, mark_subtask_running, running_transition_statements};
use crate::internal_callback::completion::{Completion, Tables};
use crate::sql_test_support::mysql_pool_server;
use crate::sql_test_support::mysql_rows::{MysqlRows, Value as MysqlValue};

/// Deployment shard policy for the test: every `{{subtasks}}` template renders
/// the recorded physical table. The production policy lives in the internal
/// crate; here only the rendering matters.
struct RecordedShard;

impl MysqlRouting for RecordedShard {
    fn resolve<'a>(
        &'a self,
        template: &'a str,
        _key: &'a dyn MysqlRouteKey,
    ) -> MysqlResult<impl MysqlRouteOutput + 'a> {
        Ok(match template {
            "subtasks" => "subtasks_0711".to_string(),
            "tasks" => "tasks_0711".to_string(),
            other => other.to_string(),
        })
    }
}

/// These tests do not need a Redis server.
struct NoRedis;

impl Redis for NoRedis {
    async fn get<K, R>(&self, _: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }

    async fn set<K, V>(&self, _: K, _: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }

    async fn mget<K, R>(&self, _: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }

    async fn del_many<K>(&self, _: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }

    async fn pfcount<K>(&self, _: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }

    async fn hget<K, F, R>(&self, _: K, _: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }

    async fn hmget<K, F, R>(&self, _: K, _: F) -> RedisResult<RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the RUNNING read reaches no Redis command")
    }
}

fn tables() -> Tables {
    Tables {
        tasks: "{{tasks}}",
        subtasks: "{{subtasks}}",
    }
}

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The recorded transition is read subtask -> read its contexts -> status
/// flush. `subtask_store.get_by_id` reads the ORM entity (labeled projection,
/// `LIMIT 1`); the eager `contexts` load reads `subtask_contexts` by subtask
/// id in ascending id order; `update_fields` then writes the status.
#[test]
fn the_running_transition_statements_keep_the_recorded_order_and_predicates() {
    let [read_subtask, read_contexts, update_running] = running_transition_statements(tables());

    let read_subtask = normalize(&read_subtask);
    assert!(
        read_subtask.contains(
            "{{subtasks}}.id AS {{subtasks}}_id, {{subtasks}}.user_id AS {{subtasks}}_user_id"
        ),
        "{}",
        read_subtask
    );
    assert!(
        read_subtask.contains("WHERE {{subtasks}}.id = ? LIMIT 1 FOR UPDATE"),
        "{}",
        read_subtask
    );

    let read_contexts = normalize(&read_contexts);
    assert!(
        read_contexts.contains("FROM subtask_contexts WHERE subtask_contexts.subtask_id IN (?)"),
        "{}",
        read_contexts
    );
    assert!(
        read_contexts.ends_with("ORDER BY subtask_contexts.id ASC"),
        "{}",
        read_contexts
    );

    let update_running = normalize(&update_running);
    assert_eq!(
        update_running,
        "UPDATE {{subtasks}} SET status=?, updated_at=? WHERE {{subtasks}}.id = ?"
    );
}

/// The writer must lock the parent Task on the routed shard before reading
/// the assistant subtask or attempting a status update.
#[tokio::test]
async fn the_running_transition_locks_the_parent_task_on_its_shard_first() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mysql = crate::connect_mysql(&format!(
            "mysql://test:test@{}/test?ssl-mode=disabled",
            listener.local_addr().unwrap()
        ))
        .unwrap()
        .with_route(RecordedShard);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(mysql_pool_server::capture_queries_until(listener, stopped));

        let redis = NoRedis;
        let manager = crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
            .expect("executor-manager client");
        let ctx = Completion {
            app: None,
            mysql: &mysql,
            redis: &redis,
            tables: tables(),
            executor_manager: &manager,
        };
        // The fake server answers prepared statements with a SQL error, so the
        // read fails and the transition stops before the contexts read and the
        // status write.
        assert!(
            mark_subtask_running(&ctx, 801_406_538_674_541, 801_406_538_674_542, None)
                .await
                .is_err()
        );

        stop.send(()).unwrap();
        let queries = server.await.unwrap();
        mysql.close().await;

        let read = queries.first().expect("the task read is issued");
        assert!(
            read.contains("FROM `tasks_0711`"),
            "the read targets the routed shard table: {read}"
        );
        assert!(
            read.contains("`tasks_0711`.id AS `tasks_0711_id`"),
            "the read keeps the ORM's labeled projection: {read}"
        );
        assert!(
            read.contains("WHERE `tasks_0711`.id = ?")
                && read.trim_end().ends_with("LIMIT 1 FOR UPDATE"),
            "the read locks the selected row: {read}"
        );
    })
    .await
    .expect("the RUNNING read should be prepared within the test timeout");
}

#[tokio::test]
#[ignore = "requires loopback MySQL and Redis; uses an isolated MySQL schema and a lagging reader fixture"]
async fn running_transition_commits_before_dispatch_when_replica_has_no_subtask()
-> anyhow::Result<()> {
    crate::migrations::mysql_tests::isolated(verify_running_transition).await
}

async fn verify_running_transition(writer: &MysqlService) -> anyhow::Result<()> {
    #[derive(FromMysqlRow)]
    struct Schema {
        name: String,
    }
    #[derive(FromMysqlRow)]
    struct Status {
        status: String,
    }

    crate::migrations::upgrade(writer).await?;
    writer
        .execute(
            "INSERT INTO users (id, user_name, password_hash, email, is_active, `role`, \
              auth_source, preferences, git_info, created_at, updated_at) \
             VALUES (7, 'cancel-owner', 'unused', '', 1, 'user', 'password', \
              JSON_OBJECT(), JSON_ARRAY(), NOW(), NOW())",
            (),
        )
        .await?;
    writer
        .execute(
            "INSERT INTO tasks (id, user_id, kind, name, namespace, json, is_active, \
              created_at, updated_at, project_id, client_origin, is_group_chat) \
             VALUES (12, 7, 'Task', 'lag-test', 'default', JSON_OBJECT('status', \
              JSON_OBJECT('status', 'PENDING')), 1, NOW(), NOW(), 0, 'web', 0)",
            (),
        )
        .await?;
    writer
        .execute(
            "INSERT INTO subtasks (id, user_id, task_id, team_id, title, bot_ids, `role`, \
                executor_deleted_at, message_id, status, progress, created_at, updated_at, \
                completed_at, sender_type, sender_user_id, reply_to_subtask_id) \
             VALUES (42, 7, 12, 3, '', '[]', 'ASSISTANT', 0, 42, 'PENDING', 0, NOW(), NOW(), NOW(), 'TEAM', 0, 0), \
                    (43, 7, 12, 3, '', '[]', 'ASSISTANT', 0, 43, 'CANCELLED', 0, NOW(), NOW(), NOW(), 'TEAM', 0, 0)",
            (),
        )
        .await?;
    let schema: Schema = writer.fetch_one("SELECT DATABASE() AS name", ()).await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    let replica = MysqlRows::start_results(|_| {
        (vec![("status", MysqlValue::Text("PENDING".into()))], vec![])
    })
    .await;
    let mysql = MysqlService::connect_lazy_read_write_named_with_options(
        &format!("mysql://root@{address}/{}?ssl-mode=disabled", schema.name),
        &replica.url,
        "running-transition-lag",
        MysqlServiceOptions::default()
            .with_query_timeout(Duration::from_secs(5))
            .with_acquire_timeout(Duration::from_secs(5)),
    )?;
    let status_query = "SELECT status FROM subtasks WHERE id = ?";
    assert!(
        mysql
            .fetch_optional::<_, _, Status>(status_query, (42,))
            .await?
            .is_none()
    );
    let tables = Tables {
        tasks: "tasks",
        subtasks: "subtasks",
    };

    assert!(
        commit_subtask_running(&mysql, tables, tables.tasks, 12, 42, None)
            .await?
            .is_some()
    );
    // A different writer connection can see the committed status as soon as
    // the dispatch prerequisite returns. The reader still has no row.
    let current: Status = writer.fetch_one(status_query, (42,)).await?;
    assert_eq!(current.status, "RUNNING");
    let task_query = "SELECT json FROM tasks WHERE id = 12";
    let current: brz_mysql::Json<serde_json::Value> = writer.fetch_one(task_query, ()).await?;
    assert_eq!(current.0["status"]["status"], "RUNNING");
    assert!(
        mysql
            .fetch_optional::<_, _, Status>(status_query, (42,))
            .await?
            .is_none()
    );
    assert_eq!(replica.queries(), [status_query, status_query]);

    assert!(
        commit_subtask_running(&mysql, tables, tables.tasks, 12, 43, None)
            .await?
            .is_none()
    );
    assert!(
        commit_subtask_running(&mysql, tables, tables.tasks, 12, 44, None)
            .await?
            .is_none()
    );
    let cancelled: Status = writer.fetch_one(status_query, (43,)).await?;
    assert_eq!(cancelled.status, "CANCELLED");

    writer
        .execute("UPDATE subtasks SET status = 'PENDING' WHERE id = 42", ())
        .await?;
    writer
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'PENDING') WHERE id = 12",
            (),
        )
        .await?;
    writer
        .execute(
            "CREATE TRIGGER reject_running_transition BEFORE UPDATE ON tasks FOR EACH ROW \
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rejected by test fixture'",
            (),
        )
        .await?;
    let failure = commit_subtask_running(&mysql, tables, tables.tasks, 12, 42, None)
        .await
        .unwrap_err();
    assert_eq!(failure.database_sql_state(), Some("45000"));
    crate::responses::dispatch::test_dispatch_start_failure(mysql.clone(), 12, 42).await;
    let pending: Status = writer.fetch_one(status_query, (42,)).await?;
    assert_eq!(pending.status, "PENDING");
    let pending: brz_mysql::Json<serde_json::Value> = writer.fetch_one(task_query, ()).await?;
    assert_eq!(pending.0["status"]["status"], "PENDING");
    writer
        .execute("DROP TRIGGER reject_running_transition", ())
        .await?;
    Box::pin(verify_obsolete_dispatches(writer, tables)).await?;
    Box::pin(verify_terminal_callbacks(writer)).await?;
    mysql.close().await;
    Ok(())
}

async fn verify_obsolete_dispatches(writer: &MysqlService, tables: Tables) -> anyhow::Result<()> {
    use serde_json::{Value, json};

    let app = crate::app_test_support::app(writer.clone());
    let binding = crate::executor_binding::BindingRequest {
        executor_name: "wegent-test-executor".into(),
        executor_namespace: String::new(),
    };
    writer
        .execute(
            "UPDATE subtasks SET status = 'RUNNING' WHERE id IN (42, 43)",
            (),
        )
        .await?;
    writer
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'CANCELLED') WHERE id = 12",
            (),
        )
        .await?;
    let rejected = crate::executor_binding::persist_binding(&app, 12, 43, 7, &binding)
        .await
        .unwrap_err();
    assert_eq!(rejected.status(), http::StatusCode::GONE);
    let executor: Option<String> = writer
        .fetch_one("SELECT executor_name FROM subtasks WHERE id = 43", ())
        .await?;
    assert_eq!(executor, None);

    let redis = NoRedis;
    let ctx = Completion {
        app: None,
        mysql: writer,
        redis: &redis,
        tables,
        executor_manager: &app.executor_manager,
    };
    assert!(
        super::persist_completed_result(
            &ctx,
            12,
            43,
            "FAILED",
            None,
            Some("late queue failure"),
            Some("task_queue_failure"),
            None,
            None
        )
        .await?
        .is_none()
    );
    let status: String = writer
        .fetch_one("SELECT status FROM subtasks WHERE id = 43", ())
        .await?;
    assert_eq!(status, "RUNNING");

    writer
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'RUNNING') WHERE id = 12",
            (),
        )
        .await?;
    let rejected = crate::executor_binding::persist_binding(&app, 12, 42, 7, &binding)
        .await
        .unwrap_err();
    assert_eq!(
        rejected.status(),
        http::StatusCode::GONE,
        "a newer turn exists"
    );
    for status in ["COMPLETED", "CANCELLED"] {
        writer.execute(
            "UPDATE subtasks SET status = ?, result = JSON_OBJECT('value', 'original') WHERE id = 43",
            (status,)
        ).await?;
        let rejected = crate::executor_binding::persist_binding(&app, 12, 43, 7, &binding)
            .await
            .unwrap_err();
        assert_eq!(rejected.status(), http::StatusCode::GONE);
        assert!(
            super::persist_completed_result(
                &ctx,
                12,
                43,
                "FAILED",
                Some(&json!({"value": "stale"})),
                Some("late queue failure"),
                Some("task_queue_failure"),
                None,
                None
            )
            .await?
            .is_none()
        );
        let (actual, brz_mysql::Json(result)): (String, brz_mysql::Json<Value>) = writer
            .fetch_one("SELECT status, result FROM subtasks WHERE id = 43", ())
            .await?;
        assert_eq!(actual, status);
        assert_eq!(result, json!({"value": "original"}));
    }
    writer
        .execute("UPDATE subtasks SET status = 'RUNNING' WHERE id = 43", ())
        .await?;
    assert_eq!(
        crate::executor_binding::persist_binding(&app, 12, 43, 7, &binding)
            .await
            .unwrap(),
        json!({"status": "bound"})
    );
    writer
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'CANCELLING') WHERE id = 12",
            (),
        )
        .await?;
    writer
        .execute("UPDATE subtasks SET status = 'CANCELLED' WHERE id = 43", ())
        .await?;
    super::update_task_status(&ctx, 12, 43).await;
    let task: brz_mysql::Json<Value> = writer
        .fetch_one("SELECT json FROM tasks WHERE id = 12", ())
        .await?;
    assert_eq!(task.0["status"]["status"], "CANCELLED");
    Ok(())
}

async fn verify_terminal_callbacks(writer: &MysqlService) -> anyhow::Result<()> {
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

    verify_cancel_access_and_device_routing(writer, &app).await?;
    verify_live_chat_cancel_preserves_registration(writer, &app).await?;
    verify_non_chat_cancel_liveness(writer, &app).await?;
    verify_chat_cancel_waits_for_runtime_then_falls_back(writer, &app).await?;
    verify_cancel_callback_order(writer, &app).await?;
    verify_device_dispatch_terminal_race(writer, &app).await?;
    verify_terminal_callback_retry(writer, &app).await
}

async fn dispatch_to_offline_device(app: &crate::state::AppState) {
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
        dispatch_to_offline_device(app).await;
        let message = tokio::time::timeout(Duration::from_secs(2), subscription.next_message())
            .await??
            .expect("replayed terminal callback");
        let event: serde_json::Value = serde_json::from_slice(&message.payload)?;
        assert_eq!(event["type"], kind);
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

    dispatch_to_offline_device(app).await;
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
        if sql.contains("FROM `tasks`") {
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
    let replica_payload =
        super::super::task_column::<brz_mysql::Json<serde_json::Value>>(&replica_task, "json")
            .expect("replica task payload");
    assert_eq!(replica_payload.0["status"]["status"], "RUNNING");

    let mut subscription = redis.subscribe("callback:channel:43").await?;
    dispatch_to_offline_device(&lagging_app).await;
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
    let cancel_key = crate::socketio::chat_control::cancel_key(43);
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
        crate::responses::stream_state::register_stream(Some(redis), 43).await;
        assert_eq!(
            redis.get::<_, String>("chat:cancel:43").await?,
            Some("true".into())
        );
        terminal_callback(app, "cancelled", "")
            .await
            .expect("consumer terminal callback");
        crate::responses::stream_state::unregister_stream(Some(redis), 43).await;
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
