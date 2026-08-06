# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis-backed task run counters and current failure indexes."""

import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Iterable, Optional

from redis import Redis
from redis.exceptions import RedisError

from app.core.config import settings
from app.models.subtask import SubtaskStatus

KEY_PREFIX = "task-run-monitor:v1"
UNKNOWN_REASON_ID = "unknown"
MAX_REASON_LENGTH = 512

_UUID_PATTERN = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_LONG_HEX_PATTERN = re.compile(r"\b(?:0x)?[0-9a-fA-F]{12,}\b")
_LONG_NUMBER_PATTERN = re.compile(r"\b\d{6,}\b")

_SYNC_FAILURE_SCRIPT = """
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
"""


class TaskRunMetricsUnavailable(RuntimeError):
    """Raised when Redis task run metrics cannot be read."""


@dataclass(frozen=True)
class TaskRunMetricEvent:
    """Committed subtask state used to update Redis idempotently."""

    subtask_id: int
    created_at: datetime
    status: SubtaskStatus
    status_changed_at: datetime
    error_message: Optional[str]
    record_total: bool = False
    sync_failure: bool = False


@dataclass(frozen=True)
class TaskRunFailureMetric:
    """Failure reason aggregate read from Redis."""

    reason_id: str
    reason: Optional[str]
    count: int


@dataclass(frozen=True)
class TaskRunMetricWindow:
    """Aggregate task run metrics for a requested time window."""

    total_runs: int
    failed_runs: int
    failure_reasons: list[TaskRunFailureMetric]
    recent_failure_ids: list[int]
    data_as_of: Optional[datetime]


@dataclass(frozen=True)
class _BucketReference:
    granularity: str
    token: str
    day_token: str


class TaskRunMetricsStore:
    """Store approximate totals and exact current failure aggregates in Redis."""

    def __init__(
        self,
        redis_url: str = settings.REDIS_URL,
        *,
        retention_days: int = settings.TASK_RUN_METRICS_RETENTION_DAYS,
        key_prefix: str = KEY_PREFIX,
        client: Optional[Redis] = None,
    ) -> None:
        self._retention_seconds = retention_days * 24 * 60 * 60
        self._key_prefix = key_prefix
        self._client = client or Redis.from_url(
            redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_timeout=1.0,
            socket_connect_timeout=0.5,
            health_check_interval=30,
        )
        self._sync_failure = self._client.register_script(_SYNC_FAILURE_SCRIPT)

    def record_events(self, events: Iterable[TaskRunMetricEvent]) -> None:
        """Apply committed subtask events to Redis in one pipeline."""
        event_list = list(events)
        if not event_list:
            return

        total_members: dict[str, list[str]] = defaultdict(list)
        for event in event_list:
            if not event.record_total:
                continue
            member = str(event.subtask_id)
            total_members[self._total_hour_key(event.created_at)].append(member)
            total_members[self._total_day_key(event.created_at)].append(member)

        now_timestamp = str(datetime.now().timestamp())
        try:
            pipeline = self._client.pipeline(transaction=False)
            for key, members in total_members.items():
                pipeline.pfadd(key, *members)
                pipeline.expire(key, self._retention_seconds)

            for event in event_list:
                if event.sync_failure:
                    self._queue_failure_sync(pipeline, event, now_timestamp)

            if total_members:
                pipeline.set(
                    self._as_of_key(),
                    now_timestamp,
                    ex=self._retention_seconds,
                )
            pipeline.execute()
        except RedisError as exc:
            raise TaskRunMetricsUnavailable(
                "Redis task run metrics write failed"
            ) from exc

    def load_window(
        self,
        window_start: datetime,
        window_end: datetime,
        *,
        failure_reason_limit: int,
        recent_failure_limit: int,
    ) -> TaskRunMetricWindow:
        """Read a bounded aggregate without scanning MySQL subtasks."""
        buckets = _select_buckets(window_start, window_end)
        total_keys = [self._total_key(bucket) for bucket in buckets]
        summary_keys = [self._failure_summary_key(bucket) for bucket in buckets]
        recent_keys = [self._failure_recent_key(bucket) for bucket in buckets]
        day_tokens = sorted({bucket.day_token for bucket in buckets})

        try:
            total_runs = int(self._client.pfcount(*total_keys)) if total_keys else 0
            pipeline = self._client.pipeline(transaction=False)
            for key in summary_keys:
                pipeline.hgetall(key)
            for key in recent_keys:
                pipeline.zrevrange(key, 0, recent_failure_limit - 1, withscores=True)
            for day_token in day_tokens:
                pipeline.hgetall(self._reason_labels_key(day_token))
            pipeline.get(self._as_of_key())
            results = pipeline.execute()
        except RedisError as exc:
            raise TaskRunMetricsUnavailable(
                "Redis task run metrics read failed"
            ) from exc

        summary_end = len(summary_keys)
        recent_end = summary_end + len(recent_keys)
        label_end = recent_end + len(day_tokens)
        summaries = results[:summary_end]
        recent_rows = results[summary_end:recent_end]
        label_rows = results[recent_end:label_end]
        as_of_value = results[label_end]

        labels = _merge_reason_labels(label_rows)
        failed_runs, reason_counts = _merge_failure_summaries(summaries)
        failure_reasons = [
            TaskRunFailureMetric(
                reason_id=reason_id,
                reason=labels.get(reason_id) or None,
                count=count,
            )
            for reason_id, count in sorted(
                reason_counts.items(), key=lambda item: item[1], reverse=True
            )[:failure_reason_limit]
        ]
        return TaskRunMetricWindow(
            total_runs=total_runs,
            failed_runs=failed_runs,
            failure_reasons=failure_reasons,
            recent_failure_ids=_merge_recent_failure_ids(
                recent_rows, recent_failure_limit
            ),
            data_as_of=_timestamp_to_datetime(as_of_value),
        )

    def get_cursor(self, name: str) -> Optional[str]:
        """Return a reconciliation cursor."""
        try:
            return self._client.get(self._cursor_key(name))
        except RedisError as exc:
            raise TaskRunMetricsUnavailable("Redis metric cursor read failed") from exc

    def set_cursor(self, name: str, value: str) -> None:
        """Persist a reconciliation cursor after a successful Redis update."""
        try:
            self._client.set(self._cursor_key(name), value)
        except RedisError as exc:
            raise TaskRunMetricsUnavailable("Redis metric cursor write failed") from exc

    def acquire_reconcile_lock(self, token: str, expire_seconds: int) -> bool:
        """Acquire the cross-process reconciliation lock."""
        try:
            return bool(
                self._client.set(
                    self._reconcile_lock_key(), token, nx=True, ex=expire_seconds
                )
            )
        except RedisError as exc:
            raise TaskRunMetricsUnavailable("Redis metric lock failed") from exc

    def release_reconcile_lock(self, token: str) -> None:
        """Release a reconciliation lock only when the caller still owns it."""
        script = (
            "if redis.call('GET', KEYS[1]) == ARGV[1] then "
            "return redis.call('DEL', KEYS[1]) else return 0 end"
        )
        try:
            self._client.eval(script, 1, self._reconcile_lock_key(), token)
        except RedisError as exc:
            raise TaskRunMetricsUnavailable("Redis metric unlock failed") from exc

    def _queue_failure_sync(
        self, pipeline, event: TaskRunMetricEvent, now_timestamp: str
    ) -> None:
        reason = normalize_failure_reason(event.error_message)
        reason_id = failure_reason_id(reason)
        desired_failed = event.status == SubtaskStatus.FAILED
        changed_at_us = int(event.status_changed_at.timestamp() * 1_000_000)
        state = json.dumps(
            {
                "failed": desired_failed,
                "reason_id": reason_id if desired_failed else "",
                "changed_at_us": changed_at_us,
            },
            separators=(",", ":"),
        )
        bucket = _hour_bucket(event.created_at)
        day_token = _day_token(event.created_at)
        self._sync_failure(
            keys=[
                self._failure_state_key(day_token),
                self._failure_summary_key(bucket),
                self._failure_summary_key(
                    _BucketReference("day", day_token, day_token)
                ),
                self._failure_recent_key(bucket),
                self._failure_recent_key(_BucketReference("day", day_token, day_token)),
                self._reason_labels_key(day_token),
                self._as_of_key(),
            ],
            args=[
                event.subtask_id,
                "1" if desired_failed else "0",
                reason_id,
                reason or "",
                event.status_changed_at.timestamp(),
                changed_at_us,
                state,
                self._retention_seconds,
                now_timestamp,
            ],
            client=pipeline,
        )

    def _total_key(self, bucket: _BucketReference) -> str:
        return f"{self._key_prefix}:total:{bucket.granularity}:{bucket.token}"

    def _total_hour_key(self, value: datetime) -> str:
        return self._total_key(_hour_bucket(value))

    def _total_day_key(self, value: datetime) -> str:
        token = _day_token(value)
        return self._total_key(_BucketReference("day", token, token))

    def _failure_summary_key(self, bucket: _BucketReference) -> str:
        return f"{self._key_prefix}:failed:{bucket.granularity}:{bucket.token}"

    def _failure_recent_key(self, bucket: _BucketReference) -> str:
        return f"{self._key_prefix}:failed-recent:{bucket.granularity}:{bucket.token}"

    def _failure_state_key(self, day_token: str) -> str:
        return f"{self._key_prefix}:failed-state:{day_token}"

    def _reason_labels_key(self, day_token: str) -> str:
        return f"{self._key_prefix}:failure-reasons:{day_token}"

    def _as_of_key(self) -> str:
        return f"{self._key_prefix}:as-of"

    def _cursor_key(self, name: str) -> str:
        return f"{self._key_prefix}:reconcile-cursor:{name}"

    def _reconcile_lock_key(self) -> str:
        return f"{self._key_prefix}:reconcile-lock"


def normalize_failure_reason(error_message: Optional[str]) -> Optional[str]:
    """Normalize volatile identifiers before aggregating failure messages."""
    if not error_message or not error_message.strip():
        return None
    reason = " ".join(error_message.split())
    reason = _UUID_PATTERN.sub("<uuid>", reason)
    reason = _LONG_HEX_PATTERN.sub("<hex>", reason)
    reason = _LONG_NUMBER_PATTERN.sub("<number>", reason)
    return reason[:MAX_REASON_LENGTH]


def failure_reason_id(reason: Optional[str]) -> str:
    """Return a compact stable identifier for a normalized failure reason."""
    if reason is None:
        return UNKNOWN_REASON_ID
    return hashlib.sha256(reason.encode("utf-8")).hexdigest()[:16]


def _select_buckets(
    window_start: datetime, window_end: datetime
) -> list[_BucketReference]:
    buckets: list[_BucketReference] = []
    current_day = window_start.date()
    while current_day <= window_end.date():
        day_start = datetime.combine(current_day, time.min)
        day_end = day_start + timedelta(days=1)
        day_token = day_start.strftime("%Y%m%d")
        if day_start >= window_start and day_end <= window_end:
            buckets.append(_BucketReference("day", day_token, day_token))
        else:
            hour_start = day_start
            while hour_start < day_end:
                hour_end = hour_start + timedelta(hours=1)
                if hour_start < window_end and hour_end > window_start:
                    buckets.append(_hour_bucket(hour_start))
                hour_start = hour_end
        current_day += timedelta(days=1)
    return buckets


def _hour_bucket(value: datetime) -> _BucketReference:
    return _BucketReference("hour", value.strftime("%Y%m%d%H"), _day_token(value))


def _day_token(value: datetime) -> str:
    return value.strftime("%Y%m%d")


def _merge_failure_summaries(
    summaries: Iterable[dict[str, str]],
) -> tuple[int, dict[str, int]]:
    failed_runs = 0
    reason_counts: dict[str, int] = defaultdict(int)
    for summary in summaries:
        failed_runs += int(summary.get("total", 0))
        for field, raw_count in summary.items():
            count = int(raw_count)
            if field.startswith("reason:") and count > 0:
                reason_counts[field.removeprefix("reason:")] += count
    return failed_runs, dict(reason_counts)


def _merge_reason_labels(label_rows: Iterable[dict[str, str]]) -> dict[str, str]:
    labels: dict[str, str] = {}
    for row in label_rows:
        labels.update(row)
    return labels


def _merge_recent_failure_ids(
    recent_rows: Iterable[list[tuple[str, float]]], limit: int
) -> list[int]:
    newest_score_by_id: dict[int, float] = {}
    for row in recent_rows:
        for raw_subtask_id, score in row:
            subtask_id = int(raw_subtask_id)
            newest_score_by_id[subtask_id] = max(
                score, newest_score_by_id.get(subtask_id, float("-inf"))
            )
    return [
        subtask_id
        for subtask_id, _ in sorted(
            newest_score_by_id.items(), key=lambda item: item[1], reverse=True
        )[:limit]
    ]


def _timestamp_to_datetime(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    return datetime.fromtimestamp(float(value))


task_run_metrics_store = TaskRunMetricsStore()
