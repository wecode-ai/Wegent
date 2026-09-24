# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ProfileUtil interval logger.

Drains the registry every interval and appends one JSON line per metric to the
profile log, matching the ``brz-metrics`` writer so the existing collection
pipeline consumes Python series unchanged:

    2026-09-20 15:00:00 {"type":"API","name":"/api/v1/responses_2xx",
    "slowThreshold":200,"total_count":3,"error_count":0,"slow_count":0,
    "avg_time":"12.34","interval1":3,"interval2":0,...,"interval5":0}

A fixed ``other://profile_baseline`` sentinel closes every interval so monitors
can confirm the profiler is alive.
"""

from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shared.metrics.metric import MetricSnapshot, _drain
from shared.metrics.registry import get_registry

logger = logging.getLogger(__name__)

PROFILE_LOG_PATH_ENV = "WECODE_METRICS_PROFILE_LOG_PATH"
PROFILE_INTERVAL_ENV = "WECODE_METRICS_PROFILE_INTERVAL_SECONDS"
ENABLED_ENV = "WECODE_METRICS_ENABLED"
DEFAULT_INTERVAL_SECONDS = 30

_SHANGHAI = timezone(timedelta(hours=8))

# ``avg_time`` is a quoted two-decimal string when there is data and the bare
# ``0.0`` number otherwise, matching the Java/brz-metrics writer.
_AVG_TIME_SLOT = "__avg_time__"

# Java's ProfileUtil appends this fixed sentinel after every interval so
# monitors can confirm the profiler is alive; values are constant by design.
_BASELINE_LINE = (
    '{"type":"OTHER","name":"other://profile_baseline","total_count":10,'
    '"error_count":1,"slow_count":1,"avg_time":1.0,"interval1":6,'
    '"interval2":1,"interval3":1,"interval4":1,"interval5":1}'
)

_logger_started = threading.Lock()
_logger_thread: threading.Thread | None = None
_profile_log_path: Path | None = None
_writers: dict[Path, "_HourlyRotatingWriter"] = {}
_writers_lock = threading.Lock()


def profile_log_path() -> Path:
    """Resolve the profile log destination once per process.

    The profile log sits beside the service's info log. Resolution order:
    ``WECODE_METRICS_PROFILE_LOG_PATH`` (explicit), then the directory of
    ``WEGENT_LOG_FILE_PATH`` (executor_manager's info log), then
    ``$LOG_DIR/profile.log`` (backend/chat_shell), then ``logs/profile.log``.
    """
    global _profile_log_path
    if _profile_log_path is not None:
        return _profile_log_path
    configured = os.environ.get(PROFILE_LOG_PATH_ENV, "").strip()
    if configured:
        resolved = Path(configured)
    else:
        info_log = os.environ.get("WEGENT_LOG_FILE_PATH", "").strip()
        if info_log:
            resolved = Path(info_log).parent / "profile.log"
        else:
            log_dir = os.environ.get("LOG_DIR", "").strip()
            if log_dir:
                resolved = Path(log_dir) / "profile.log"
            else:
                resolved = Path("logs") / "profile.log"
    _profile_log_path = resolved
    return resolved


def reset_profile_log_path() -> None:
    """Reset the cached profile path; intended for tests only."""
    global _profile_log_path
    _profile_log_path = None
    with _writers_lock:
        _writers.clear()


def profile_interval_seconds() -> int:
    raw = os.environ.get(PROFILE_INTERVAL_ENV, "").strip()
    try:
        interval = int(raw) if raw else DEFAULT_INTERVAL_SECONDS
    except ValueError:
        logger.warning(
            "[metrics] invalid %s=%r, using default", PROFILE_INTERVAL_ENV, raw
        )
        return DEFAULT_INTERVAL_SECONDS
    return max(interval, 1)


def metrics_enabled() -> bool:
    return os.environ.get(ENABLED_ENV, "").strip().lower() not in {"0", "false", "no"}


def start_profile_logger() -> None:
    """Start the interval drain thread once per process."""
    global _logger_thread
    if not metrics_enabled() or _logger_thread is not None:
        return
    with _logger_started:
        if _logger_thread is not None:
            return
        _logger_thread = threading.Thread(
            target=_run, name="wecode-metrics-profile-log", daemon=True
        )
        _logger_thread.start()


def _run() -> None:
    interval = profile_interval_seconds()
    while True:
        time.sleep(interval)
        try:
            write_profile_once(profile_log_path())
        except OSError as exc:
            logger.warning("[metrics] failed to write profile log: %s", exc)


def write_profile_once(path: Path) -> None:
    """Drain the registry and append one interval of lines to ``path``."""
    timestamp = datetime.now(_SHANGHAI).strftime("%Y-%m-%d %H:%M:%S")
    buffer = io.StringIO()
    for name, metric_type, slot, slow_threshold_ms in get_registry().items():
        effective_threshold = slow_threshold_ms
        if effective_threshold is None:
            effective_threshold = metric_type.policy.slow_threshold_ms
        buffer.write(
            render_entry(
                timestamp,
                metric_type.profile_type,
                name,
                effective_threshold,
                _drain(slot),
            )
        )
    buffer.write(f"{timestamp} {_BASELINE_LINE}\n")
    _writer_for(path).append(buffer.getvalue())


class _HourlyRotatingWriter:
    """Append-only profile writer that rolls over on the natural clock hour.

    Rotated files follow the ``info.log.YYYYMMDD-HH`` convention used by the
    service logs. The rollover and append run under an exclusive file lock so
    concurrent processes sharing one profile log do not corrupt each other.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._active_hour: str | None = None

    def append(self, text: str, *, now: float | None = None) -> None:
        import fcntl

        self._path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = Path(f"{self._path}.lock")
        with open(lock_path, "a", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            hour = time.strftime(
                "%Y%m%d-%H", time.localtime(time.time() if now is None else now)
            )
            if (
                self._active_hour is not None
                and self._active_hour != hour
                and self._path.exists()
            ):
                rotated = Path(f"{self._path}.{self._active_hour}")
                if not rotated.exists():
                    self._path.rename(rotated)
            self._active_hour = hour
            with self._path.open("a", encoding="utf-8") as profile_log:
                profile_log.write(text)


def _writer_for(path: Path) -> "_HourlyRotatingWriter":
    with _writers_lock:
        writer = _writers.get(path)
        if writer is None:
            writer = _HourlyRotatingWriter(path)
            _writers[path] = writer
        return writer


def render_entry(
    timestamp: str,
    metric_type: str,
    name: str,
    slow_threshold_ms: int,
    snapshot: MetricSnapshot,
) -> str:
    """Serialize one drained slot as one ProfileUtil resource line."""
    avg_ms = snapshot.elapsed_ns / snapshot.total / 1_000_000 if snapshot.total else 0
    avg_time = f'"{avg_ms:.2f}"' if snapshot.total else "0.0"
    entry = {
        "type": metric_type,
        "name": name,
        "slowThreshold": slow_threshold_ms,
        "total_count": snapshot.total,
        "error_count": snapshot.failure,
        "slow_count": snapshot.slow,
        "avg_time": _AVG_TIME_SLOT,
        "interval1": snapshot.intervals[0],
        "interval2": snapshot.intervals[1],
        "interval3": snapshot.intervals[2],
        "interval4": snapshot.intervals[3],
        "interval5": snapshot.intervals[4],
    }
    rendered = json.dumps(entry, separators=(",", ":")).replace(
        f'"{_AVG_TIME_SLOT}"', avg_time
    )
    return f"{timestamp} {rendered}\n"
