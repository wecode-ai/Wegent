// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution};
use brz_redis::{
    Cmd, EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult, RedisValues,
    Value, cmd,
};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct LeaseRedis {
    owners: Mutex<HashMap<String, String>>,
    commands: Mutex<Vec<Vec<String>>>,
    fail: bool,
    stall: bool,
    stall_eval: bool,
}

impl LeaseRedis {
    fn run<T: FromRedisValue>(&self, command: Cmd) -> RedisResult<T> {
        if self.fail {
            return Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "unavailable",
            ));
        }
        let args: Vec<String> = (0..)
            .map_while(|index| command.arg_at(index))
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect();
        self.commands.lock().unwrap().push(args.clone());
        let mut owners = self.owners.lock().unwrap();
        let response = match command.name().as_ref() {
            "SET" => match owners.entry(args[1].clone()) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(args[2].clone());
                    Value::SimpleString("OK".to_string())
                }
                std::collections::hash_map::Entry::Occupied(_) => Value::Nil,
            },
            "EVAL" => {
                let matches = owners.get(&args[3]) == Some(&args[4]);
                if matches && args[1] == RELEASE_SCRIPT {
                    owners.remove(&args[3]);
                }
                Value::Int(i64::from(matches))
            }
            name => panic!("unexpected Redis command {name}"),
        };
        T::from_redis_value(&response)
    }
}

impl Redis for LeaseRedis {
    async fn command<T: FromRedisValue + Send>(&self, command: Cmd) -> RedisResult<T> {
        if self.stall {
            std::future::pending::<()>().await;
        }
        self.run(command)
    }

    async fn eval<S, K, A, T>(&self, script: S, keys: K, arguments: A) -> RedisResult<T>
    where
        S: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        T: FromRedisValue + Send,
    {
        if self.stall_eval {
            std::future::pending::<()>().await;
        }
        let mut command = cmd("EVAL");
        command.arg_encoded(script)?.arg_encoded(keys.num_args())?;
        keys.encode_args(&mut command)?;
        arguments.encode_args(&mut command)?;
        self.run(command)
    }

    async fn get<K, T>(&self, _: K) -> RedisResult<Option<T>>
    where
        K: EncodeRedisArg + Send,
        T: FromRedisBulk + Send,
    {
        panic!("lease checks must run atomically on the writer")
    }

    async fn set<K, V>(&self, _: K, _: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        panic!("leases require NX and expiry")
    }

    async fn mget<K, T>(&self, _: K) -> RedisResult<Vec<Option<T>>>
    where
        K: EncodeRedisArgs + Send,
        T: FromRedisBulk + Send,
    {
        panic!("unexpected MGET")
    }

    async fn del_many<K: EncodeRedisArgs + Send>(&self, _: K) -> RedisResult<i64> {
        panic!("unlock must compare the ownership token")
    }

    async fn pfcount<K: EncodeRedisArgs + Send>(&self, _: K) -> RedisResult<i64> {
        panic!("unexpected PFCOUNT")
    }

    async fn hget<K, F, T>(&self, _: K, _: F) -> RedisResult<Option<T>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        T: FromRedisBulk + Send,
    {
        panic!("unexpected HGET")
    }

    async fn hmget<K, F, T>(&self, _: K, _: F) -> RedisResult<RedisValues<T>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        T: FromRedisBulk + Send,
    {
        panic!("unexpected HMGET")
    }
}

#[derive(Default)]
struct FenceTransaction {
    statements: Vec<String>,
    rows_affected: u64,
}

impl MysqlTransaction for FenceTransaction {
    async fn execute<S: AsRef<str> + Send, A: MysqlArgs + Send>(
        &mut self,
        sql: S,
        args: A,
    ) -> MysqlResult<MysqlExecution> {
        assert_eq!(args.len(), 3);
        self.statements.push(sql.as_ref().to_string());
        Ok(MysqlExecution {
            rows_affected: self.rows_affected,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("fence validation must use affected rows")
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.statements.push(sql.as_ref().to_string());
        Ok(Vec::new())
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }
}

#[tokio::test]
async fn lease_uses_shared_key_nx_and_bounded_expiry() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let commands = redis.commands.lock().unwrap();
    assert_eq!(commands[0][0], "SET");
    assert_eq!(commands[0][1], "wegent:plugin-write:23");
    assert_eq!(commands[0][2].len(), 32);
    assert_eq!(&commands[0][3..], ["EX", "30", "NX"]);
    assert!(lease.deadline < Instant::now() + Duration::from_secs(30));
}

#[tokio::test]
async fn same_user_is_busy_while_different_users_can_proceed() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let error = PluginWriteLease::acquire_token(&redis, 23, "other".into(), Duration::ZERO)
        .await
        .err()
        .unwrap();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_busy")
    );
    let other = PluginWriteLease::acquire(Some(&redis), 24).await.unwrap();
    other.release().await;
    lease.verify_owned().await.unwrap();
    lease.release().await;
    assert!(redis.owners.lock().unwrap().is_empty());
}

#[tokio::test]
async fn redis_failure_is_fail_closed() {
    let redis = LeaseRedis {
        fail: true,
        ..LeaseRedis::default()
    };
    let error = PluginWriteLease::acquire(Some(&redis), 23)
        .await
        .err()
        .unwrap();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_unavailable")
    );
}

#[tokio::test]
async fn acquisition_deadline_also_bounds_an_unresponsive_redis_request() {
    let redis = LeaseRedis {
        stall: true,
        ..LeaseRedis::default()
    };
    let start = Instant::now();
    let error =
        PluginWriteLease::acquire_token(&redis, 23, "other".into(), Duration::from_millis(10))
            .await
            .err()
            .unwrap();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_busy")
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(redis.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stale_owner_cannot_validate_or_release_the_successor_lease() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    redis
        .owners
        .lock()
        .unwrap()
        .insert(lease.key.clone(), "successor".into());
    let error = lease.verify_owned().await.unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_lease_lost")
    );
    lease.release().await;
    assert_eq!(
        redis.owners.lock().unwrap().get("wegent:plugin-write:23"),
        Some(&"successor".to_string())
    );
}

#[tokio::test]
async fn replaced_durable_fence_rejects_commit_even_if_redis_still_matches() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let mut transaction = FenceTransaction::default();
    let error = lease.fence_commit(&mut transaction).await.unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_lease_lost")
    );
    assert_eq!(transaction.statements.len(), 1);
    assert_eq!(
        transaction.statements[0],
        "UPDATE plugin_write_fences SET token = ? WHERE user_id = ? AND token = ?"
    );
}

#[tokio::test]
async fn current_durable_fence_accepts_commit_without_a_locking_read() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let mut transaction = FenceTransaction {
        rows_affected: 1,
        ..FenceTransaction::default()
    };
    lease.fence_commit(&mut transaction).await.unwrap();
    assert_eq!(transaction.statements.len(), 1);
    assert!(!transaction.statements[0].contains("FOR UPDATE"));
}

#[tokio::test]
async fn operation_deadline_rejects_commit_before_any_fence_write() {
    let redis = LeaseRedis::default();
    let mut lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    lease.deadline = Instant::now();
    let mut transaction = FenceTransaction::default();
    let error = lease.fence_commit(&mut transaction).await.unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_lease_lost")
    );
    assert!(transaction.statements.is_empty());
}

#[tokio::test]
async fn committed_operation_does_not_wait_for_unresponsive_lease_cleanup() {
    let redis = LeaseRedis {
        stall_eval: true,
        ..LeaseRedis::default()
    };
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), lease.release())
        .await
        .expect("unlock must remain bounded after commit");
}
