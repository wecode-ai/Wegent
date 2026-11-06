// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused coverage for the late Bot/Ghost lifecycle
//! (`unified.py:382-391` -> `_get_bot_for_subtask` + `_get_bot_ghost_chain`):
//! the post-processing builder re-selects the subtask Bot and re-resolves its
//! Ghost through the cached kind reader before `_get_bot_skills` compiles the
//! Skills.

use super::*;
use crate::task_skills::kinds::KindCacheStore;
use serde_json::json;

/// A Redis stub that records every read key and serves the given documents.
#[derive(Default)]
struct RecordingRedis {
    entries: std::collections::HashMap<String, String>,
    reads: std::sync::Mutex<Vec<String>>,
}

impl RecordingRedis {
    fn seeded(entries: &[(&str, &str)]) -> Self {
        Self {
            entries: entries
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
            reads: std::sync::Mutex::default(),
        }
    }

    fn reads(&self) -> Vec<String> {
        self.reads.lock().expect("stub reads").clone()
    }
}

impl brz_redis::Redis for RecordingRedis {
    async fn get<K, R>(&self, key: K) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        let key = String::from_utf8_lossy(key.as_encoded_bytes().unwrap_or_default()).into_owned();
        self.reads.lock().expect("stub reads").push(key.clone());
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

/// The token service the Skill compiler consults for OAuth-mode servers; the
/// lifecycle fixtures carry no provider Skill row, so it is never called.
struct StubTokens;

#[async_trait::async_trait]
impl UserMcpAccessTokens for StubTokens {
    async fn ensure_access_token(&self, _: &str, _: &str, _: &str) -> Result<String, FastApiError> {
        Ok("stub-token".to_string())
    }
}

fn binding_context() -> SkillBindingContext<'static> {
    SkillBindingContext {
        mode: "chat",
        agent_id: 900_100,
        project_id: None,
        group_namespace: None,
    }
}

/// `_get_bot_for_subtask` (`request_builder.py:1128-1140`): the subtask's
/// first bot id is read with the Bot + active predicates. The recorded
/// statement renders `is_active = 1` (a truthy column filter) and binds the
/// selected id as the only parameter.
#[tokio::test]
async fn the_primary_late_bot_read_uses_the_subtask_id_and_bot_predicate() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let redis = RecordingRedis::default();
    let cache: KindCacheStore<'_, _, RecordingRedis> = KindCacheStore {
        mysql: &mysql,
        redis: Some(&redis),
        erp: None,
        resolvers: None,
    };
    let team = json!({"spec": {"members": []}});
    let reads = late_bot_reads(&cache, &[900_001], &team, 6510);
    let bot = late_subtask_bot(&reads).await.expect("read");
    assert!(bot.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1, "{queries:?}");
    assert!(
        queries[0]
            .sql
            .contains("kinds.id = ? AND kinds.kind = 'Bot' AND kinds.is_active = 1"),
        "{}",
        queries[0].sql
    );
    assert_eq!(queries[0].args, 1);
    assert_eq!(queries[0].first_integer, Some(900_001));
    // No team member: `_get_first_bot` has nothing to resolve.
    assert!(redis.reads().is_empty(), "{:?}", redis.reads());
}

/// `_get_first_bot` (`request_builder.py:1162-1189`): when the subtask Bot is
/// absent the team's first member resolves through `kindReader` with
/// `team.user_id`, so a `default`-namespace member probes the personal index
/// document — never a global or another user's entry.
#[tokio::test]
async fn the_late_bot_fallback_is_owner_scoped() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let redis = RecordingRedis::default();
    let cache: KindCacheStore<'_, _, RecordingRedis> = KindCacheStore {
        mysql: &mysql,
        redis: Some(&redis),
        erp: None,
        resolvers: None,
    };
    // `BotTeamRef.namespace` defaults to `default` when the member omits it.
    let team = json!({"spec": {"members": [{"botRef": {"name": "first-bot"}}]}});
    let reads = late_bot_reads(&cache, &[900_002], &team, 6510);
    let bot = late_subtask_bot(&reads).await.expect("read");
    assert!(bot.is_none());

    let queries = mysql.queries();
    // The subtask id read first, then the personal (`team.user_id`-scoped)
    // fallback and finally the public one.
    assert_eq!(queries.len(), 3, "{queries:?}");
    assert_eq!(queries[0].first_integer, Some(900_002));
    assert!(
        queries[1].sql.contains("kinds.user_id = ?")
            && queries[1].sql.contains("kinds.kind = ?")
            && queries[1].first_integer == Some(6510),
        "{queries:?}"
    );
    assert_eq!(queries[2].first_integer, None);
    assert!(queries[2].sql.contains("kinds.user_id = 0"), "{queries:?}");

    // The personal index document is keyed by the team's owner, so the late
    // fallback never probes a global or another user's entry.
    let reads = redis.reads();
    assert_eq!(
        reads.first().map(String::as_str),
        Some("kind:v2:idx:personal:Bot:6510:default:first-bot"),
        "{reads:?}"
    );
    assert_eq!(
        reads.get(1).map(String::as_str),
        Some("kind:v2:idx:public:Bot:default:first-bot"),
        "{reads:?}"
    );
    assert!(
        reads
            .iter()
            .all(|key| !key.contains("idx:personal:Bot:0:")
                && !key.contains("idx:personal:Bot:6520:")),
        "{reads:?}"
    );
}

/// `_get_bot_ghost_chain` (`request_builder.py:1653`): the late
/// `_get_bot_skills` re-resolves the Ghost through the cached reader and
/// `merge_ghost_capabilities` rebuilds the live capabilities. Those
/// capabilities drive the Skill compilation, so a Skill that only the late
/// chain names is the one the compiler reads.
#[tokio::test]
async fn the_late_ghost_chain_feeds_the_skill_compilation() {
    const NS: &str = "group/team-ns";
    let bot_document = json!({
        "id": 900_003,
        "user_id": 6510,
        "kind": "Bot",
        "name": "late-bot",
        "namespace": NS,
        "json": {
            "kind": "Bot",
            "spec": {
                "ghostRef": {"namespace": NS, "name": "late-ghost"},
                "capability_mode": "manual",
            },
        },
        "is_active": 1,
    });
    let ghost_document = json!({
        "id": 900_004,
        "user_id": 6510,
        "kind": "Ghost",
        "name": "late-ghost",
        "namespace": NS,
        "json": {
            "kind": "Ghost",
            "spec": {
                "skills": ["late-skill"],
                "skill_refs": {"late-skill": {"skill_id": 424_242, "namespace": NS}},
            },
        },
        "is_active": 1,
    });
    let redis = RecordingRedis::seeded(&[
        ("kind:v2:idx:group:Bot:group/team-ns:late-bot", "900003"),
        ("kind:v2:data:Bot:900003", &bot_document.to_string()),
        ("kind:v2:idx:group:Ghost:group/team-ns:late-ghost", "900004"),
        ("kind:v2:data:Ghost:900004", &ghost_document.to_string()),
    ]);
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let cache: KindCacheStore<'_, _, RecordingRedis> = KindCacheStore {
        mysql: &mysql,
        redis: Some(&redis),
        erp: None,
        resolvers: None,
    };
    let team = json!({"spec": {"members": [
        {"botRef": {"namespace": NS, "name": "late-bot"}}
    ]}});
    let reads = late_bot_reads(&cache, &[900_002], &team, 6510);

    // The subtask Bot row is absent, so `_get_first_bot` resolves it here and
    // the late chain re-reads the Ghost.
    let bot = late_subtask_bot(&reads).await.expect("bot").expect("bot");
    assert_eq!(bot.id, 900_003);
    let merged = late_ghost_capabilities(&reads, &bot).await.expect("chain");
    assert_eq!(merged.skills, vec!["late-skill".to_string()]);
    assert_eq!(merged.skill_refs["late-skill"]["skill_id"], json!(424_242));
    assert_eq!(
        redis.reads(),
        vec![
            "kind:v2:idx:group:Bot:group/team-ns:late-bot".to_string(),
            "kind:v2:data:Bot:900003".to_string(),
            "kind:v2:idx:group:Ghost:group/team-ns:late-ghost".to_string(),
            "kind:v2:data:Ghost:900004".to_string(),
        ]
    );

    // `_get_bot_skills` compiles exactly the late chain's Skill: its attached
    // read binds the late fixture's skill id.
    let tokens = StubTokens;
    let skills = super::super::get_bot_skills(
        &mysql,
        &merged,
        late_capability_mode(&bot),
        6510,
        None,
        &tokens,
        false,
        "user:6510",
        &binding_context(),
        None,
        false,
    )
    .await
    .expect("skills");
    assert!(skills.skills.is_empty());

    let queries = mysql.queries();
    assert!(
        queries
            .iter()
            .any(|query| query.first_integer == Some(424_242)
                && query.sql.contains("kinds.kind = 'Skill'")),
        "the late chain's Skill must be read: {queries:?}"
    );
    assert!(
        queries
            .iter()
            .all(|query| query.first_integer != Some(111_111)),
        "the initial capabilities must not drive the late compilation: {queries:?}"
    );
}
