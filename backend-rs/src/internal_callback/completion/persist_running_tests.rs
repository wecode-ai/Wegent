// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused test for the RUNNING transition's read-before-update.
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

use brz_mysql::{MysqlResult, MysqlRouteKey, MysqlRouteOutput, MysqlRouting};
use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, Redis, RedisResult, RedisValues};

use super::{mark_subtask_running, running_transition_statements};
use crate::internal_callback::completion::{Completion, Tables};
use crate::sql_test_support::mysql_pool_server;

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

/// The read below fails before any metrics publish, so Redis is never touched.
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
        read_subtask.contains("WHERE {{subtasks}}.id = ? LIMIT 1"),
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

/// The RUNNING transition's first statement is the subtask read by primary key
/// against the routed shard table, with the ORM's labeled full projection and
/// `LIMIT 1`. The prepared statement reaches the server before any status
/// flush, which is the position the recording shows.
#[tokio::test]
async fn the_running_transition_reads_the_subtask_from_its_shard_first() {
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
        mark_subtask_running(&ctx, 801_406_538_674_542).await;

        stop.send(()).unwrap();
        let queries = server.await.unwrap();
        mysql.close().await;

        let read = queries.first().expect("the subtask read is issued");
        assert!(
            read.contains("FROM `subtasks_0711`"),
            "the read targets the routed shard table: {read}"
        );
        assert!(
            read.contains("`subtasks_0711`.id AS `subtasks_0711_id`"),
            "the read keeps the ORM's labeled projection: {read}"
        );
        assert!(
            read.contains("WHERE `subtasks_0711`.id = ?") && read.trim_end().ends_with("LIMIT 1"),
            "the read keeps the by-id predicate and LIMIT 1: {read}"
        );
    })
    .await
    .expect("the RUNNING read should be prepared within the test timeout");
}
