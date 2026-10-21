// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_http_server::{EphemeralBytesArena, IntoHttpError, ResponseBody, ResponseCors, StatusCode};
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution};
use brz_redis::{
    Cmd, EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult, RedisValues,
    Value, cmd,
};
use std::collections::HashMap;
use std::sync::Mutex;

#[test]
fn coordination_failures_keep_the_service_unavailable_response_contract() {
    for code in [
        "plugin_write_busy",
        "plugin_write_unavailable",
        "plugin_write_lease_lost",
        "plugin_write_conflict",
    ] {
        let response =
            http_error(coordination_error(code)).into_http_error(&EphemeralBytesArena::new(256));
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.cors_policy(), ResponseCors::Apply);
        let ResponseBody::Arena(body) = response.body() else {
            panic!("expected JSON coordination failure")
        };
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(body.as_ref()).unwrap(),
            serde_json::json!({"detail": code})
        );
    }
}

#[test]
fn database_failures_match_the_python_unhandled_exception_contract() {
    for error in [
        MysqlError::QueryTimedOut,
        MysqlError::Database {
            code: Some(1205),
            sql_state: Some("HY000".to_string()),
            message: "synthetic lock wait timeout".to_string(),
        },
    ] {
        let response = http_error(error).into_http_error(&EphemeralBytesArena::new(256));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.cors_policy(), ResponseCors::Skip);
        let ResponseBody::Arena(body) = response.body() else {
            panic!("expected JSON unhandled failure")
        };
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(body.as_ref()).unwrap(),
            serde_json::json!({"error_code": 500, "detail": "Internal server error"})
        );
    }
}

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
struct RevisionTransaction {
    statements: Vec<String>,
    rows_affected: u64,
    next_revision: Option<i64>,
    inserted_user: Option<i64>,
}

impl MysqlTransaction for RevisionTransaction {
    async fn execute<S: AsRef<str> + Send, A: MysqlArgs + Send>(
        &mut self,
        sql: S,
        args: A,
    ) -> MysqlResult<MysqlExecution> {
        let first_argument = args
            .first_route_value()
            .and_then(|value| value.as_i64().ok());
        if sql.as_ref().starts_with("INSERT INTO kinds") {
            assert_eq!(args.len(), 1);
            self.inserted_user = first_argument;
        } else {
            assert_eq!(args.len(), 4);
            self.next_revision = first_argument;
        }
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
        panic!("revision validation must use affected rows")
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
async fn changed_parent_revision_rejects_commit_even_if_redis_still_matches() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let mut transaction = RevisionTransaction::default();
    let expected = PluginWriteRevision {
        id: 42,
        revision: 6,
    };
    let error = lease
        .commit_revision(&mut transaction, expected)
        .await
        .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_conflict")
    );
    assert_eq!(transaction.statements.len(), 1);
    assert!(transaction.statements[0].contains("UPDATE kinds SET json = JSON_SET"));
    assert!(
        transaction.statements[0]
            .contains("COALESCE(JSON_EXTRACT(json, '$.spec.revision'), 0) = ?")
    );
    assert!(transaction.statements[0].contains("name = 'account' AND is_active IS true"));
    assert_eq!(transaction.next_revision, Some(7));
}

#[tokio::test]
async fn current_parent_revision_accepts_commit_without_a_locking_read() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let mut transaction = RevisionTransaction {
        rows_affected: 1,
        ..RevisionTransaction::default()
    };
    lease
        .commit_revision(
            &mut transaction,
            PluginWriteRevision {
                id: 42,
                revision: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(transaction.statements.len(), 1);
    assert!(!transaction.statements[0].contains("FOR UPDATE"));
    assert_eq!(transaction.next_revision, Some(1));
}

#[tokio::test]
async fn operation_deadline_rejects_commit_before_any_revision_write() {
    let redis = LeaseRedis::default();
    let mut lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    lease.deadline = Instant::now();
    let mut transaction = RevisionTransaction::default();
    let error = lease
        .commit_revision(
            &mut transaction,
            PluginWriteRevision {
                id: 42,
                revision: 0,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_lease_lost")
    );
    assert!(transaction.statements.is_empty());
}

#[test]
fn business_revisions_support_legacy_documents_and_reject_invalid_versions() {
    for document in [
        serde_json::json!({}),
        serde_json::json!({"spec": {"enabled": false}}),
    ] {
        assert_eq!(business_revision(&document).unwrap(), 0);
    }
    assert_eq!(
        business_revision(&serde_json::json!({"spec": {"revision": 7}})).unwrap(),
        7
    );
    for value in [
        serde_json::json!(-1),
        serde_json::json!("7"),
        serde_json::Value::Null,
        serde_json::json!(true),
        serde_json::json!(i64::MAX),
    ] {
        let error =
            business_revision(&serde_json::json!({"spec": {"revision": value}})).unwrap_err();
        assert_eq!(
            http_error(error).detail_message(),
            Some("plugin_write_conflict")
        );
    }
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

fn policy_row(id: i64, is_active: bool, document: serde_json::Value) -> PolicyRow {
    PolicyRow {
        id,
        json: document,
        is_active: Some(is_active),
    }
}

#[test]
fn policy_lookup_checks_full_identity_and_includes_inactive_duplicates() {
    assert!(POLICY_QUERY.contains("user_id = ?"));
    assert!(POLICY_QUERY.contains("'ConnectorAuthPolicy' AND namespace = 'plugin-auth'"));
    assert!(POLICY_QUERY.contains("name = 'account'"));
    assert!(POLICY_QUERY.ends_with("LIMIT 2"));
    assert!(!POLICY_QUERY.contains("is_active ="));
}

#[test]
fn duplicate_policy_parents_are_rejected_even_when_one_is_inactive() {
    let error = unique_policy(vec![
        policy_row(1, true, serde_json::json!({"spec": {"revision": 2}})),
        policy_row(2, false, serde_json::json!({"spec": {"revision": 7}})),
    ])
    .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_conflict")
    );
}

#[test]
fn existing_legacy_policy_keeps_its_opt_out_and_version() {
    let row = unique_policy(vec![policy_row(
        42,
        false,
        serde_json::json!({"spec": {"enabled": false}}),
    )])
    .unwrap()
    .unwrap();
    assert_eq!(row.json["spec"]["enabled"], false);
    assert_eq!(business_revision(&row.json).unwrap(), 0);
    for document in [
        serde_json::json!({}),
        serde_json::json!({"spec": null}),
        serde_json::json!({"spec": {"revision": -1}}),
    ] {
        assert!(unique_policy(vec![policy_row(42, true, document)]).is_err());
    }
}

#[tokio::test]
async fn inactive_policy_reactivation_uses_cas_and_advances_the_version() {
    for rows_affected in [0, 1] {
        let mut transaction = RevisionTransaction {
            rows_affected,
            ..Default::default()
        };
        let result = restore_policy(
            &mut transaction,
            23,
            policy_row(
                42,
                false,
                serde_json::json!({"spec": {"enabled": false, "revision": 7}}),
            ),
        )
        .await;
        assert_eq!(result.is_ok(), rows_affected == 1);
        assert_eq!(transaction.next_revision, Some(8));
        assert!(transaction.statements[0].contains("AND user_id = ?"));
        assert!(transaction.statements[0].contains("AND is_active IS false"));
        assert!(transaction.statements[0].contains("'$.spec.revision'), 0) = ?"));
        assert!(!transaction.statements[0].contains("enabled"));
    }
}

#[tokio::test]
async fn an_existing_active_policy_needs_no_write() {
    let mut transaction = RevisionTransaction::default();
    restore_policy(
        &mut transaction,
        23,
        policy_row(
            42,
            true,
            serde_json::json!({"spec": {"enabled": false, "revision": 7}}),
        ),
    )
    .await
    .unwrap();
    assert!(transaction.statements.is_empty());
}

#[tokio::test]
async fn first_policy_creation_reads_the_real_parent_before_inserting() {
    let mut transaction = RevisionTransaction::default();
    ensure_policy_in(&mut transaction, 23).await.unwrap();
    assert_eq!(transaction.statements.len(), 2);
    assert_eq!(transaction.statements[0], POLICY_QUERY);
    assert!(transaction.statements[1].starts_with("INSERT INTO kinds"));
    assert!(transaction.statements[1].contains("'ConnectorAuthPolicy', 'plugin-auth', 'account'"));
    assert!(transaction.statements[1].contains("{\"spec\":{\"enabled\":true,\"revision\":0}}"));
    assert_eq!(transaction.inserted_user, Some(23));
    assert_eq!(transaction.next_revision, None);
    for sql in transaction.statements {
        assert!(!sql.contains("FOR UPDATE"));
        assert!(!sql.contains("ON DUPLICATE KEY"));
    }
}
