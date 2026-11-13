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
use std::time::Duration;

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
            mark_subtask_running(&ctx, 801_406_538_674_541, 801_406_538_674_542)
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
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated MySQL schema and a lagging reader fixture"]
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
        MysqlServiceOptions::default().with_query_timeout(Duration::from_secs(5)),
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
        commit_subtask_running(&mysql, tables, 12, 42)
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
        commit_subtask_running(&mysql, tables, 12, 43)
            .await?
            .is_none()
    );
    assert!(
        commit_subtask_running(&mysql, tables, 12, 44)
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
    let failure = commit_subtask_running(&mysql, tables, 12, 42)
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
    verify_obsolete_dispatches(writer, tables).await?;
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
