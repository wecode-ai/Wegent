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

#[path = "write_coordination_policy_tests.rs"]
mod policy_tests;

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
    replica_owners: Option<HashMap<String, String>>,
    commands: Mutex<Vec<Vec<String>>>,
    fail: bool,
    stall: bool,
    stall_eval: bool,
    release_after_contention: bool,
    stall_after_claim: bool,
    evalsha_error_kind: Option<brz_redis::ErrorKind>,
    script_load_fails: bool,
    script_loaded: Mutex<bool>,
}

#[tokio::test]
async fn cancelling_auto_update_response_keeps_transaction_and_unlock_owned() {
    let redis = std::sync::Arc::new(LeaseRedis::default());
    let operation_redis = redis.clone();
    let (entered, entered_rx) = tokio::sync::oneshot::channel();
    let (finish, finish_rx) = tokio::sync::oneshot::channel();
    let (released, released_rx) = tokio::sync::oneshot::channel();
    let response = tokio::spawn(async move {
        super::super::auto_update::complete_auto_update(async move {
            let lease = PluginWriteLease::acquire(Some(operation_redis.as_ref()), 23).await?;
            entered.send(()).unwrap();
            finish_rx.await.unwrap();
            lease.release().await;
            released.send(()).unwrap();
            Ok(())
        })
        .await
    });
    entered_rx.await.unwrap();
    response.abort();
    assert!(response.await.unwrap_err().is_cancelled());
    assert!(
        redis
            .owners
            .lock()
            .unwrap()
            .contains_key("wegent:plugin-write:23:@account-policy")
    );
    finish
        .send(())
        .expect("response cancellation must retain the in-flight transaction");
    tokio::time::timeout(Duration::from_secs(1), released_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(redis.owners.lock().unwrap().is_empty());
    PluginWriteLease::acquire(Some(redis.as_ref()), 23)
        .await
        .unwrap()
        .release()
        .await;
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
                std::collections::hash_map::Entry::Occupied(entry) => {
                    if self.release_after_contention {
                        entry.remove();
                    }
                    Value::Nil
                }
            },
            "GET" => {
                let readable_owners = if command.is_readonly() {
                    self.replica_owners.as_ref().unwrap_or(&owners)
                } else {
                    &owners
                };
                match readable_owners.get(&args[1]) {
                    Some(value) => Value::BulkString(value.clone().into_bytes().into()),
                    None => Value::Nil,
                }
            }
            "SCRIPT" => {
                if self.script_load_fails {
                    return Err(brz_redis::RedisError::new(
                        brz_redis::ErrorKind::ResponseError,
                        "load failed",
                    ));
                }
                *self.script_loaded.lock().unwrap() = true;
                Value::BulkString(RELEASE_SHA.as_bytes().to_vec().into())
            }
            "EVALSHA" => {
                if let Some(kind) = self.evalsha_error_kind
                    && (kind != brz_redis::ErrorKind::NoScript
                        || !*self.script_loaded.lock().unwrap())
                {
                    return Err(brz_redis::RedisError::new(kind, "evalsha failed"));
                }
                let matches = owners.get(&args[3]) == Some(&args[4]);
                if matches {
                    owners.remove(&args[3]);
                }
                Value::Int(i64::from(matches))
            }
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
        let result = self.run(command);
        let has_owner = !self.owners.lock().unwrap().is_empty();
        if self.stall_after_claim && has_owner {
            std::future::pending::<()>().await;
        }
        result
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

    async fn get<K, T>(&self, key: K) -> RedisResult<Option<T>>
    where
        K: EncodeRedisArg + Send,
        T: FromRedisBulk + Send,
    {
        let mut command = cmd("GET");
        command.mark_readonly();
        command.arg_encoded(key)?;
        let raw: Option<brz_redis::RedisBytes> = self.run(command)?;
        raw.map(T::from_redis_bulk).transpose()
    }

    async fn evalsha<D, K, A, T>(&self, digest: D, keys: K, arguments: A) -> RedisResult<T>
    where
        D: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        T: FromRedisValue + Send,
    {
        let mut command = cmd("EVALSHA");
        command.arg_encoded(digest)?.arg_encoded(keys.num_args())?;
        keys.encode_args(&mut command)?;
        arguments.encode_args(&mut command)?;
        self.run(command)
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
        if sql.as_ref().starts_with("INSERT INTO plugin_states") {
            assert_eq!(args.len(), 2);
        } else if sql.as_ref().starts_with("INSERT INTO kinds") {
            assert_eq!(args.len(), 1);
            self.inserted_user = first_argument;
        } else {
            assert!([4, 5].contains(&args.len()));
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
    assert_eq!(commands[0][1], "wegent:plugin-write:23:@account-policy");
    assert_eq!(commands[0][2].len(), 32);
    assert_eq!(&commands[0][3..], ["PX", "30000", "NX"]);
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
async fn blocked_acquisition_polls_at_the_redis_py_sleep_interval() {
    let redis = LeaseRedis::default();
    redis.owners.lock().unwrap().insert(
        "wegent:plugin-write:23:@account-policy".into(),
        "fixture".into(),
    );

    // redis-py's Lock sleeps 100ms between attempts and stops as soon as the
    // next attempt would pass the 350ms blocking timeout: four SET ... NX
    // commands. The previous fixed 50ms loop produced eight.
    let error =
        PluginWriteLease::acquire_token(&redis, 23, "contended".into(), Duration::from_millis(350))
            .await
            .err()
            .expect("the fixture keeps the lease busy");
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_busy")
    );
    let attempts = redis.commands.lock().unwrap().len();
    assert!(
        (3..=5).contains(&attempts),
        "redis-py retries every 100ms; observed {attempts} attempts in 350ms"
    );
}

#[tokio::test]
async fn acquisition_deadline_prevents_another_set_after_the_last_wait() {
    let redis = LeaseRedis {
        release_after_contention: true,
        stall_after_claim: true,
        ..LeaseRedis::default()
    };
    redis.owners.lock().unwrap().insert(
        "wegent:plugin-write:23:@account-policy".into(),
        "fixture".into(),
    );

    let result = PluginWriteLease::acquire_token(
        &redis,
        23,
        "expired-attempt".into(),
        Duration::from_millis(10),
    )
    .await;

    let error = result.err().expect("the coordination budget has expired");
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_busy")
    );
    assert!(redis.owners.lock().unwrap().is_empty());
    assert_eq!(redis.commands.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn primary_lease_remains_valid_when_the_replica_is_behind() {
    let key = "wegent:plugin-write:23:@account-policy";
    for replica_owner in [None, Some("previous-owner")] {
        let redis = LeaseRedis {
            replica_owners: Some(
                replica_owner
                    .map(|owner| (key.to_string(), owner.to_string()))
                    .into_iter()
                    .collect(),
            ),
            ..LeaseRedis::default()
        };
        let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();

        assert_eq!(
            redis.get::<_, String>(key).await.unwrap().as_deref(),
            replica_owner
        );
        lease.verify_owned().await.unwrap();
        lease.release().await;
    }
}

#[tokio::test]
async fn stale_owner_cannot_validate_or_release_the_successor_lease() {
    let key = "wegent:plugin-write:23:@account-policy";
    let redis = LeaseRedis {
        replica_owners: Some(HashMap::from([(key.into(), "previous-owner".into())])),
        ..LeaseRedis::default()
    };
    let lease = PluginWriteLease::acquire_token(&redis, 23, "previous-owner".into(), ACQUIRE_WAIT)
        .await
        .unwrap();
    redis
        .owners
        .lock()
        .unwrap()
        .insert(lease.key.clone(), "successor".into());
    assert_eq!(
        redis.get::<_, String>(key).await.unwrap().as_deref(),
        Some("previous-owner")
    );
    let error = lease.verify_owned().await.unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_lease_lost")
    );
    lease.release().await;
    assert_eq!(
        redis.owners.lock().unwrap().get(key),
        Some(&"successor".to_string())
    );
}

#[tokio::test]
async fn changed_parent_revision_rejects_commit_even_if_redis_still_matches() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire(Some(&redis), 23).await.unwrap();
    let mut transaction = RevisionTransaction::default();
    let expected = scoped::PluginRevision {
        id: 42,
        name: "plugin-a".into(),
        revision: 6,
    };
    let error = lease
        .commit_plugin_revision(&mut transaction, expected, "plugin-a")
        .await
        .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_conflict")
    );
    assert_eq!(transaction.statements.len(), 1);
    let sql = &transaction.statements[0];
    assert!(sql.contains("'$.spec.writeRevision'"));
    assert!(sql.contains("kind='InstalledPlugin'"));
    assert!(sql.contains("namespace='default' AND name=?"));
    assert!(sql.contains("user_id=?"));
    assert!(!sql.contains("ConnectorAuthPolicy"));
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
        .commit_plugin_revision(
            &mut transaction,
            scoped::PluginRevision {
                id: 42,
                name: "plugin-a".into(),
                revision: 0,
            },
            "plugin-a",
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
        .commit_plugin_revision(
            &mut transaction,
            scoped::PluginRevision {
                id: 42,
                name: "plugin-a".into(),
                revision: 0,
            },
            "plugin-a",
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
    assert_eq!(transaction.statements.len(), 3);
    assert!(transaction.statements[0].starts_with("INSERT INTO plugin_states"));
    assert!(transaction.statements[0].contains("ON DUPLICATE KEY UPDATE"));
    assert_eq!(transaction.statements[1], POLICY_QUERY);
    assert!(transaction.statements[2].starts_with("INSERT INTO kinds"));
    assert!(transaction.statements[2].contains("'ConnectorAuthPolicy', 'plugin-auth', 'account'"));
    assert_eq!(transaction.inserted_user, Some(23));
    assert_eq!(transaction.next_revision, None);
    for sql in transaction.statements {
        assert!(!sql.contains("FOR UPDATE"));
    }
}

fn lease_redis(kind: Option<brz_redis::ErrorKind>, load_fails: bool) -> LeaseRedis {
    LeaseRedis {
        evalsha_error_kind: kind,
        script_load_fails: load_fails,
        ..LeaseRedis::default()
    }
}

#[tokio::test]
async fn release_loads_the_script_only_after_noscript() {
    let redis = lease_redis(Some(brz_redis::ErrorKind::NoScript), false);
    let lease = super::PluginWriteLease::acquire(Some(&redis), 1)
        .await
        .unwrap();
    redis.commands.lock().unwrap().clear();
    lease.release().await;
    let commands = redis.commands.lock().unwrap().clone();
    let names: Vec<&str> = commands.iter().map(|c| c[0].as_str()).collect();
    assert_eq!(names, ["EVALSHA", "SCRIPT", "EVALSHA"], "{commands:?}");
    assert_eq!(commands[1][1], "LOAD");
    assert_eq!(commands[1][2], RELEASE_SCRIPT);
}

#[tokio::test]
async fn a_failed_script_load_does_not_retry() {
    let redis = lease_redis(Some(brz_redis::ErrorKind::NoScript), true);
    let lease = super::PluginWriteLease::acquire(Some(&redis), 1)
        .await
        .unwrap();
    redis.commands.lock().unwrap().clear();
    lease.release().await;
    let names: Vec<String> = redis
        .commands
        .lock()
        .unwrap()
        .iter()
        .map(|c| c[0].clone())
        .collect();
    assert_eq!(names, ["EVALSHA", "SCRIPT"]);
}

#[tokio::test]
async fn ordinary_errors_do_not_load_the_script() {
    let redis = lease_redis(Some(brz_redis::ErrorKind::ResponseError), false);
    let lease = super::PluginWriteLease::acquire(Some(&redis), 1)
        .await
        .unwrap();
    redis.commands.lock().unwrap().clear();
    lease.release().await;
    let names: Vec<String> = redis
        .commands
        .lock()
        .unwrap()
        .iter()
        .map(|c| c[0].clone())
        .collect();
    assert_eq!(names, ["EVALSHA"]);
}

#[tokio::test]
async fn different_installations_progress_while_same_installation_is_busy() {
    let redis = LeaseRedis::default();
    let first = PluginWriteLease::acquire_names(Some(&redis), 23, vec!["plugin-a".into()])
        .await
        .unwrap();
    let second = PluginWriteLease::acquire_names(Some(&redis), 23, vec!["plugin-b".into()])
        .await
        .unwrap();
    let error = PluginWriteLease::acquire_names_wait(
        Some(&redis),
        23,
        vec!["plugin-a".into()],
        Duration::ZERO,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_busy")
    );
    first.verify_owned().await.unwrap();
    second.verify_owned().await.unwrap();
    assert_eq!(redis.owners.lock().unwrap().len(), 2);
    first.release().await;
    second.release().await;
    assert!(redis.owners.lock().unwrap().is_empty());
}

#[tokio::test]
async fn batch_never_holds_another_plugin_while_waiting_for_a_busy_one() {
    let redis = LeaseRedis::default();
    let held = PluginWriteLease::acquire_names(Some(&redis), 23, vec!["plugin-b".into()])
        .await
        .unwrap();
    let started = Instant::now();
    let error = PluginWriteLease::acquire_names(
        Some(&redis),
        23,
        vec!["plugin-a".into(), "plugin-b".into()],
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_busy")
    );
    assert!(started.elapsed() < Duration::from_millis(100));
    assert!(
        !redis
            .owners
            .lock()
            .unwrap()
            .contains_key("wegent:plugin-write:23:plugin-a")
    );
    held.release().await;
}
