// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the team-resolution cache store, split from
//! `kinds.rs` to keep that module within the repository's file-size bound.

use super::*;

fn timestamp(text: &str) -> chrono::NaiveDateTime {
    chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").expect("test timestamp")
}

#[test]
fn reporter_gate_admits_reporter_and_above() {
    for role in ["Owner", "Maintainer", "Developer", "Reporter"] {
        assert!(reporter_or_above(role));
    }
    assert!(!reporter_or_above("RestrictedAnalyst"));
}

/// `CachedSharedTeamReader._key_idx_user_teams` with
/// `CACHE_VERSION = "v2"`.
#[test]
fn shared_team_list_key_matches_the_source_extension() {
    assert_eq!(
        shared_team_list_key(2630),
        "shared_team:v2:idx:user_teams:2630"
    );
}

/// The recorded `shared_team:v2:idx:user_teams:2630` payload:
/// `json.dumps([233420, ...])` keeps Python's `", "` separators, and an
/// empty list is the `__NULL__` negative marker.
#[test]
fn shared_team_list_payload_matches_the_recorded_document() {
    assert_eq!(
        shared_team_list_payload(&[
            233420, 233480, 233502, 233506, 233510, 233514, 233521, 233488, 233561, 268349
        ]),
        "[233420, 233480, 233502, 233506, 233510, 233514, 233521, 233488, 233561, 268349]"
    );
    assert_eq!(shared_team_list_payload(&[]), "__NULL__");
}

/// `_get_team`'s `default`-namespace step order for a viewer without a
/// personal Team: the personal index probe, the shared-team list, the
/// shared-id hit, the share-permission candidates, and the public Team —
/// here with the cache client absent, so every step reads SQL.
#[tokio::test]
async fn null_team_ref_runs_the_source_step_order() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let team_id = store
        .get_team_id_by_name_and_namespace(2630, "default", "wegent-chat")
        .await
        .expect("resolution succeeds");
    assert_eq!(team_id, None);
    let queries: Vec<String> = mysql.queries().into_iter().map(|query| query.sql).collect();
    assert_eq!(queries.len(), 4, "{queries:?}");
    assert!(
        queries[0].contains("kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ?"),
        "{queries:?}"
    );
    assert!(queries[1].contains("FROM resource_members"), "{queries:?}");
    assert!(
        queries[2].contains("kinds.user_id NOT IN (0, ?)") && queries[2].contains("'Team'"),
        "{queries:?}"
    );
    assert!(
        queries[3].contains("kinds.user_id = 0 AND kinds.kind = ?"),
        "{queries:?}"
    );
}

/// A viewer that is not the task owner (`user_id == 0`) skips the
/// personal/shared/candidate steps and resolves only the public Team.
#[tokio::test]
async fn anonymous_viewer_resolves_only_the_public_team() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let team_id = store
        .get_team_id_by_name_and_namespace(0, "default", "wegent-chat")
        .await
        .expect("resolution succeeds");
    assert_eq!(team_id, None);
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1, "{:?}", queries[0].sql);
    assert!(
        queries[0]
            .sql
            .contains("kinds.user_id = 0 AND kinds.kind = ?"),
        "{}",
        queries[0].sql
    );
}

/// `CachedGroupReader._key_data` and
/// `CachedGroupMemberReader._key_idx_group_user` with
/// `CACHE_VERSION = "v2"`.
#[test]
fn group_cache_keys_match_the_source_extension() {
    assert_eq!(
        group_document_key("rcdp/community"),
        "group:v2:data:rcdp/community"
    );
    assert_eq!(
        group_member_role_key("rcdp/community", 6013),
        "group_member:v2:idx:group_user:rcdp/community:6013"
    );
}

/// A `kind:v2:data` document projects onto the SQL row shape the
/// resolver consumes, the CRD document included.
#[test]
fn cached_record_projects_onto_the_kind_row_shape() {
    let record = KindRecord {
        id: 110467,
        user_id: 0,
        kind: "Team".to_owned(),
        name: "wegent-chat".to_owned(),
        namespace: "default".to_owned(),
        json: brz_mysql::Json(serde_json::json!({
            "spec": {"members": [{"role": "leader"}]}
        })),
        is_active: 1,
        created_at: timestamp("2026-01-19 14:16:18"),
        updated_at: timestamp("2026-08-07 03:01:22"),
    };
    let row = kind_row(record);
    assert_eq!(row.kinds_id, 110467);
    assert_eq!(row.kinds_user_id, 0);
    assert_eq!(row.kinds_kind, "Team");
    assert_eq!(row.kinds_name, "wegent-chat");
    assert_eq!(row.kinds_namespace, "default");
    assert_eq!(
        row.kinds_json.0.to_value(),
        serde_json::json!({"spec": {"members": [{"role": "leader"}]}})
    );
    assert_eq!(row.kinds_is_active, 1);
}

/// `CachedGroupReader._set_data`'s payload: the `namespace` columns in
/// table order, Python's `", "`/`": "` separators, `ensure_ascii=True`
/// escaping, and `datetime.isoformat()` timestamps.
#[test]
fn namespace_document_matches_the_source_serialization() {
    let row = repo::NamespaceRow {
        namespace_id: 7,
        namespace_name: "team-a".to_owned(),
        namespace_display_name: None,
        namespace_owner_user_id: Some(12),
        namespace_visibility: "internal".to_owned(),
        namespace_description: Some("desc".to_owned()),
        namespace_level: Some("group".to_owned()),
        namespace_is_active: Some(1),
        namespace_created_at: Some(timestamp("2026-01-19 14:16:18")),
        namespace_updated_at: None,
    };
    assert_eq!(
        python_namespace_json(&row),
        "{\"id\": 7, \"name\": \"team-a\", \"display_name\": null, \"owner_user_id\": 12, \
         \"visibility\": \"internal\", \"description\": \"desc\", \"level\": \"group\", \
         \"is_active\": true, \"created_at\": \"2026-01-19T14:16:18\", \"updated_at\": null}"
    );
}

/// `datetime.isoformat()` drops zero microseconds and keeps the rest.
#[test]
fn isoformat_keeps_microseconds_only_when_present() {
    assert_eq!(
        python_isoformat(timestamp("2026-01-19 14:16:18")),
        "2026-01-19T14:16:18"
    );
    assert_eq!(
        python_isoformat(timestamp("2026-01-19 14:16:18.123456")),
        "2026-01-19T14:16:18.123456"
    );
}

/// `groupReader.is_public` with the cache client absent: the namespace
/// query answers the visibility and no membership read runs.
#[tokio::test]
async fn group_is_public_reads_the_namespace_when_the_cache_misses() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    assert!(
        !store
            .group_is_public("rcdp/community")
            .await
            .expect("query runs")
    );
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1, "{queries:?}");
    assert!(queries[0].sql.contains("FROM namespace"), "{queries:?}");
}

/// `groupMemberReader.is_member` with the cache client absent: the
/// namespace id lookup (`get_namespace_id_by_name`), which answers the
/// membership when the group is unknown.
#[tokio::test]
async fn group_member_role_reads_the_namespace_when_the_cache_misses() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    assert_eq!(
        store
            .group_member_role("rcdp/community", 6013)
            .await
            .expect("query runs"),
        None
    );
    let queries: Vec<String> = mysql.queries().into_iter().map(|query| query.sql).collect();
    assert_eq!(queries.len(), 1, "{queries:?}");
    assert!(
        queries[0].contains("FROM namespace")
            && queries[0].contains("namespace.name = 'rcdp/community'"),
        "{queries:?}"
    );
}

/// Records every statement issued through the caller-owned handle so a
/// test can prove which SQL handle ran the read.
#[derive(Default)]
struct RecordingRequestSql {
    calls: std::sync::Mutex<Vec<(crate::request_sql::RouteKey, String, usize)>>,
}

impl RecordingRequestSql {
    fn calls(&self) -> Vec<(crate::request_sql::RouteKey, String, usize)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl crate::request_sql::RequestSql for RecordingRequestSql {
    async fn execute_statement(
        &mut self,
        route: crate::request_sql::RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments.len()));
        Ok(brz_mysql::MysqlExecution {
            rows_affected: 0,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional_row(
        &mut self,
        route: crate::request_sql::RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments.len()));
        Ok(None)
    }

    async fn fetch_all_rows(
        &mut self,
        route: crate::request_sql::RouteKey,
        sql: &str,
        arguments: crate::request_sql::StatementArgs,
    ) -> brz_mysql::MysqlResult<Vec<brz_mysql::MysqlRow>> {
        self.calls
            .lock()
            .unwrap()
            .push((route, sql.to_string(), arguments.len()));
        Ok(Vec::new())
    }
}

/// A Redis stub that serves the given documents by key and nothing else.
struct HitRedis {
    entries: std::collections::HashMap<String, String>,
}

impl brz_redis::Redis for HitRedis {
    async fn get<K, R>(&self, key: K) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        let key = String::from_utf8_lossy(key.as_encoded_bytes().unwrap_or_default()).into_owned();
        match self.entries.get(&key) {
            Some(value) => Ok(Some(R::from_redis_bulk(brz_redis::RedisBytes::from(
                value.clone().into_bytes(),
            ))?)),
            None => Ok(None),
        }
    }

    async fn set<K, V>(&self, _: K, _: V) -> brz_redis::RedisResult<()>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        Ok(())
    }

    async fn mget<K, R>(&self, _: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn del_many<K>(&self, _: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn pfcount<K>(&self, _: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _: K, _: F) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(&self, _: K, _: F) -> brz_redis::RedisResult<brz_redis::RedisValues<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Err(brz_redis::RedisError::new(
            brz_redis::ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

/// A non-`default` namespace's group branch (the recorded `support` Team
/// read) issues its cache-miss read on the request handle, not the pool: the
/// fake returns no Team row, so the chain ends at that first read — the exact
/// statement the replay reported as an autocommit pool read.
#[tokio::test]
async fn group_team_cache_miss_reads_through_the_request_handle() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let mut sql = RecordingRequestSql::default();
    let team = store
        .resolve_team_on(&mut sql, 6526, "support", "Profile review")
        .await
        .expect("resolution succeeds");
    assert!(team.is_none());
    let calls = sql.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].0, crate::request_sql::RouteKey::None);
    assert!(
        calls[0]
            .1
            .contains("kinds.kind = ? AND kinds.namespace = ? AND kinds.name = ?")
            && calls[0].2 == 3,
        "{calls:?}"
    );
    // No statement ran on the pool handle.
    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}

/// The create path's request handle must own every cache-miss read: the
/// personal Team lookup, the shared-team list, the share candidates and
/// the public fallback all run on `sql`, and the pool stays untouched.
#[tokio::test]
async fn team_cache_miss_reads_through_the_request_handle() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let mut sql = RecordingRequestSql::default();
    let team = store
        .resolve_team_on(&mut sql, 2630, "default", "wegent-chat")
        .await
        .expect("resolution succeeds");
    assert!(team.is_none());
    let calls = sql.calls();
    assert_eq!(calls.len(), 4, "{calls:?}");
    assert!(
        calls
            .iter()
            .all(|(route, _, _)| *route == crate::request_sql::RouteKey::None)
    );
    assert!(
        calls[0]
            .1
            .contains("kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ?"),
        "{calls:?}"
    );
    assert!(calls[1].1.contains("FROM resource_members"), "{calls:?}");
    assert!(
        calls[2].1.contains("kinds.user_id NOT IN (0, ?)") && calls[2].1.contains("'Team'"),
        "{calls:?}"
    );
    assert!(
        calls[3].1.contains("kinds.user_id = 0 AND kinds.kind = ?"),
        "{calls:?}"
    );
    // No statement ran on the pool handle.
    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}

/// A cached Team hit answers from the `kind:v2` documents alone: neither
/// the request handle nor the pool issues a statement.
#[tokio::test]
async fn team_cache_hit_issues_no_sql() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let mut entries = std::collections::HashMap::new();
    entries.insert(
        "kind:v2:idx:personal:Team:2630:default:wegent-chat".to_owned(),
        "110467".to_owned(),
    );
    entries.insert(
        "kind:v2:data:Team:110467".to_owned(),
        serde_json::json!({
            "id": 110467,
            "user_id": 2630,
            "kind": "Team",
            "name": "wegent-chat",
            "namespace": "default",
            "json": {"spec": {"members": []}},
            "is_active": 1,
            "created_at": "2026-01-19T14:16:18",
            "updated_at": "2026-08-07T03:01:22",
        })
        .to_string(),
    );
    let redis = HitRedis { entries };
    let store: KindCacheStore<'_, _, HitRedis> = KindCacheStore {
        mysql: &mysql,
        redis: Some(&redis),
        erp: None,
        resolvers: None,
    };
    let mut sql = RecordingRequestSql::default();
    let team = store
        .resolve_team_on(&mut sql, 2630, "default", "wegent-chat")
        .await
        .expect("resolution succeeds")
        .expect("cache hit");
    assert_eq!(team.kinds_id, 110467);
    assert_eq!(team.kinds_name, "wegent-chat");
    assert!(sql.calls().is_empty(), "{:?}", sql.calls());
    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}

/// The Bot lookup the create flow issues (the recorded `kinds.user_id = ?
/// ... kind = 'Bot'` and its public fallback) must run on the request handle,
/// never on the pool: this is the read that paired as a pool autocommit in
/// the replay case.
#[tokio::test]
async fn bot_cache_miss_reads_through_the_request_handle() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store: KindCacheStore<'_, _> = KindCacheStore {
        mysql: &mysql,
        redis: None,
        erp: None,
        resolvers: None,
    };
    let mut sql = RecordingRequestSql::default();
    let bot = store
        .get_by_name_and_namespace_row_on(&mut sql, 6527, "Bot", "default", "AI助理")
        .await
        .expect("read succeeds");
    assert!(bot.is_none());
    let calls = sql.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(
        calls[0]
            .1
            .contains("kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ?")
            && calls[0].2 == 4,
        "{calls:?}"
    );
    assert!(
        calls[1].1.contains("kinds.user_id = 0 AND kinds.kind = ?"),
        "{calls:?}"
    );
    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}
