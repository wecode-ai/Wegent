// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Terminal session record access.
//!
//! Source: `app/services/device/terminal_session_service.py`
//! (`RedisTerminalSessionStore`, `_TerminalSessionCache|get`/
//! `_load_and_cache`/`_handle_invalidation`, and
//! `RedisTerminalSessionInvalidationListener`) and `terminal_session_record.py`.
//!
//! The backend keeps one exact-key record (`terminal_session:<id>`) that binds a
//! browser terminal to its executor socket. A bounded per-process cache serves
//! `get(refresh=False)` for executor events so they do not re-read Redis; the
//! attach's forced refresh fills it. A process-owned
//! `terminal_session:invalidations` subscription keeps the cache coherent across
//! processes; losing it fails authorization closed, and an epoch guards a
//! refresh that was in flight across a resync.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use brz_redis::{Redis, RedisBytes, RedisMessage, RedisService};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

/// `TERMINAL_SESSION_KEY_PREFIX`.
const TERMINAL_SESSION_KEY_PREFIX: &str = "terminal_session:";
/// `TERMINAL_SESSION_INVALIDATION_CHANNEL`.
const TERMINAL_SESSION_INVALIDATION_CHANNEL: &str = "terminal_session:invalidations";
/// `TERMINAL_SESSION_MAX_LIFETIME_SECONDS`.
const TERMINAL_SESSION_MAX_LIFETIME_SECONDS: u64 = 60 * 60;
/// `TERMINAL_SESSION_ID_MAX_LENGTH`.
const TERMINAL_SESSION_ID_MAX_LENGTH: usize = 256;
/// `TERMINAL_SESSION_CACHE_MAX_ENTRIES`.
const TERMINAL_SESSION_CACHE_MAX_ENTRIES: usize = 32_768;
/// `TERMINAL_SESSION_REVOCATION_MAX_ENTRIES`.
const TERMINAL_SESSION_REVOCATION_MAX_ENTRIES: usize = 32_768;
/// `settings.TERMINAL_SESSION_CACHE_TTL_SECONDS`.
const TERMINAL_SESSION_CACHE_TTL: Duration = Duration::from_secs(5);
/// `TERMINAL_SESSION_INVALIDATION_READY_TIMEOUT_SECONDS`.
const INVALIDATION_READY_TIMEOUT: Duration = Duration::from_secs(5);
/// `TERMINAL_SESSION_INVALIDATION_RECONNECT_MAX_SECONDS`.
const INVALIDATION_RECONNECT_MAX: Duration = Duration::from_secs(5);

/// One cached record with the source's `revalidate_at` deadline.
#[derive(Clone)]
struct CachedRecord {
    record: TerminalRecord,
    revalidate_at: Instant,
}

/// The bounded process-local cache (`_TerminalSessionCache`) plus the listener's
/// coherence flag and authorization epoch (`TerminalSessionService`).
#[derive(Default)]
struct TerminalCache {
    records: HashMap<String, CachedRecord>,
    revoked: HashSet<String>,
    coherent: bool,
    /// `_authorization_epoch`: bumped by every resynchronization.
    epoch: u64,
}

/// The result of one cache lookup performed under the cache lock.
enum Lookup {
    Incoherent,
    Revoked,
    Hit(TerminalRecord),
    Miss,
}

/// The result of committing a completed Redis read under the cache lock.
enum Commit {
    Incoherent,
    Missing,
    EpochChanged,
    Loaded(TerminalRecord),
}

impl TerminalCache {
    /// `get(refresh=False)`'s cache decision, evaluated under one lock: the
    /// coherence, revocation, and freshness checks cannot interleave with an
    /// invalidation. A stale entry is dropped so the caller loads it again.
    fn lookup(&mut self, session_id: &str, allow_cached: bool) -> Lookup {
        if !self.coherent {
            return Lookup::Incoherent;
        }
        if self.revoked.contains(session_id) {
            return Lookup::Revoked;
        }
        if !allow_cached {
            return Lookup::Miss;
        }
        let now = Instant::now();
        let Some(entry) = self.records.get(session_id) else {
            return Lookup::Miss;
        };
        if entry.revalidate_at <= now || entry.record.is_expired(Utc::now()) {
            self.records.remove(session_id);
            return Lookup::Miss;
        }
        Lookup::Hit(entry.record.clone())
    }

    fn is_revoked(&self, session_id: &str) -> bool {
        self.revoked.contains(session_id)
    }

    /// `_load_current_record`'s post-read decision and `_load_and_cache`'s put,
    /// as one locked operation: a revoke, resync, or lost subscription that
    /// landed while the GET was in flight rejects the backfill instead of
    /// resurrecting stale state.
    fn commit_load(
        &mut self,
        session_id: &str,
        record: Option<TerminalRecord>,
        epoch: u64,
    ) -> Commit {
        if self.revoked.contains(session_id) {
            self.records.remove(session_id);
            return Commit::Missing;
        }
        if !self.coherent {
            self.records.remove(session_id);
            return Commit::Incoherent;
        }
        if epoch != self.epoch {
            return Commit::EpochChanged;
        }
        let Some(record) = record.filter(|record| !record.is_expired(Utc::now())) else {
            // Delete-on-refresh-miss: a tombstone, missing key, or expired
            // record must not leave the previous entry cached.
            self.records.remove(session_id);
            return Commit::Missing;
        };
        self.insert(&record);
        Commit::Loaded(record)
    }

    /// `_cache.put` for a successful rebind, guarded so a tombstone/coherence
    /// loss that landed after the EVAL cannot be overwritten.
    fn commit_rebind(&mut self, record: &TerminalRecord) -> bool {
        if !self.coherent || self.revoked.contains(&record.session_id) {
            return false;
        }
        self.insert(record);
        true
    }

    /// `_cache.put`: insert with the authorization TTL.
    fn insert(&mut self, record: &TerminalRecord) {
        if self.records.len() >= TERMINAL_SESSION_CACHE_MAX_ENTRIES {
            self.records.clear();
        }
        self.revoked.remove(&record.session_id);
        self.records.insert(
            record.session_id.clone(),
            CachedRecord {
                record: record.clone(),
                revalidate_at: Instant::now() + TERMINAL_SESSION_CACHE_TTL,
            },
        );
    }

    /// `_cache.invalidate`: drop one record.
    fn remove(&mut self, session_id: &str) {
        self.records.remove(session_id);
    }

    /// `_cache.revoke`: drop the record and remember the tombstone. An overflow
    /// clears all cached state and advances the epoch (`_cache.revoke`'s
    /// `on_revocation_overflow`).
    fn revoke(&mut self, session_id: &str) {
        self.records.remove(session_id);
        if self.revoked.len() >= TERMINAL_SESSION_REVOCATION_MAX_ENTRIES {
            self.revoked.clear();
            self.records.clear();
            self.epoch = self.epoch.wrapping_add(1);
        }
        self.revoked.insert(session_id.to_string());
    }

    /// `_resynchronize`: every cached record predates the resubscription.
    fn resynchronize(&mut self) {
        self.records.clear();
        self.epoch = self.epoch.wrapping_add(1);
    }

    /// `_handle_invalidation`.
    fn handle_invalidation(&mut self, kind: &str, session_id: &str) {
        if kind == "revoke" {
            self.revoke(session_id);
        } else {
            self.remove(session_id);
        }
    }
}

/// The process-wide cache/listener state.
static CACHE: LazyLock<Mutex<TerminalCache>> =
    LazyLock::new(|| Mutex::new(TerminalCache::default()));

fn with_cache<T>(operation: impl FnOnce(&mut TerminalCache) -> T) -> T {
    operation(&mut CACHE.lock().expect("terminal session cache lock"))
}

/// `_is_coherent`: authorization fails closed until the subscription is ready.
pub(crate) fn is_coherent() -> bool {
    with_cache(|cache| cache.coherent)
}

fn set_coherent(coherent: bool) {
    with_cache(|cache| cache.coherent = coherent);
}

/// `_handle_invalidation` for one parsed `kind|session_id` message.
fn handle_invalidation(kind: &str, session_id: &str) {
    with_cache(|cache| cache.handle_invalidation(kind, session_id));
}

/// `_resynchronize`: clear cached state and advance the authentication epoch.
fn resynchronize() {
    with_cache(TerminalCache::resynchronize);
}

/// `get(refresh)`: the source's cache-first load. `redis` may be absent for a
/// pure cache hit; a miss then fails as authorization-unavailable.
pub(crate) async fn get<R: Redis>(
    redis: Option<&R>,
    session_id: &str,
    refresh: bool,
) -> Result<Option<TerminalRecord>, ()> {
    if session_id.is_empty() {
        return Ok(None);
    }
    match with_cache(|cache| cache.lookup(session_id, !refresh)) {
        Lookup::Incoherent => {
            tracing::warn!(
                session_id,
                "terminal authorization unavailable: listener incoherent"
            );
            Err(())
        }
        Lookup::Revoked => Ok(None),
        Lookup::Hit(record) => Ok(Some(record)),
        Lookup::Miss => load_and_cache(redis, session_id).await,
    }
}

/// `_load_current_record` + `_load_and_cache`.
async fn load_and_cache<R: Redis>(
    redis: Option<&R>,
    session_id: &str,
) -> Result<Option<TerminalRecord>, ()> {
    for _ in 0..2 {
        let Some(redis) = redis else {
            return Err(());
        };
        let epoch = with_cache(|cache| cache.epoch);
        let record = read_record(redis, session_id).await?;
        // The revocation/coherence/epoch checks and the backfill share one
        // lock, so an invalidation during the GET cannot be overwritten.
        match with_cache(|cache| cache.commit_load(session_id, record, epoch)) {
            Commit::Loaded(record) => return Ok(Some(record)),
            Commit::Missing => return Ok(None),
            Commit::Incoherent => return Err(()),
            Commit::EpochChanged => {
                // A resync invalidated everything during this read; retry once.
            }
        }
    }
    tracing::warn!(session_id, "terminal authorization changed during lookup");
    Err(())
}

/// `authorize(session_id, user_id, refresh=True)`: one forced refresh, then the
/// owner filter. A failed or missing record is `None`.
pub(crate) async fn authorize<R: Redis>(
    redis: &R,
    session_id: &str,
    user_id: i64,
) -> Result<Option<TerminalRecord>, ()> {
    Ok(get(Some(redis), session_id, true)
        .await?
        .filter(|record| record.user_id == user_id))
}

/// `terminal_session:invalidations` message parsing
/// (`_parse_invalidation_message`).
fn parse_invalidation(message: &RedisMessage) -> Option<(String, String)> {
    let text = std::str::from_utf8(message.payload.as_ref()).ok()?;
    let (kind, session_id) = text.split_once('|')?;
    let session_id = normalize_raw_session_id(session_id);
    if !matches!(kind, "invalidate" | "revoke") || session_id.is_empty() {
        return None;
    }
    Some((kind.to_string(), session_id))
}

/// Start the process-owned invalidation subscription at startup.
///
/// The source subscribes before serving terminal traffic and waits up to five
/// seconds for readiness; a failure leaves authorization fail-closed while a
/// background task keeps retrying.
pub(crate) async fn start_invalidation_listener(redis: RedisService) {
    tokio::spawn(listen_forever(redis));
    let deadline = Instant::now() + INVALIDATION_READY_TIMEOUT;
    while !is_coherent() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !is_coherent() {
        tracing::warn!(
            "terminal session invalidation listener did not become ready during startup; \
             terminal authorization remains fail closed"
        );
    }
}

/// `_listen_forever`: own one subscription per attempt, resynchronize on every
/// (re)subscribe, and fail closed whenever it is not connected.
async fn listen_forever(redis: RedisService) {
    let mut reconnect_delay = Duration::from_millis(100);
    loop {
        set_coherent(false);
        match redis.subscribe(TERMINAL_SESSION_INVALIDATION_CHANNEL).await {
            Ok(mut subscription) => {
                resynchronize();
                set_coherent(true);
                reconnect_delay = Duration::from_millis(100);
                while let Ok(Some(message)) = subscription.next_message().await {
                    if let Some((kind, session_id)) = parse_invalidation(&message) {
                        handle_invalidation(&kind, &session_id);
                    }
                }
                set_coherent(false);
                let _ = subscription.close().await;
                tracing::warn!(
                    "terminal session invalidation listener disconnected; \
                     authorization is failing closed"
                );
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    "terminal session invalidation subscribe failed; authorization is failing closed"
                );
            }
        }
        tokio::time::sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(INVALIDATION_RECONNECT_MAX);
    }
}

/// `_record_key`.
fn record_key(session_id: &str) -> String {
    format!("{TERMINAL_SESSION_KEY_PREFIX}{session_id}")
}

/// `_invalidation_message`.
fn invalidation_message(kind: &str, session_id: &str) -> String {
    format!("{kind}|{session_id}")
}

/// `_get_session_id` plus `normalize_terminal_session_id`: only a bounded
/// `[A-Za-z0-9:_-]+` identifier survives, so it is safe for exact Redis access.
pub(crate) fn normalize_session_id(data: &Value) -> String {
    data.get("session_id")
        .and_then(Value::as_str)
        .map(normalize_raw_session_id)
        .unwrap_or_default()
}

fn normalize_raw_session_id(value: &str) -> String {
    let session_id = value.trim();
    if session_id.is_empty()
        || session_id.len() > TERMINAL_SESSION_ID_MAX_LENGTH
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return String::new();
    }
    session_id.to_owned()
}

/// One backend-owned terminal session record (`TerminalSessionRecord`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalRecord {
    pub session_id: String,
    pub user_id: i64,
    pub device_id: String,
    pub socket_id: String,
    pub project_id: i64,
    pub path: String,
    pub expires_at: Option<DateTime<Utc>>,
}

impl TerminalRecord {
    pub(crate) fn is_expired(&self, now: DateTime<Utc>) -> bool {
        match self.expires_at {
            Some(expires_at) => now >= expires_at,
            None => true,
        }
    }

    /// `TerminalSessionRecord.from_dict`.
    pub(crate) fn from_value(value: &Value) -> Option<Self> {
        let expires_at = value
            .get("expires_at")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
            .map(|value| value.with_timezone(&Utc));
        Some(Self {
            session_id: value.get("session_id")?.as_str()?.to_string(),
            user_id: value.get("user_id")?.as_i64()?,
            device_id: value.get("device_id")?.as_str()?.to_string(),
            socket_id: value.get("socket_id")?.as_str()?.to_string(),
            project_id: value.get("project_id").and_then(Value::as_i64).unwrap_or(0),
            path: value
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            expires_at,
        })
    }
}

/// `terminal_session_service.get`: the exact-key record without the owner
/// filter (used by the source's cache-miss load).
pub(crate) async fn read_record<R: Redis>(
    redis: &R,
    session_id: &str,
) -> Result<Option<TerminalRecord>, ()> {
    match redis.get::<_, RedisBytes>(record_key(session_id)).await {
        Ok(Some(bytes)) if !bytes.as_ref().is_empty() => {
            let Some(value) = serde_json::from_slice::<Value>(bytes.as_ref()).ok() else {
                tracing::error!(session_id, "terminal session record decode failed");
                return Err(());
            };
            if value.get("revoked") == Some(&Value::Bool(true)) {
                return Ok(None);
            }
            let Some(record) = TerminalRecord::from_value(&value) else {
                tracing::error!(session_id, "terminal session record is not an object");
                return Err(());
            };
            Ok(Some(record))
        }
        Ok(_) => Ok(None),
        Err(error) => {
            tracing::warn!(%error, session_id, "terminal session record read failed");
            Err(())
        }
    }
}

/// The source's `TerminalSessionAuthorizationUnavailable` response.
pub(crate) fn authorization_unavailable() -> Value {
    json!({"error": "Terminal session authorization is temporarily unavailable"})
}

/// `RedisTerminalSessionStore.delete`: write the revocation tombstone and
/// publish the invalidation message in one script.
pub(crate) async fn revoke<R: Redis>(redis: &R, session_id: &str) -> Result<(), ()> {
    let result: Result<i64, _> = redis
        .eval(
            REVOKE_SCRIPT,
            [record_key(session_id)],
            [
                "{\"revoked\":true}".to_string(),
                TERMINAL_SESSION_MAX_LIFETIME_SECONDS.to_string(),
                TERMINAL_SESSION_INVALIDATION_CHANNEL.to_string(),
                invalidation_message("revoke", session_id),
            ],
        )
        .await;
    match result {
        // `RedisTerminalSessionStore.delete`: a successful EVAL is the durable
        // revocation even when no invalidation subscriber observed it.
        Ok(_subscriber_count) => {
            // `_cache.revoke` runs only after the durable delete succeeded.
            with_cache(|cache| cache.revoke(session_id));
            Ok(())
        }
        Err(error) => {
            tracing::warn!(%error, session_id, "terminal session revoke failed");
            Err(())
        }
    }
}

/// `is_durably_revoked`: confirm a duplicate terminal exit from the local
/// tombstone or the exact Redis key, revoking the cache when the key reports
/// the tombstone.
pub(crate) async fn is_durably_revoked<R: Redis>(
    redis: Option<&R>,
    session_id: &str,
) -> Result<bool, ()> {
    if session_id.is_empty() {
        return Ok(false);
    }
    if with_cache(|cache| cache.is_revoked(session_id)) {
        return Ok(true);
    }
    let Some(redis) = redis else {
        return Err(());
    };
    match redis.get::<_, RedisBytes>(record_key(session_id)).await {
        Ok(Some(bytes)) => {
            let revoked = serde_json::from_slice::<Value>(bytes.as_ref())
                .ok()
                .and_then(|value| value.get("revoked").cloned())
                == Some(Value::Bool(true));
            if revoked {
                with_cache(|cache| cache.revoke(session_id));
            }
            Ok(revoked)
        }
        Ok(None) => Ok(false),
        Err(error) => {
            tracing::warn!(%error, session_id, "terminal revocation read failed");
            Err(())
        }
    }
}

/// `RedisTerminalSessionStore.rebind_socket`: move the record to the executor's
/// current socket with one atomic script.
pub(crate) async fn rebind<R: Redis>(
    redis: &R,
    record: &TerminalRecord,
    socket_id: &str,
) -> Option<TerminalRecord> {
    if record.session_id.is_empty() || socket_id.is_empty() || !is_coherent() {
        return None;
    }
    let result: Result<Option<RedisBytes>, _> = redis
        .eval(
            REBIND_SCRIPT,
            [record_key(&record.session_id)],
            [
                record.user_id.to_string(),
                record.device_id.clone(),
                socket_id.to_string(),
                TERMINAL_SESSION_INVALIDATION_CHANNEL.to_string(),
                invalidation_message("invalidate", &record.session_id),
            ],
        )
        .await;
    let Ok(Some(bytes)) = result else {
        return None;
    };
    let value = serde_json::from_slice::<Value>(bytes.as_ref()).ok()?;
    let rebound = TerminalRecord::from_value(&value)?;
    // A revoke or coherence loss that landed after the EVAL must not be
    // overwritten by the rebind's backfill.
    if !with_cache(|cache| cache.commit_rebind(&rebound)) {
        return None;
    }
    Some(rebound)
}

/// `REVOKE_TERMINAL_SESSION_SCRIPT`.
const REVOKE_SCRIPT: &str = "\nredis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])\n\
                             return redis.call('PUBLISH', ARGV[3], ARGV[4])\n";
/// `REBIND_TERMINAL_SESSION_SCRIPT`.
const REBIND_SCRIPT: &str = "local payload = redis.call('GET', KEYS[1])\n\
                             if not payload then\n  return nil\nend\n\
                             local record = cjson.decode(payload)\n\
                             if record.revoked == true then\n  return nil\nend\n\
                             if tostring(record.user_id) ~= ARGV[1] or record.device_id ~= ARGV[2] then\n  return nil\nend\n\
                             local ttl = redis.call('PTTL', KEYS[1])\n\
                             if ttl <= 0 then\n  return nil\nend\n\
                             record.socket_id = ARGV[3]\n\
                             local encoded = cjson.encode(record)\n\
                             redis.call('SET', KEYS[1], encoded, 'PX', ttl)\n\
                             redis.call('PUBLISH', ARGV[4], ARGV[5])\n\
                             return encoded\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocation_broadcast_evicts_the_cached_terminal_record() {
        let session_id = "terminal-0-abc_def";
        let message = RedisMessage {
            channel: TERMINAL_SESSION_INVALIDATION_CHANNEL.into(),
            payload: format!("revoke|{session_id}").into(),
        };
        let (kind, id) = parse_invalidation(&message).expect("the wire message is valid");
        assert_eq!(id, session_id);
        let mut cache = coherent_cache();
        let epoch = cache.epoch;
        assert!(matches!(
            cache.commit_load(session_id, Some(record(session_id)), epoch),
            Commit::Loaded(_)
        ));
        cache.handle_invalidation(&kind, &id);
        assert!(matches!(cache.lookup(session_id, true), Lookup::Revoked));
    }

    fn record(session_id: &str) -> TerminalRecord {
        TerminalRecord {
            session_id: session_id.to_string(),
            user_id: 157,
            device_id: "device-1".to_string(),
            socket_id: "socket-1".to_string(),
            project_id: 0,
            path: "/tmp".to_string(),
            expires_at: Some(Utc::now() + chrono::Duration::hours(1)),
        }
    }

    #[test]
    fn the_record_key_prefix_matches_the_source() {
        assert_eq!(
            record_key("terminal-0-_FGERPB8vhs9Qz0LRS1uYA"),
            "terminal_session:terminal-0-_FGERPB8vhs9Qz0LRS1uYA"
        );
    }

    #[test]
    fn session_ids_are_bounded_and_trimmed_like_the_source() {
        assert_eq!(
            normalize_session_id(&json!({"session_id": " terminal-0-abc_def:1 "})),
            "terminal-0-abc_def:1"
        );
        for invalid in [
            json!({}),
            json!({"session_id": ""}),
            json!({"session_id": "bad id"}),
            json!({"session_id": "terminal/1"}),
            json!({"session_id": 7}),
            json!({"session_id": "x".repeat(TERMINAL_SESSION_ID_MAX_LENGTH + 1)}),
        ] {
            assert_eq!(normalize_session_id(&invalid), "", "{invalid}");
        }
    }

    #[test]
    fn a_record_decodes_the_source_fields() {
        let record = TerminalRecord::from_value(&json!({
            "session_id": "terminal-0-abc",
            "user_id": 157,
            "device_id": "device-1",
            "socket_id": "sid-1",
            "project_id": 0,
            "path": "/tmp",
            "expires_at": "2026-11-09T06:13:07.086349+00:00"
        }))
        .expect("a record");
        assert_eq!(record.device_id, "device-1");
        assert_eq!(record.path, "/tmp");
        assert!(record.expires_at.is_some());
        assert!(
            !record.is_expired(
                DateTime::parse_from_rfc3339("2026-11-09T05:13:00+00:00")
                    .unwrap()
                    .with_timezone(&Utc)
            )
        );
    }

    fn coherent_cache() -> TerminalCache {
        TerminalCache {
            coherent: true,
            ..TerminalCache::default()
        }
    }

    /// A foreign-process revoke's invalidation drops the cached record and
    /// leaves a tombstone the load path treats as absent.
    #[test]
    fn a_foreign_revoke_invalidates_the_cached_session() {
        let mut cache = coherent_cache();
        cache.insert(&record("terminal-0-foreign-revoke"));
        assert!(matches!(
            cache.lookup("terminal-0-foreign-revoke", true),
            Lookup::Hit(_)
        ));
        cache.handle_invalidation("revoke", "terminal-0-foreign-revoke");
        assert!(matches!(
            cache.lookup("terminal-0-foreign-revoke", true),
            Lookup::Revoked
        ));
        assert!(cache.is_revoked("terminal-0-foreign-revoke"));
    }

    /// A refresh whose Redis read spans a resync must not write its stale record
    /// back: the epoch captured before the read no longer matches.
    #[test]
    fn an_in_flight_refresh_does_not_write_back_across_a_resync() {
        let mut cache = coherent_cache();
        let in_flight_epoch = cache.epoch;
        cache.resynchronize();
        assert!(matches!(
            cache.commit_load(
                "terminal-0-in-flight",
                Some(record("terminal-0-in-flight")),
                in_flight_epoch
            ),
            Commit::EpochChanged
        ));
        assert!(matches!(
            cache.lookup("terminal-0-in-flight", true),
            Lookup::Miss
        ));
        // The same record committed at the current epoch is accepted.
        let current = cache.epoch;
        assert!(matches!(
            cache.commit_load(
                "terminal-0-current",
                Some(record("terminal-0-current")),
                current
            ),
            Commit::Loaded(_)
        ));
        assert!(matches!(
            cache.lookup("terminal-0-current", true),
            Lookup::Hit(_)
        ));
    }

    /// An external revoke that lands between the GET and its commit must win:
    /// the read result is discarded and the tombstone is not overwritten.
    #[test]
    fn an_external_revoke_before_the_get_commit_rejects_the_backfill() {
        let mut cache = coherent_cache();
        let epoch = cache.epoch;
        // The GET returned a record, then the invalidation listener revoked it.
        cache.handle_invalidation("revoke", "terminal-0-get-race");
        assert!(matches!(
            cache.commit_load(
                "terminal-0-get-race",
                Some(record("terminal-0-get-race")),
                epoch
            ),
            Commit::Missing
        ));
        assert!(matches!(
            cache.lookup("terminal-0-get-race", true),
            Lookup::Revoked
        ));
    }

    /// The same race for a rebind backfill: after the EVAL succeeds, a revoke
    /// must still reject the record instead of resurrecting it.
    #[test]
    fn an_external_revoke_before_the_rebind_commit_is_not_overwritten() {
        let mut cache = coherent_cache();
        cache.handle_invalidation("revoke", "terminal-0-rebind-race");
        assert!(!cache.commit_rebind(&record("terminal-0-rebind-race")));
        assert!(matches!(
            cache.lookup("terminal-0-rebind-race", true),
            Lookup::Revoked
        ));
    }

    /// Losing the invalidation subscription fails every decision closed.
    #[test]
    fn losing_coherence_fails_closed_and_discards_the_read() {
        let mut cache = coherent_cache();
        let epoch = cache.epoch;
        cache.coherent = false;
        assert!(matches!(
            cache.lookup("terminal-0-incoherent", true),
            Lookup::Incoherent
        ));
        assert!(matches!(
            cache.commit_load(
                "terminal-0-incoherent",
                Some(record("terminal-0-incoherent")),
                epoch
            ),
            Commit::Incoherent
        ));
        assert!(!cache.commit_rebind(&record("terminal-0-incoherent")));
    }

    /// A bind invalidation only drops that one session; a revoke tombstone
    /// survives a resync while the cached records do not.
    #[test]
    fn invalidation_kinds_and_resync_match_the_source() {
        let mut cache = coherent_cache();
        cache.insert(&record("terminal-0-bind"));
        cache.insert(&record("terminal-0-keep"));
        cache.handle_invalidation("invalidate", "terminal-0-bind");
        assert!(matches!(
            cache.lookup("terminal-0-bind", true),
            Lookup::Miss
        ));
        assert!(matches!(
            cache.lookup("terminal-0-keep", true),
            Lookup::Hit(_)
        ));
        cache.handle_invalidation("revoke", "terminal-0-keep");
        cache.resynchronize();
        assert!(cache.is_revoked("terminal-0-keep"));
    }
}
