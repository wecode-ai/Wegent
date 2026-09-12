# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Socket.IO Redis manager instrumentation for terminal relay diagnostics."""

import asyncio
import os
import time
from typing import Any, Optional

import socketio

from app.services.device.terminal_diagnostics import (
    TERMINAL_TRACE_METADATA_KEY,
    TerminalTrace,
    current_terminal_trace,
    record_terminal_trace,
)


class TerminalDiagnosticAsyncRedisManager(socketio.AsyncRedisManager):
    """Preserve manager behavior while timing terminal Redis relay stages."""

    async def _publish(self, data: dict[str, Any]) -> Any:
        trace = current_terminal_trace()
        message = data
        if trace is not None and data.get("method") == "emit":
            try:
                publish_wall_ns = time.time_ns()
                message = dict(data)
                message[TERMINAL_TRACE_METADATA_KEY] = trace.metadata(
                    published_wall_ns=publish_wall_ns
                )
            except Exception:
                message = data

        started = _safe_perf_counter_ns()
        try:
            result = await super()._publish(message)
        except asyncio.CancelledError:
            _safe_record_terminal_trace(
                trace,
                stage="redis.publish",
                result="cancelled",
                publish_ms=_safe_elapsed_ms(started),
                channel=self.channel,
                manager=type(self).__name__,
            )
            raise
        except Exception:
            _safe_record_terminal_trace(
                trace,
                stage="redis.publish",
                result="publish_failed",
                publish_ms=_safe_elapsed_ms(started),
                channel=self.channel,
                manager=type(self).__name__,
            )
            raise

        publish_result = (
            "publish_failed"
            if result is None
            else "published_no_subscribers" if result == 0 else "published"
        )
        _safe_record_terminal_trace(
            trace,
            stage="redis.publish",
            result=publish_result,
            publish_ms=_safe_elapsed_ms(started),
            subscribers=result,
            channel=self.channel,
            manager=type(self).__name__,
        )
        return result

    async def _handle_emit(self, message: dict[str, Any]) -> Any:
        try:
            metadata_trace = TerminalTrace.from_metadata(
                message.get(TERMINAL_TRACE_METADATA_KEY)
            )
        except Exception:
            metadata_trace = None
        trace = metadata_trace or current_terminal_trace()
        if trace is None:
            return await super()._handle_emit(message)

        received_wall_ns = _safe_time_ns() if metadata_trace is not None else None
        namespace = message.get("namespace") or "/"
        room = message.get("room")
        local_participant_count, participant_query_failed = _participant_count(
            self, namespace, room
        )
        remote = metadata_trace is not None
        started = _safe_perf_counter_ns()
        try:
            result = await super()._handle_emit(message)
        except asyncio.CancelledError:
            self._record_enqueue(
                trace,
                remote=remote,
                namespace=namespace,
                participant_count=local_participant_count,
                started=started,
                received_wall_ns=received_wall_ns,
                result="cancelled",
            )
            raise
        except Exception:
            self._record_enqueue(
                trace,
                remote=remote,
                namespace=namespace,
                participant_count=local_participant_count,
                started=started,
                received_wall_ns=received_wall_ns,
                result="enqueue_failed",
            )
            raise
        self._record_enqueue(
            trace,
            remote=remote,
            namespace=namespace,
            participant_count=local_participant_count,
            started=started,
            received_wall_ns=received_wall_ns,
            result="diagnostic_error" if participant_query_failed else "enqueued",
        )
        return result

    def _record_enqueue(
        self,
        trace: TerminalTrace,
        *,
        remote: bool,
        namespace: str,
        participant_count: Optional[int],
        started: Optional[int],
        received_wall_ns: Optional[int],
        result: str,
    ) -> None:
        try:
            self._record_enqueue_fields(
                trace,
                remote=remote,
                namespace=namespace,
                participant_count=participant_count,
                started=started,
                received_wall_ns=received_wall_ns,
                result=result,
            )
        except Exception:
            pass

    def _record_enqueue_fields(
        self,
        trace: TerminalTrace,
        *,
        remote: bool,
        namespace: str,
        participant_count: Optional[int],
        started: Optional[int],
        received_wall_ns: Optional[int],
        result: str,
    ) -> None:
        if not participant_count and result == "enqueued":
            return
        diagnostic_error = result == "diagnostic_error"
        fields: dict[str, object] = {
            "target_namespace": namespace,
            "target_location": (
                "unknown"
                if diagnostic_error
                else "remote_or_absent" if remote or not participant_count else "local"
            ),
            "local_participant_count": participant_count,
            "local_enqueue_ms": _safe_elapsed_ms(started),
            "manager": type(self).__name__,
        }
        if diagnostic_error:
            fields["reason_code"] = "participant_query_failed"
        if (
            remote
            and trace.published_wall_ns is not None
            and received_wall_ns is not None
        ):
            queue_ms = (received_wall_ns - trace.published_wall_ns) / 1_000_000
            fields["approx_queue_ms"] = queue_ms
            fields["clock_skew"] = queue_ms < 0
            fields["target_pod"] = _current_pod()
        _safe_record_terminal_trace(
            trace,
            stage="redis.consume_enqueue" if remote else "socketio.local_enqueue",
            result=result,
            **fields,
        )


def target_location(sio: socketio.AsyncServer, target: str, namespace: str) -> str:
    """Classify a Socket.IO target without exposing its socket or room value."""
    try:
        manager = getattr(sio, "manager", None)
        if manager is None:
            return "unknown"
        if manager.is_connected(target, namespace):
            return "local"
        if any(manager.get_participants(namespace, target)):
            return "local"
        return "remote_or_absent"
    except Exception:
        return "unknown"


def _participant_count(
    manager: socketio.AsyncManager, namespace: str, room: object
) -> tuple[Optional[int], bool]:
    try:
        if room is None:
            return None, False
        return sum(1 for _ in manager.get_participants(namespace, room)), False
    except Exception:
        return None, True


def _safe_perf_counter_ns() -> Optional[int]:
    try:
        return time.perf_counter_ns()
    except Exception:
        return None


def _safe_time_ns() -> Optional[int]:
    try:
        return time.time_ns()
    except Exception:
        return None


def _safe_elapsed_ms(started_ns: Optional[int]) -> Optional[float]:
    if started_ns is None:
        return None
    try:
        return (time.perf_counter_ns() - started_ns) / 1_000_000
    except Exception:
        return None


def _current_pod() -> str:
    return os.environ.get("HOSTNAME", "unknown")


def _safe_record_terminal_trace(
    trace: Optional[TerminalTrace], *, stage: str, result: str, **fields: object
) -> None:
    try:
        record_terminal_trace(trace, stage=stage, result=result, **fields)
    except Exception:
        pass
