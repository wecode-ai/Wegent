// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/task_run_metrics.py` and `app/services/task_run_metric_hooks.py`.
//!
//! The source registers SQLAlchemy session listeners on `SessionLocal` during
//! startup (`app/main.py:362-364`). `TaskRunMetricHooks._before_flush` records
//! the moment and the committed state of every assistant subtask the session
//! touched, `_after_flush_postexec` keeps the pending event, and `_after_commit`
//! hands it to `TaskRunMetricsStore.record_events`. That store writes the
//! approximate run totals and the exact current failure aggregates under
//! `task-run-monitor:v2` with `_SYNC_FAILURE_SCRIPT`; redis-py's pipeline checks
//! the server script cache first (`SCRIPT EXISTS`, and `SCRIPT LOAD` for a digest
//! the server lost) before it queues the `EVALSHA`, so one committed
//! assistant-subtask mutation emits exactly that pair.
//!
//! The listeners are application-wide, so every migrated flow that commits an
//! assistant-subtask mutation reproduces the same Redis commands by calling
//! [`record_events`] with the committed row's state. `_after_commit` logs and
//! swallows a store failure, so a Redis error never changes the caller's
//! committed result; callers keep that contract.

use brz_redis::{Redis, RedisResult, SetExpiration, SetOptions, cmd};
use chrono::{Local, LocalResult, NaiveDateTime};
use serde_json::Value;

/// `task_run_metrics.KEY_PREFIX`.
pub(crate) const KEY_PREFIX: &str = "task-run-monitor:v2";

/// `settings.TASK_RUN_METRICS_RETENTION_DAYS`' default, in days.
const DEFAULT_RETENTION_DAYS: i64 = 32;

/// `task_run_metrics.MAX_REASON_LENGTH`.
const MAX_REASON_LENGTH: usize = 512;

/// `task_run_metrics.UNKNOWN_REASON_ID`.
const UNKNOWN_REASON_ID: &str = "unknown";

/// `task_run_metrics._GENERIC_FAILURE_MESSAGES`.
const GENERIC_FAILURE_MESSAGES: [&str; 4] = [
    "execution failed",
    "task failed",
    "task failed with status: failed",
    "unknown error",
];

/// `task_run_metrics._SYNC_FAILURE_SCRIPT`, byte for byte as `register_script`
/// hashes it for `SCRIPT EXISTS`/`SCRIPT LOAD`.
const SYNC_FAILURE_SCRIPT: &str = r#"
local raw_state = redis.call('HGET', KEYS[1], ARGV[1])
local old_state = nil
if raw_state then
    old_state = cjson.decode(raw_state)
end

local incoming_changed_at = tonumber(ARGV[6])
if old_state and tonumber(old_state.changed_at_us or 0) > incoming_changed_at then
    return 0
end

local desired_failed = ARGV[2] == '1'
local old_failed = old_state and old_state.failed == true
local old_reason_id = old_failed and old_state.reason_id or nil
local new_reason_id = ARGV[3]

local function change_count(key, field, amount)
    local value = redis.call('HINCRBY', key, field, amount)
    if value < 0 then
        redis.call('HSET', key, field, 0)
    end
end

if old_failed and not desired_failed then
    change_count(KEYS[2], 'total', -1)
    change_count(KEYS[3], 'total', -1)
    change_count(KEYS[2], 'reason:' .. old_reason_id, -1)
    change_count(KEYS[3], 'reason:' .. old_reason_id, -1)
    redis.call('ZREM', KEYS[4], ARGV[1])
    redis.call('ZREM', KEYS[5], ARGV[1])
elseif not old_failed and desired_failed then
    change_count(KEYS[2], 'total', 1)
    change_count(KEYS[3], 'total', 1)
    change_count(KEYS[2], 'reason:' .. new_reason_id, 1)
    change_count(KEYS[3], 'reason:' .. new_reason_id, 1)
elseif old_failed and desired_failed and old_reason_id ~= new_reason_id then
    change_count(KEYS[2], 'reason:' .. old_reason_id, -1)
    change_count(KEYS[3], 'reason:' .. old_reason_id, -1)
    change_count(KEYS[2], 'reason:' .. new_reason_id, 1)
    change_count(KEYS[3], 'reason:' .. new_reason_id, 1)
end

if desired_failed then
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[7])
    redis.call('HSET', KEYS[6], new_reason_id, ARGV[4])
    redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])
    redis.call('ZADD', KEYS[5], ARGV[5], ARGV[1])
elseif old_state then
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[7])
end

if desired_failed or old_state then
    for index = 1, 6 do
        redis.call('EXPIRE', KEYS[index], ARGV[8])
    end
    redis.call('SET', KEYS[7], ARGV[9], 'EX', ARGV[8])
end

return 1
"#;

/// One `TaskRunMetricEvent` (`app/services/task_run_metrics.py:104-118`).
pub(crate) struct SubtaskMetricEvent {
    /// The committed assistant subtask's id.
    pub(crate) subtask_id: i64,
    /// The committed row's `created_at`, which selects the hour/day buckets.
    pub(crate) created_at: NaiveDateTime,
    /// `status == SubtaskStatus.FAILED`.
    pub(crate) failed: bool,
    /// `_before_flush`'s `datetime.now()`.
    pub(crate) state_changed_at: NaiveDateTime,
    /// `task_run_failure_message(error_message, result)`.
    pub(crate) message: Option<String>,
    /// A newly inserted assistant subtask records its id in the totals.
    pub(crate) record_total: bool,
    /// A new failed subtask, or a status/role/error change on an assistant
    /// subtask, syncs the failure aggregates.
    pub(crate) sync_failure: bool,
}

/// `TaskRunMetricsStore.record_events`.
pub(crate) async fn record_events<R: Redis>(
    redis: &R,
    events: &[SubtaskMetricEvent],
) -> RedisResult<()> {
    if events.is_empty() {
        return Ok(());
    }
    let retention_seconds = retention_seconds();
    // `total_members`: one ordered entry per bucket key; members append per
    // event like the source's `defaultdict(list)`.
    let mut totals: Vec<(String, Vec<String>)> = Vec::new();
    for event in events.iter().filter(|event| event.record_total) {
        let member = event.subtask_id.to_string();
        let keys = [
            total_key("hour", &hour_token(event.created_at)),
            total_key("day", &day_token(event.created_at)),
        ];
        for key in keys {
            match totals.iter_mut().find(|(existing, _)| *existing == key) {
                Some((_, members)) => members.push(member.clone()),
                None => totals.push((key, vec![member.clone()])),
            }
        }
    }
    let now_timestamp = python_float_str(local_epoch_seconds(now_local()));
    for (key, members) in &totals {
        redis.pfadd(key.as_str(), members.as_slice()).await?;
        redis
            .expire(key.as_str(), seconds(retention_seconds))
            .await?;
    }
    for event in events.iter().filter(|event| event.sync_failure) {
        sync_failure(redis, event, &now_timestamp, retention_seconds).await?;
    }
    if !totals.is_empty() {
        redis
            .set_with(
                as_of_key(),
                now_timestamp.as_str(),
                SetOptions::default()
                    .with_expiration(SetExpiration::Seconds(seconds(retention_seconds))),
            )
            .await?;
    }
    Ok(())
}

/// `TaskRunMetricHooks._before_flush`/`_after_commit` for a **new** assistant
/// subtask (`app/services/task_run_metric_hooks.py:72-84,155-171`): the id
/// joins the hour/day run totals, while a new non-failed subtask does not sync
/// the failure aggregates.
pub(crate) async fn record_inserted_assistant_subtask<R: Redis>(
    redis: &R,
    subtask_id: i64,
    created_at: NaiveDateTime,
) -> RedisResult<()> {
    let event = SubtaskMetricEvent {
        subtask_id,
        created_at,
        failed: false,
        state_changed_at: now_local(),
        message: None,
        record_total: true,
        sync_failure: false,
    };
    record_events(redis, std::slice::from_ref(&event)).await
}

/// `TaskRunMetricsStore._queue_failure_sync` plus the pipeline's script cache
/// check.
async fn sync_failure<R: Redis>(
    redis: &R,
    event: &SubtaskMetricEvent,
    now_timestamp: &str,
    retention_seconds: i64,
) -> RedisResult<()> {
    let reason = normalize_failure_reason(event.message.as_deref());
    let reason_id = failure_reason_id(reason.as_deref());
    let changed_at_us = local_epoch_micros(event.state_changed_at);
    let state = compact_state_json(event.failed, &reason_id, changed_at_us);
    let arguments = [
        event.subtask_id.to_string(),
        (if event.failed { "1" } else { "0" }).to_string(),
        reason_id,
        reason.unwrap_or_default(),
        python_float_str(local_epoch_seconds(event.state_changed_at)),
        changed_at_us.to_string(),
        state,
        retention_seconds.to_string(),
        now_timestamp.to_string(),
    ];
    // `redis.client.Pipeline.load_scripts`: one `SCRIPT EXISTS` probe for the
    // queued script, then `SCRIPT LOAD` when the server lost that digest.
    let digest = sync_failure_sha1().to_string();
    let mut probe = cmd("SCRIPT");
    probe.arg("EXISTS").arg(digest.as_str());
    let exists: Vec<i64> = redis.command(probe).await?;
    let digest: String = if exists.iter().all(|present| *present == 1) {
        digest
    } else {
        let mut load = cmd("SCRIPT");
        load.arg("LOAD").arg(SYNC_FAILURE_SCRIPT);
        redis.command(load).await?
    };
    let _: i64 = redis
        .evalsha(
            digest.as_str(),
            failure_sync_keys(event.created_at).as_slice(),
            arguments.as_slice(),
        )
        .await?;
    Ok(())
}

/// `failure_reason_id`: `sha256(reason).hexdigest()[:16]`.
pub(crate) fn failure_reason_id(reason: Option<&str>) -> String {
    let Some(reason) = reason else {
        return UNKNOWN_REASON_ID.to_string();
    };
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(reason.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `_queue_failure_sync`'s `json.dumps({...}, separators=(",", ":"))` state
/// document, whose `reason_id` is empty unless the subtask is failed.
fn compact_state_json(failed: bool, reason_id: &str, changed_at_us: i64) -> String {
    format!(
        "{{\"failed\":{},\"reason_id\":\"{}\",\"changed_at_us\":{changed_at_us}}}",
        if failed { "true" } else { "false" },
        if failed { reason_id } else { "" }
    )
}

/// `_failure_state_key`.
fn failure_state_key(day: &str) -> String {
    format!("{KEY_PREFIX}:failed-state:{day}")
}

/// `_failure_summary_key`.
fn failure_summary_key(granularity: &str, token: &str) -> String {
    format!("{KEY_PREFIX}:failed:{granularity}:{token}")
}

/// `_failure_recent_key`.
fn failure_recent_key(granularity: &str, token: &str) -> String {
    format!("{KEY_PREFIX}:failed-recent:{granularity}:{token}")
}

/// `_total_key`.
fn total_key(granularity: &str, token: &str) -> String {
    format!("{KEY_PREFIX}:total:{granularity}:{token}")
}

/// `_queue_failure_sync`'s seven keys, in the source's order.
fn failure_sync_keys(created_at: NaiveDateTime) -> Vec<String> {
    let hour = hour_token(created_at);
    let day = day_token(created_at);
    vec![
        failure_state_key(&day),
        failure_summary_key("hour", &hour),
        failure_summary_key("day", &day),
        failure_recent_key("hour", &hour),
        failure_recent_key("day", &day),
        reason_labels_key(&day),
        as_of_key(),
    ]
}

/// `_reason_labels_key`.
fn reason_labels_key(day: &str) -> String {
    format!("{KEY_PREFIX}:failure-reasons:{day}")
}

/// `_as_of_key`.
fn as_of_key() -> String {
    format!("{KEY_PREFIX}:as-of")
}

/// `_hour_bucket`'s token: `%Y%m%d%H` on the source's local clock.
fn hour_token(value: NaiveDateTime) -> String {
    value.format("%Y%m%d%H").to_string()
}

/// `_day_token`: `%Y%m%d` on the source's local clock.
fn day_token(value: NaiveDateTime) -> String {
    value.format("%Y%m%d").to_string()
}

/// `task_run_failure_message(error_message, result)`.
pub(crate) fn failure_message(
    error_message: Option<&str>,
    result: Option<&Value>,
) -> Option<String> {
    let raw_message = error_message.unwrap_or_default().trim();
    if let Some(jsonl_error) = jsonl_result_error(raw_message) {
        return Some(jsonl_error);
    }
    let result_error = result_error_message(result);
    if let Some(message) = result_error.as_ref()
        && (raw_message.is_empty()
            || GENERIC_FAILURE_MESSAGES.contains(&raw_message.to_lowercase().as_str()))
    {
        return Some(message.clone());
    }
    if raw_message.is_empty() {
        result_error
    } else {
        Some(raw_message.to_string())
    }
}

/// `_extract_jsonl_result_error`: the actionable error of a JSONL executor
/// message, which is reported only when its last `result` line is an error.
fn jsonl_result_error(raw_message: &str) -> Option<String> {
    if !raw_message.starts_with('{') {
        return None;
    }
    for line in raw_message.lines().rev() {
        let Ok(Value::Object(value)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("result") {
            continue;
        }
        if value.get("is_error") != Some(&Value::Bool(true)) {
            return None;
        }
        return message_field(&value, &["result", "message"]);
    }
    None
}

/// `_result_error_message`: the first actionable string of a result document.
fn result_error_message(result: Option<&Value>) -> Option<String> {
    let Some(Value::Object(result)) = result else {
        return None;
    };
    message_field(result, &["error_message", "error", "message", "value"])
}

/// The first non-blank string among `fields`, trimmed like the source.
fn message_field(object: &serde_json::Map<String, Value>, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        object
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

/// `normalize_failure_reason`: collapse whitespace, replace volatile
/// identifiers, then keep the first `MAX_REASON_LENGTH` characters.
pub(crate) fn normalize_failure_reason(message: Option<&str>) -> Option<String> {
    let message = message?;
    if message.trim().is_empty() {
        return None;
    }
    let collapsed = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = substitute(&collapsed, uuid_match_at, "<uuid>");
    let text = substitute(&text, hex_match_at, "<hex>");
    let text = substitute(&text, number_match_at, "<number>");
    Some(text.chars().take(MAX_REASON_LENGTH).collect())
}

/// `re.sub` with one of the module's bounded identifier patterns.
fn substitute(text: &str, find: fn(&[char], usize) -> Option<usize>, replacement: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        match find(&chars, index) {
            Some(end) => {
                out.push_str(replacement);
                index = end;
            }
            None => {
                out.push(chars[index]);
                index += 1;
            }
        }
    }
    out
}

/// `\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`.
fn uuid_match_at(chars: &[char], start: usize) -> Option<usize> {
    if !left_bounded(chars, start) {
        return None;
    }
    let mut index = start;
    for (length, dashed) in [(8, true), (4, true), (4, true), (4, true), (12, false)] {
        for _ in 0..length {
            if !chars
                .get(index)
                .copied()
                .is_some_and(|ch| ch.is_ascii_hexdigit())
            {
                return None;
            }
            index += 1;
        }
        if dashed {
            if chars.get(index).copied() != Some('-') {
                return None;
            }
            index += 1;
        }
    }
    right_bounded(chars, index).then_some(index)
}

/// `\b(?:0x)?[0-9a-fA-F]{12,}\b`.
fn hex_match_at(chars: &[char], start: usize) -> Option<usize> {
    if !left_bounded(chars, start) {
        return None;
    }
    for prefixed in [true, false] {
        let mut index = start;
        if prefixed {
            if chars.get(index).copied() != Some('0') || chars.get(index + 1).copied() != Some('x')
            {
                continue;
            }
            index += 2;
        }
        let first_digit = index;
        while chars
            .get(index)
            .copied()
            .is_some_and(|ch| ch.is_ascii_hexdigit())
        {
            index += 1;
        }
        if index - first_digit >= 12 && right_bounded(chars, index) {
            return Some(index);
        }
    }
    None
}

/// `\b\d{6,}\b`. Python's `\d` selects decimal digits; `char::is_numeric`
/// covers the numeric categories, so only non-decimal numerics inside a digit
/// run can extend a match.
fn number_match_at(chars: &[char], start: usize) -> Option<usize> {
    if !left_bounded(chars, start) {
        return None;
    }
    let mut index = start;
    while chars.get(index).copied().is_some_and(char::is_numeric) {
        index += 1;
    }
    (index - start >= 6 && right_bounded(chars, index)).then_some(index)
}

/// Python's `\w`: the underscore plus alphanumeric characters.
fn python_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// `\b` before a match that starts with a word character.
fn left_bounded(chars: &[char], start: usize) -> bool {
    start == 0 || !python_word_char(chars[start - 1])
}

/// `\b` after a match that ends with a word character.
fn right_bounded(chars: &[char], end: usize) -> bool {
    end >= chars.len() || !python_word_char(chars[end])
}

/// `hashlib.sha1(script).hexdigest()`: the digest `register_script` pins and
/// `Pipeline.load_scripts` probes.
pub(crate) fn sync_failure_sha1() -> &'static str {
    static DIGEST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DIGEST.get_or_init(|| {
        use sha1::{Digest, Sha1};
        let mut hasher = Sha1::new();
        hasher.update(SYNC_FAILURE_SCRIPT.as_bytes());
        format!("{:x}", hasher.finalize())
    })
}

/// `settings.TASK_RUN_METRICS_RETENTION_DAYS` (default 32) in seconds.
fn retention_seconds() -> i64 {
    crate::config::optional_env_or_dotenv("TASK_RUN_METRICS_RETENTION_DAYS")
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS)
        .saturating_mul(24 * 60 * 60)
}

/// A non-negative Redis expiry for a configured retention.
fn seconds(value: i64) -> u64 {
    value.max(0) as u64
}

/// `datetime.now()` on the process-local clock.
fn now_local() -> NaiveDateTime {
    Local::now().naive_local()
}

/// `naive_local.timestamp()`: the epoch seconds of a naive local value.
fn local_epoch_seconds(value: NaiveDateTime) -> f64 {
    local_epoch_micros(value) as f64 / 1_000_000.0
}

/// `naive_local.timestamp() * 1_000_000` truncated like the source's `int()`.
fn local_epoch_micros(value: NaiveDateTime) -> i64 {
    match value.and_local_timezone(Local) {
        LocalResult::Single(instant) => instant.timestamp_micros(),
        LocalResult::Ambiguous(earliest, _) => earliest.timestamp_micros(),
        // A local time the zone skips: keep the source's wall clock, read as UTC.
        LocalResult::None => value.and_utc().timestamp_micros(),
    }
}

/// `str(float)`: CPython's shortest round-trip rendering, which keeps the `.0`
/// an integer-valued float carries.
fn python_float_str(value: f64) -> String {
    let text = format!("{value}");
    if text.contains(['.', 'e', 'E']) {
        text
    } else {
        format!("{text}.0")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_redis::{
        Cmd, EncodeRedisArg, EncodeRedisArgs, ErrorKind, FromRedisBulk, FromRedisValue, Redis,
        RedisError, RedisResult, RedisValues, Value as RedisValue,
    };
    use chrono::NaiveDate;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn at(day: u32, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, day)
            .expect("valid date")
            .and_hms_opt(hour, minute, second)
            .expect("valid time")
    }

    /// One captured Redis command: its name and arguments.
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Captured(String, Vec<String>);

    /// A `Redis` implementation that records the script commands a metrics
    /// publish issues and answers `SCRIPT EXISTS` with the configured cache
    /// state. `TaskRunMetricsStore.record_events` only uses `SCRIPT`,
    /// `EVALSHA`, `PFADD`, `EXPIRE` and `SET`, so the remaining required
    /// commands answer the empty result the metrics store never reads.
    #[derive(Clone)]
    struct ScriptCapture {
        commands: Arc<Mutex<Vec<Captured>>>,
        digest_present: bool,
    }

    impl Default for ScriptCapture {
        fn default() -> Self {
            Self {
                commands: Arc::default(),
                digest_present: true,
            }
        }
    }

    impl ScriptCapture {
        /// A server that lost the script, so the pipeline loads it again.
        fn missing_digest() -> Self {
            Self {
                digest_present: false,
                ..Self::default()
            }
        }

        fn captured(&self) -> Vec<Captured> {
            self.commands.lock().expect("capture lock").clone()
        }

        fn record(&self, command: &Cmd) {
            let arguments = (1..command.arg_count())
                .filter_map(|index| {
                    command
                        .arg_at(index)
                        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                })
                .collect();
            self.commands
                .lock()
                .expect("capture lock")
                .push(Captured(command.name().to_string(), arguments));
        }
    }

    impl Redis for ScriptCapture {
        async fn command<R>(&self, command: Cmd) -> RedisResult<R>
        where
            R: FromRedisValue + Send,
        {
            self.record(&command);
            let reply = match command.name().as_ref() {
                // `SCRIPT EXISTS` reports the configured cache state.
                "SCRIPT" if command.arg_at(1).is_some_and(|arg| arg == b"EXISTS") => {
                    RedisValue::Array(vec![RedisValue::Int(if self.digest_present {
                        1
                    } else {
                        0
                    })])
                }
                // `SCRIPT LOAD` answers with the digest it computed.
                "SCRIPT" => RedisValue::SimpleString(sync_failure_sha1().to_string()),
                // The totals branch's `PFADD`/`EXPIRE`/`SET` replies.
                "PFADD" | "EXPIRE" => RedisValue::Int(1),
                "SET" => RedisValue::SimpleString("OK".to_string()),
                _ => RedisValue::Array(vec![RedisValue::Int(1)]),
            };
            R::from_redis_value(&reply)
        }

        async fn evalsha<D, K, A, R>(&self, digest: D, keys: K, arguments: A) -> RedisResult<R>
        where
            D: EncodeRedisArg + Send,
            K: EncodeRedisArgs + Send,
            A: EncodeRedisArgs + Send,
            R: FromRedisValue + Send,
        {
            let mut command = cmd("EVALSHA");
            command.arg_encoded(digest)?;
            command.arg_encoded(keys.num_args())?;
            keys.encode_args(&mut command)?;
            arguments.encode_args(&mut command)?;
            self.record(&command);
            R::from_redis_value(&RedisValue::Int(1))
        }

        async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            Ok(())
        }

        async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Err(RedisError::new(
                ErrorKind::ClientError,
                "the metrics store sends no hash reads",
            ))
        }
    }

    /// `_SYNC_FAILURE_SCRIPT`'s SHA1, as `register_script` pins it and
    /// `Pipeline.load_scripts` probes it.
    #[test]
    fn the_embedded_script_keeps_the_registered_digest() {
        assert_eq!(
            sync_failure_sha1(),
            "75f75be3d11e483c99c83f8b0b8836c2e2c5923b"
        );
    }

    #[test]
    fn failure_reason_ids_follow_the_source_digest() {
        assert_eq!(failure_reason_id(None), "unknown");
        assert_eq!(failure_reason_id(Some("")), "e3b0c44298fc1c14");
        assert_eq!(failure_reason_id(Some("boom")), "81f52337ebb4cb16");
    }

    #[test]
    fn failure_reasons_collapse_whitespace_and_volatile_identifiers() {
        assert_eq!(normalize_failure_reason(None), None);
        assert_eq!(normalize_failure_reason(Some("   \n ")), None);
        assert_eq!(
            normalize_failure_reason(Some("a  b\nc\t d")).as_deref(),
            Some("a b c d")
        );
        assert_eq!(
            normalize_failure_reason(Some(
                "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at 123456 chars aaaaaaaaaaaa end"
            ))
            .as_deref(),
            Some("id <uuid> at <number> chars <hex> end")
        );
        // A digit run shorter than six and a hex run shorter than twelve stay.
        assert_eq!(
            normalize_failure_reason(Some("code 12345 hex abcdef")).as_deref(),
            Some("code 12345 hex abcdef")
        );
        // The bound counts characters, not bytes.
        let long = "é".repeat(600);
        assert_eq!(
            normalize_failure_reason(Some(&long))
                .expect("reason")
                .chars()
                .count(),
            MAX_REASON_LENGTH
        );
    }

    #[test]
    fn failure_messages_prefer_the_actionable_error() {
        let result = json!({"value": "task output", "error_message": "boom"});
        assert_eq!(
            failure_message(None, Some(&result)).as_deref(),
            Some("boom")
        );
        assert_eq!(
            failure_message(Some("unknown error"), Some(&result)).as_deref(),
            Some("boom")
        );
        assert_eq!(
            failure_message(Some("executor died"), Some(&result)).as_deref(),
            Some("executor died")
        );
        assert_eq!(failure_message(None, None), None);
        let jsonl = "{\"type\": \"result\", \"is_error\": true, \"result\": \"line failed\"}";
        assert_eq!(
            failure_message(Some(jsonl), None).as_deref(),
            Some("line failed")
        );
        // A non-error JSONL line yields no actionable error, so the source
        // keeps the raw executor message.
        let ok = "{\"type\": \"result\", \"is_error\": false, \"result\": \"fine\"}";
        assert_eq!(failure_message(Some(ok), None).as_deref(), Some(ok));
    }

    #[test]
    fn failure_sync_keys_follow_the_source_buckets() {
        assert_eq!(
            failure_sync_keys(at(16, 10, 56, 5)),
            vec![
                "task-run-monitor:v2:failed-state:20261016".to_string(),
                "task-run-monitor:v2:failed:hour:2026101610".to_string(),
                "task-run-monitor:v2:failed:day:20261016".to_string(),
                "task-run-monitor:v2:failed-recent:hour:2026101610".to_string(),
                "task-run-monitor:v2:failed-recent:day:20261016".to_string(),
                "task-run-monitor:v2:failure-reasons:20261016".to_string(),
                "task-run-monitor:v2:as-of".to_string(),
            ]
        );
    }

    #[test]
    fn the_state_document_keeps_the_source_field_order() {
        assert_eq!(
            compact_state_json(false, "81f52337ebb4cb16", 1792119365267683),
            "{\"failed\":false,\"reason_id\":\"\",\"changed_at_us\":1792119365267683}"
        );
        assert_eq!(
            compact_state_json(true, "81f52337ebb4cb16", 7),
            "{\"failed\":true,\"reason_id\":\"81f52337ebb4cb16\",\"changed_at_us\":7}"
        );
    }

    #[test]
    fn float_rendering_matches_python_repr() {
        assert_eq!(python_float_str(1792119365.267683), "1792119365.267683");
        assert_eq!(python_float_str(1.0), "1.0");
        assert_eq!(python_float_str(0.5), "0.5");
    }

    /// One committed assistant-subtask status change emits the script cache
    /// probe and the sync, in redis-py's pipeline order, with the source's keys
    /// and arguments.
    #[tokio::test]
    async fn a_committed_subtask_status_change_emits_the_script_pair() {
        let redis = ScriptCapture::default();
        let event = SubtaskMetricEvent {
            subtask_id: 426335633820496,
            created_at: at(16, 10, 56, 4),
            failed: false,
            state_changed_at: at(16, 10, 56, 5),
            message: Some("task output".to_string()),
            record_total: false,
            sync_failure: true,
        };
        record_events(&redis, std::slice::from_ref(&event))
            .await
            .expect("metrics published");

        let captured = redis.captured();
        assert_eq!(captured.len(), 2, "{captured:?}");
        assert_eq!(
            captured[0],
            Captured(
                "SCRIPT".to_string(),
                vec!["EXISTS".to_string(), sync_failure_sha1().to_string()]
            )
        );
        let Captured(name, arguments) = &captured[1];
        assert_eq!(name, "EVALSHA");
        assert_eq!(arguments[0], sync_failure_sha1());
        assert_eq!(arguments[1], "7");
        assert_eq!(
            &arguments[2..9],
            failure_sync_keys(event.created_at).as_slice()
        );
        let argv = &arguments[9..];
        assert_eq!(argv.len(), 9, "{argv:?}");
        assert_eq!(argv[0], "426335633820496");
        assert_eq!(argv[1], "0");
        assert_eq!(argv[2], failure_reason_id(Some("task output")));
        assert_eq!(argv[3], "task output");
        assert_eq!(
            argv[4],
            python_float_str(local_epoch_seconds(event.state_changed_at))
        );
        assert_eq!(
            argv[5],
            local_epoch_micros(event.state_changed_at).to_string()
        );
        assert_eq!(
            argv[6],
            format!(
                "{{\"failed\":false,\"reason_id\":\"\",\"changed_at_us\":{}}}",
                local_epoch_micros(event.state_changed_at)
            )
        );
        assert_eq!(argv[7], retention_seconds().to_string());
        assert!(argv[8].parse::<f64>().is_ok(), "{argv:?}");
    }

    /// A server that lost the script is loaded before the sync runs.
    #[tokio::test]
    async fn a_missing_digest_is_loaded_before_the_sync() {
        let redis = ScriptCapture::missing_digest();
        let event = SubtaskMetricEvent {
            subtask_id: 7,
            created_at: at(16, 10, 56, 4),
            failed: true,
            state_changed_at: at(16, 10, 56, 5),
            message: Some("execution failed".to_string()),
            record_total: false,
            sync_failure: true,
        };
        record_events(&redis, std::slice::from_ref(&event))
            .await
            .expect("metrics published");
        let captured = redis.captured();
        assert_eq!(captured.len(), 3, "{captured:?}");
        assert_eq!(captured[0].0, "SCRIPT");
        assert_eq!(captured[0].1[0], "EXISTS");
        assert_eq!(captured[1].0, "SCRIPT");
        assert_eq!(captured[1].1[0], "LOAD");
        assert_eq!(captured[1].1[1], SYNC_FAILURE_SCRIPT);
        assert_eq!(captured[2].0, "EVALSHA");
        assert_eq!(captured[2].1[0], sync_failure_sha1());
        // digest, numkeys, seven keys, then ARGV[1..9].
        assert_eq!(captured[2].1.len(), 18, "{:?}", captured[2].1);
        assert_eq!(captured[2].1[10], "1");
        assert_eq!(
            captured[2].1[11],
            failure_reason_id(Some("execution failed"))
        );
        assert_eq!(captured[2].1[12], "execution failed");
    }

    #[tokio::test]
    async fn no_events_touch_redis() {
        let redis = ScriptCapture::default();
        record_events(&redis, &[]).await.expect("no events");
        assert!(redis.captured().is_empty());
    }

    /// A newly inserted assistant subtask joins the hour/day run totals:
    /// `_before_flush` marks it `record_total` and a new non-failed row does
    /// not sync the failure aggregates.
    #[tokio::test]
    async fn a_new_assistant_subtask_records_the_run_totals() {
        let redis = ScriptCapture::default();
        record_inserted_assistant_subtask(&redis, 904623193040252, at(20, 15, 1, 11))
            .await
            .expect("metrics published");
        let captured = redis.captured();
        assert_eq!(captured.len(), 5, "{captured:?}");
        assert_eq!(
            captured[0],
            Captured(
                "PFADD".to_string(),
                vec![
                    "task-run-monitor:v2:total:hour:2026102015".to_string(),
                    "904623193040252".to_string(),
                ]
            )
        );
        assert_eq!(
            captured[1],
            Captured(
                "EXPIRE".to_string(),
                vec![
                    "task-run-monitor:v2:total:hour:2026102015".to_string(),
                    retention_seconds().to_string(),
                ]
            )
        );
        assert_eq!(captured[2].0, "PFADD");
        assert_eq!(captured[2].1[0], "task-run-monitor:v2:total:day:20261020");
        assert_eq!(captured[2].1[1], "904623193040252".to_string());
        assert_eq!(captured[3].0, "EXPIRE");
        assert_eq!(captured[3].1[0], "task-run-monitor:v2:total:day:20261020");
        assert_eq!(captured[4].0, "SET");
        assert_eq!(captured[4].1[0], "task-run-monitor:v2:as-of");
    }
}
