# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Opt-in, privacy-safe timing diagnostics for the terminal relay."""

import asyncio
import hashlib
import logging
import os
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace
from functools import lru_cache
from typing import Any, Iterator, Mapping, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

TERMINAL_TRACE_LOG_PREFIX = "[TerminalBackendTrace]"
TERMINAL_TRACE_METADATA_KEY = "_wegent_terminal_trace"
TERMINAL_TRACE_VERSION = 1
ALWAYS_SAMPLED_EVENTS = {
    "terminal:attach",
    "terminal:input",
    "terminal:resize",
    "terminal:close",
    "terminal:exit",
}
SAFE_LOG_FIELDS = {
    "approx_queue_ms",
    "authorization_ms",
    "bytes",
    "channel",
    "clock_skew",
    "current_pod",
    "device_id",
    "direction",
    "event",
    "event_loop_lag_age_ms",
    "event_loop_lag_ms",
    "local_enqueue_ms",
    "local_participant_count",
    "manager",
    "parse_ms",
    "pid",
    "protocol_version",
    "publish_ms",
    "queue_bypassed",
    "reason_code",
    "relay_ms",
    "result",
    "sample_reason",
    "sequence",
    "session_hash",
    "session_store_ms",
    "source_pod",
    "stage",
    "subscribers",
    "target_location",
    "target_namespace",
    "target_pod",
    "total_ms",
    "trace_id",
    "version",
    "call_total_ms",
}
SAFE_TEXT_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/-"
)


def _current_pod() -> str:
    return os.environ.get("HOSTNAME", "unknown")


@lru_cache(maxsize=8)
def _parse_target_device_ids(raw: str) -> frozenset[str]:
    return frozenset(
        item.strip() for item in raw.split(",") if item.strip() and item.strip() != "*"
    )


def _target_device_ids() -> frozenset[str]:
    return _parse_target_device_ids(settings.TERMINAL_BACKEND_DIAGNOSTICS_DEVICE_IDS)


def terminal_diagnostics_enabled() -> bool:
    """Return whether this process has at least one exact target device."""
    return bool(_target_device_ids())


def is_target_device(device_id: object) -> bool:
    """Match a device only by its complete ID."""
    return isinstance(device_id, str) and device_id in _target_device_ids()


def _hash_session_id(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:12]


def _deterministically_sample(trace_id: str) -> bool:
    threshold = int(settings.TERMINAL_BACKEND_DIAGNOSTICS_SAMPLE_RATE * (2**64))
    value = int.from_bytes(hashlib.sha256(trace_id.encode()).digest()[:8], "big")
    return value < threshold


@dataclass(frozen=True)
class TerminalTrace:
    """Safe trace context propagated inside the Socket.IO Redis envelope."""

    trace_id: str
    session_hash: str
    device_id: str
    event: str
    direction: str
    sampled: bool
    sample_reason: str
    source_pod: str
    created_wall_ns: int
    protocol_version: Optional[int] = None
    sequence: Optional[int] = None
    byte_count: Optional[int] = None
    published_wall_ns: Optional[int] = None

    def metadata(self, *, published_wall_ns: Optional[int] = None) -> dict[str, Any]:
        """Serialize only allowlisted, non-sensitive trace fields."""
        return {
            "version": TERMINAL_TRACE_VERSION,
            "trace_id": self.trace_id,
            "session_hash": self.session_hash,
            "device_id": self.device_id,
            "event": self.event,
            "direction": self.direction,
            "sampled": self.sampled,
            "sample_reason": self.sample_reason,
            "source_pod": self.source_pod,
            "created_wall_ns": self.created_wall_ns,
            "published_wall_ns": published_wall_ns or self.published_wall_ns,
            "protocol_version": self.protocol_version,
            "sequence": self.sequence,
            "byte_count": self.byte_count,
        }

    @classmethod
    def from_metadata(cls, value: object) -> Optional["TerminalTrace"]:
        """Parse metadata defensively; malformed envelopes remain untraced."""
        if not isinstance(value, Mapping) or value.get("version") != 1:
            return None
        try:
            trace_id = str(value["trace_id"])
            session_hash = str(value["session_hash"])
            device_id = str(value["device_id"])
            event = str(value["event"])
            direction = str(value["direction"])
            source_pod = str(value["source_pod"])
            created_wall_ns = int(value["created_wall_ns"])
            sampled = value["sampled"] is True
            sample_reason = str(value["sample_reason"])
        except (KeyError, TypeError, ValueError):
            return None
        if (
            len(trace_id) != 32
            or len(session_hash) != 12
            or not is_target_device(device_id)
        ):
            return None
        try:
            published_wall_ns = (
                int(value["published_wall_ns"])
                if value.get("published_wall_ns") is not None
                else None
            )
            protocol_version = (
                int(value["protocol_version"])
                if value.get("protocol_version") is not None
                else None
            )
            sequence = (
                int(value["sequence"]) if value.get("sequence") is not None else None
            )
            byte_count = (
                int(value["byte_count"])
                if value.get("byte_count") is not None
                else None
            )
        except (TypeError, ValueError):
            return None
        return cls(
            trace_id=trace_id,
            session_hash=session_hash,
            device_id=device_id,
            event=event,
            direction=direction,
            sampled=sampled,
            sample_reason=sample_reason,
            source_pod=source_pod,
            created_wall_ns=created_wall_ns,
            protocol_version=protocol_version,
            sequence=sequence,
            byte_count=byte_count,
            published_wall_ns=published_wall_ns,
        )


_current_terminal_trace: ContextVar[Optional[TerminalTrace]] = ContextVar(
    "current_terminal_trace", default=None
)
_event_loop_lag_ms: Optional[float] = None
_event_loop_lag_measured_ns: Optional[int] = None
_event_loop_lag_task: Optional[asyncio.Task[None]] = None


def create_terminal_trace(
    *,
    device_id: object,
    session_id: object,
    event: str,
    direction: str,
    protocol_version: Optional[int] = None,
    sequence: Optional[int] = None,
    byte_count: Optional[int] = None,
) -> Optional[TerminalTrace]:
    """Create trace metadata only for an explicitly targeted device."""
    try:
        return _create_terminal_trace(
            device_id=device_id,
            session_id=session_id,
            event=event,
            direction=direction,
            protocol_version=protocol_version,
            sequence=sequence,
            byte_count=byte_count,
        )
    except Exception:
        return None


def _create_terminal_trace(
    *,
    device_id: object,
    session_id: object,
    event: str,
    direction: str,
    protocol_version: Optional[int],
    sequence: Optional[int],
    byte_count: Optional[int],
) -> Optional[TerminalTrace]:
    if (
        not isinstance(device_id, str)
        or not is_target_device(device_id)
        or not isinstance(session_id, str)
    ):
        return None
    trace_id = uuid.uuid4().hex
    always_sampled = event in ALWAYS_SAMPLED_EVENTS
    sampled = always_sampled or _deterministically_sample(trace_id)
    return TerminalTrace(
        trace_id=trace_id,
        session_hash=_hash_session_id(session_id),
        device_id=device_id,
        event=event,
        direction=direction,
        sampled=sampled,
        sample_reason=(
            "input"
            if event == "terminal:input"
            else (
                "lifecycle"
                if always_sampled
                else "sampled" if sampled else "not_sampled"
            )
        ),
        source_pod=_current_pod(),
        created_wall_ns=time.time_ns(),
        protocol_version=protocol_version,
        sequence=sequence,
        byte_count=byte_count,
    )


def current_terminal_trace() -> Optional[TerminalTrace]:
    return _current_terminal_trace.get()


def with_terminal_trace_bytes(
    trace: Optional[TerminalTrace], text: object
) -> Optional[TerminalTrace]:
    """Add payload size only when this event will normally be logged."""
    if trace is None or not trace.sampled or not isinstance(text, str):
        return trace
    try:
        return replace(trace, byte_count=len(text.encode("utf-8", errors="replace")))
    except Exception:
        return trace


@contextmanager
def bind_terminal_trace(trace: Optional[TerminalTrace]) -> Iterator[None]:
    """Bind relay context without changing the called Socket.IO API."""
    if trace is None:
        yield
        return
    token: Token[Optional[TerminalTrace]] = _current_terminal_trace.set(trace)
    try:
        yield
    finally:
        _current_terminal_trace.reset(token)


def _safe_text(value: object) -> str:
    text = str(value)
    cleaned = "".join(char if char in SAFE_TEXT_CHARS else "_" for char in text)
    return cleaned[:160] or "unknown"


def _lag_fields() -> dict[str, Any]:
    if _event_loop_lag_ms is None or _event_loop_lag_measured_ns is None:
        return {}
    return {
        "event_loop_lag_ms": round(_event_loop_lag_ms, 3),
        "event_loop_lag_age_ms": round(
            (time.perf_counter_ns() - _event_loop_lag_measured_ns) / 1_000_000, 3
        ),
    }


def record_terminal_trace(
    trace: Optional[TerminalTrace],
    *,
    stage: str,
    result: str,
    force: bool = False,
    **fields: object,
) -> None:
    """Emit one safe diagnostic record. Diagnostics must never affect relay flow."""
    try:
        if trace is None:
            return
        numeric_values = [
            float(value)
            for key, value in fields.items()
            if key.endswith("_ms") and isinstance(value, (int, float))
        ]
        slow = bool(numeric_values) and max(numeric_values) >= float(
            settings.TERMINAL_BACKEND_DIAGNOSTICS_SLOW_THRESHOLD_MS
        )
        failed = result not in {
            "enqueued",
            "handler_accepted",
            "published",
            "published_no_subscribers",
            "success",
        }
        if not (trace.sampled or force or slow or failed):
            return
        sample_reason = (
            "error"
            if failed
            else "slow" if slow and not trace.sampled else trace.sample_reason
        )
        values: dict[str, object] = {
            "version": TERMINAL_TRACE_VERSION,
            "stage": stage,
            "event": trace.event,
            "direction": trace.direction,
            "trace_id": trace.trace_id,
            "session_hash": trace.session_hash,
            "device_id": trace.device_id,
            "current_pod": _current_pod(),
            "pid": os.getpid(),
            "result": result,
            "sample_reason": sample_reason,
            "source_pod": trace.source_pod,
            "protocol_version": trace.protocol_version,
            "sequence": trace.sequence,
            "bytes": trace.byte_count,
            **_lag_fields(),
            **fields,
        }
        parts = []
        for key in sorted(SAFE_LOG_FIELDS):
            value = values.get(key)
            if value is None:
                continue
            if isinstance(value, float):
                rendered = str(round(value, 3))
            elif isinstance(value, (int, bool)):
                rendered = str(value).lower() if isinstance(value, bool) else str(value)
            else:
                rendered = _safe_text(value)
            parts.append(f"{key}={rendered}")
        logger.info("%s %s", TERMINAL_TRACE_LOG_PREFIX, " ".join(parts))
    except Exception:
        try:
            logger.debug("Terminal diagnostic logging failed", exc_info=True)
        except Exception:
            pass


async def _event_loop_lag_sampler() -> None:
    global _event_loop_lag_measured_ns, _event_loop_lag_ms
    interval = settings.TERMINAL_BACKEND_DIAGNOSTICS_LOOP_LAG_INTERVAL_SECONDS
    expected = time.perf_counter() + interval
    while True:
        await asyncio.sleep(interval)
        now = time.perf_counter()
        _event_loop_lag_ms = max(0.0, (now - expected) * 1000)
        _event_loop_lag_measured_ns = time.perf_counter_ns()
        expected = now + interval


def start_event_loop_lag_sampler() -> Optional[asyncio.Task[None]]:
    """Start one process-owned sampler only while diagnostics are enabled."""
    global _event_loop_lag_task
    if not terminal_diagnostics_enabled():
        return None
    if _event_loop_lag_task is None or _event_loop_lag_task.done():
        try:
            loop = asyncio.get_running_loop()
            _event_loop_lag_task = loop.create_task(
                _event_loop_lag_sampler(), name="terminal-event-loop-lag"
            )
        except Exception:
            _event_loop_lag_task = None
    return _event_loop_lag_task


async def stop_event_loop_lag_sampler() -> None:
    """Cancel and await the process-owned sampler."""
    global _event_loop_lag_task
    task = _event_loop_lag_task
    _event_loop_lag_task = None
    if task is None:
        return
    if not task.done():
        task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        try:
            logger.debug("Terminal event-loop sampler failed", exc_info=True)
        except Exception:
            pass
