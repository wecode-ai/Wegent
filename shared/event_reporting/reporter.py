# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import threading
import time
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from . import contracts
from .config import EventReporterConfig
from .envelope import build_envelope
from .queue import ByteBoundedQueue, QueuedEvent
from .transport import EventTransport, KafkaTransport

logger = logging.getLogger(__name__)
TransportFactory = Callable[[EventReporterConfig], EventTransport]
_SENDER_BATCH_MAX_EVENTS = 128
_PERMANENT_ERRORS = {
    "ImportError",
    "ModuleNotFoundError",
    "ValueError",
    "AuthenticationFailedError",
    "TopicAuthorizationFailedError",
    "ClusterAuthorizationFailedError",
    "UnsupportedSaslMechanismError",
    "IllegalSaslStateError",
}


class EventReporter:
    """Best-effort logging: only bounded encoding and try-locks on the caller."""

    def __init__(
        self,
        service_name: str,
        *,
        config: EventReporterConfig | None = None,
        transport_factory: TransportFactory = KafkaTransport,
    ) -> None:
        self._service_name = service_name
        self._config = config or EventReporterConfig.from_env(service_name)
        self._validation_error = self._config.validation_error()
        self._transport_factory = transport_factory
        self._queue = ByteBoundedQueue(self._config.queue_max_bytes)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task | None = None
        self._state_lock = threading.Lock()
        self._counters: Counter[str] = Counter()
        self._drop_reasons: Counter[str] = Counter()
        self._delivery_errors: Counter[str] = Counter()
        self._discard_reasons: Counter[str] = Counter()
        self._event_counters: Counter[tuple[str, str]] = Counter()
        self._pending: dict[int, QueuedEvent] = {}
        self._sender_state = "disabled"
        self._probe_taken = False
        self._last_ack_timestamp: float | None = None
        self._shutdown_deadline: float | None = None
        self._shutdown_timed_out = False
        self._metrics = None
        self._next_diagnostic = 0.0
        self._host_ip = os.getenv("POD_IP") or os.getenv("HOST_IP")
        self._version = os.getenv("SERVICE_VERSION") or os.getenv("IMAGE_TAG")
        self._instance = f"{os.getenv('HOSTNAME', 'local')}:{os.getpid()}"

    def start(self) -> None:
        try:
            if self._validation_error:
                self._sender_state = "misconfigured"
            if (
                not self._config.enabled and not self._validation_error
            ) or self._stop.is_set():
                return
            if self._thread is not None:
                return
            if not self._validation_error:
                self._sender_state = "starting"
            self._thread = threading.Thread(
                target=self._run_thread,
                name=f"{self._service_name}-event-reporter",
                daemon=True,
            )
            self._thread.start()
        except Exception:
            self._sender_state = "failed"

    def accepts_events(self) -> bool:
        return (
            not self._stop.is_set()
            and self._sender_state in {"running", "half_open"}
            and not (self._sender_state == "half_open" and self._probe_taken)
        )

    def event_allowed(self, event_type: str) -> bool:
        group = contracts.ADV_GROUPS.get(event_type)
        return group is None or getattr(self._config, group, False) is True

    def observation_limit(self, event_type: str) -> int:
        if not self.event_allowed(event_type):
            return 0
        if event_type == "knowledge.retrieval.result.observed":
            return self._config.adv_result_detail_limit
        return 0

    def emit(
        self,
        *,
        event_type: str,
        payload_factory: Callable[[], Mapping[str, Any]] = dict,
        fact_key_parts: Sequence[object] = (),
        kb_id: int | str | None = None,
        document_id: int | str | None = None,
        status: str = "success",
        error_code_factory: Callable[[], str | None] | None = None,
        duration_ms_factory: Callable[[], int | None] | None = None,
        fields_factory: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        # Reject unknown names before they can create unbounded metric cardinality.
        if event_type not in contracts.EVENT_TYPES:
            return
        if not self.event_allowed(event_type):
            return
        self._increment("attempted_total", event_type)
        if not self.accepts_events():
            self._drop(self._sender_state, event_type)
            return
        reason = self._queue.admit(self._config.event_max_bytes)
        if reason:
            self._drop(reason, event_type)
            return
        item = None
        try:
            if not self.accepts_events():
                self._drop(self._sender_state, event_type)
                return
            frame = fields_factory() if fields_factory else {}
            kb_id = frame.get("kb_id", kb_id)
            document_id = frame.get("document_id", document_id)
            status = frame.get("status", status)
            fact_key_parts = frame.get("fact_key_parts", fact_key_parts)
            data = contracts.payload(
                event_type,
                frame.get("data", {}) if fields_factory else payload_factory(),
            )
            if len(fact_key_parts) > 64:
                raise ValueError("too_many_fact_parts")
            envelope = build_envelope(
                event_type=event_type,
                fact_key_parts=tuple(contracts.scalar(p) for p in fact_key_parts),
                service_name=contracts.scalar(self._service_name),
                environment=contracts.scalar(self._config.environment),
                host_ip=contracts.scalar(self._host_ip),
                kb_id=contracts.scalar(kb_id),
                document_id=contracts.scalar(document_id),
                status=status,
                error_code=(
                    contracts.scalar(frame.get("error_code"))
                    if fields_factory
                    else (
                        contracts.scalar(error_code_factory())
                        if error_code_factory
                        else None
                    )
                ),
                duration_ms=(
                    contracts.scalar(frame.get("duration_ms"))
                    if fields_factory
                    else (
                        contracts.scalar(duration_ms_factory())
                        if duration_ms_factory
                        else None
                    )
                ),
                data=data,
            )
            envelope.update(
                service_version=contracts.scalar(self._version),
                service_instance=contracts.scalar(self._instance),
            )
            encoded = json.dumps(
                envelope, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
            if len(encoded) > self._config.event_max_bytes:
                self._drop("event_too_large", event_type)
            elif self.accepts_events():
                item = QueuedEvent(event_type, encoded)
                self._probe_taken = True
                self._increment("enqueued_total", event_type)
            else:
                self._drop("stopping", event_type)
        except Exception:
            self._increment("contract_error_total", event_type)
        finally:
            self._queue.finish(item)

    def shutdown(self, timeout_s: float | None = None) -> None:
        self._stop.set()
        thread = self._thread
        if thread is None:
            return
        timeout = (
            self._config.shutdown_timeout_ms / 1000 if timeout_s is None else timeout_s
        )
        self._shutdown_deadline = time.monotonic() + max(0.0, timeout)
        loop, task = self._loop, self._task
        if loop is not None and task is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(
                    lambda: loop.call_later(max(0.0, timeout), task.cancel)
                )
            except RuntimeError:
                pass
        thread.join(max(0.0, self._shutdown_deadline - time.monotonic()))
        if thread.is_alive():
            self._shutdown_timed_out = True
            self._sender_state = "shutdown_timeout"
            # No queue lock here: a misbehaving caller factory cannot stall shutdown.
            with self._state_lock:
                for item in self._pending.values():
                    self._counters["delivery_unknown_total"] += 1
                    self._event_counters[
                        ("delivery_unknown_total", item.event_type)
                    ] += 1
                self._pending.clear()

    def health(self) -> dict[str, object]:
        queued_events, queued_bytes = self._queue.snapshot()
        with self._state_lock:
            by_event: dict[str, dict[str, int]] = {}
            for (name, event_type), count in self._event_counters.items():
                by_event.setdefault(event_type, {})[name] = count
            return {
                **dict(self._counters),
                "by_event_type": by_event,
                "dropped_by_reason": dict(self._drop_reasons),
                "delivery_failed_by_error": dict(self._delivery_errors),
                "discarded_by_reason": dict(self._discard_reasons),
                "queue_events": queued_events,
                "queue_bytes": queued_bytes,
                "in_flight_events": len(self._pending),
                "in_flight_bytes": sum(
                    len(item.payload) for item in self._pending.values()
                ),
                "sender_alive": self._thread is not None and self._thread.is_alive(),
                "sender_state": self._sender_state,
                "configuration_error": self._validation_error,
                "last_ack_timestamp_seconds": self._last_ack_timestamp,
            }

    def _increment(self, name: str, event_type: str) -> None:
        if not self._state_lock.acquire(blocking=False):
            return
        try:
            self._counters[name] += 1
            self._event_counters[(name, event_type)] += 1
        finally:
            self._state_lock.release()

    def _drop(self, reason: str, event_type: str) -> None:
        if not self._state_lock.acquire(blocking=False):
            return
        try:
            self._counters["dropped_total"] += 1
            self._drop_reasons[reason] += 1
            self._event_counters[("dropped_total", event_type)] += 1
        finally:
            self._state_lock.release()

    def _set_state(self, state: str) -> None:
        if not self._shutdown_timed_out:
            self._sender_state = state

    def _budget(self) -> float:
        budget = self._config.request_timeout_ms / 1000
        if self._shutdown_deadline is not None:
            budget = min(budget, max(0.001, self._shutdown_deadline - time.monotonic()))
        return budget

    def _run_thread(self) -> None:
        try:
            if self._validation_error:
                self._diagnose(force=True)
                return
            asyncio.run(self._run_sender())
        except Exception:
            self._set_state("failed")

    async def _run_sender(self) -> None:
        from .metrics import EventReportingMetrics

        self._loop = asyncio.get_running_loop()
        self._task = asyncio.current_task()
        self._metrics = EventReportingMetrics(self._service_name)
        retry_delay = 0.25
        try:
            while not self._stop.is_set():
                healthy = await self._session()
                if self._sender_state in {"misconfigured", "failed"}:
                    break
                if healthy:
                    retry_delay = 0.25
                self._set_state("reconnecting")
                end = time.monotonic() + retry_delay * random.uniform(0.8, 1.2)
                while not self._stop.is_set() and time.monotonic() < end:
                    self._diagnose()
                    await asyncio.sleep(0.02)
                retry_delay = min(30.0, retry_delay * 2)
        except asyncio.CancelledError:
            pass
        finally:
            self._discard("shutdown")
            if self._sender_state not in {"failed", "misconfigured"}:
                self._set_state("stopped")
            self._diagnose(force=True)

    async def _session(self) -> bool:
        transport = None
        confirmed = False
        try:
            self._set_state("starting")
            transport = self._transport_factory(self._config)
            await asyncio.wait_for(transport.start(), self._budget())
            if self._stop.is_set():
                return False
            self._probe_taken = False
            self._set_state("half_open")
            while not self._stop.is_set() or self._queue.snapshot()[0]:
                self._diagnose()
                batch = self._queue.pop_batch(_SENDER_BATCH_MAX_EVENTS)
                if not batch:
                    await asyncio.sleep(0.02)
                    continue
                with self._state_lock:
                    self._pending.update((id(item), item) for item in batch)
                outcomes = await asyncio.gather(
                    *(self._deliver(transport, item) for item in batch)
                )
                if not all(outcomes):
                    break
                confirmed = True
                self._set_state("running")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._transport_error(error)
        finally:
            if self._sender_state not in {"misconfigured", "failed"}:
                self._set_state("degraded")
            self._discard("transport_unavailable")
            if transport is not None:
                try:
                    await asyncio.wait_for(transport.stop(), self._budget())
                except (Exception, asyncio.CancelledError):
                    # Never create replacement clients when cleanup is unconfirmed.
                    self._set_state("failed")
        return confirmed

    async def _deliver(self, transport: EventTransport, item: QueuedEvent) -> bool:
        outcome = "delivery_unknown_total"
        success = False
        try:
            await asyncio.wait_for(
                transport.send(item.payload), self._config.delivery_timeout_ms / 1000
            )
            outcome = "acked_total"
            success = True
        except asyncio.TimeoutError:
            self._set_state("degraded")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            outcome = "delivery_failed_total"
            self._transport_error(error)
        finally:
            with self._state_lock:
                if self._pending.pop(id(item), None) is not None:
                    self._counters[outcome] += 1
                    self._event_counters[(outcome, item.event_type)] += 1
                    if success:
                        self._last_ack_timestamp = time.time()
            self._queue.release(item)
        return success

    def _transport_error(self, error: Exception) -> None:
        code = type(error).__name__
        with self._state_lock:
            self._counters["transport_errors_total"] += 1
            self._delivery_errors[
                code if code in _PERMANENT_ERRORS else "transport_error"
            ] += 1
        self._set_state("misconfigured" if code in _PERMANENT_ERRORS else "degraded")

    def _discard(self, reason: str) -> None:
        for item in self._queue.discard():
            self._increment("discarded_total", item.event_type)
            with self._state_lock:
                self._discard_reasons[reason] += 1

    def _diagnose(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now < self._next_diagnostic:
            return
        self._next_diagnostic = now + 30
        try:
            health = self.health()
            if self._metrics is not None:
                self._metrics.publish(health)
            # This independent, content-free worker diagnostic works without OTel.
            logger.info(
                "event_reporter_health service=%s health=%s", self._service_name, health
            )
        except Exception:
            pass


_reporter_lock = threading.Lock()
_reporter: EventReporter | None = None
_reporter_pid: int | None = None


def _after_fork() -> None:
    global _reporter, _reporter_pid, _reporter_lock
    _reporter = None
    _reporter_pid = None
    _reporter_lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


def init_event_reporter(
    service_name: str, *, config: EventReporterConfig | None = None
) -> None:
    global _reporter, _reporter_pid
    try:
        with _reporter_lock:
            pid = os.getpid()
            if _reporter is not None and _reporter_pid == pid:
                return
            reporter = (
                EventReporter(service_name)
                if config is None
                else EventReporter(service_name, config=config)
            )
            reporter.start()
            _reporter, _reporter_pid = reporter, pid
    except Exception:
        pass


def shutdown_event_reporter(timeout_s: float | None = None) -> None:
    try:
        if _reporter is not None:
            # Keep ownership even on timeout: do not spawn a second sender in this PID.
            _reporter.shutdown(timeout_s)
    except Exception:
        pass


def get_event_reporting_health() -> dict[str, object]:
    try:
        return (
            _reporter.health()
            if _reporter is not None
            else {"sender_state": "uninitialized"}
        )
    except Exception:
        return {"sender_state": "unavailable"}


def is_event_reporting_enabled(event_type: str | None = None) -> bool:
    try:
        return (
            _reporter is not None
            and _reporter_pid == os.getpid()
            and _reporter.accepts_events()
            and (event_type is None or _reporter.event_allowed(event_type))
        )
    except Exception:
        return False


def get_event_observation_limit(event_type: str) -> int:
    """Return a bounded detail limit only while the event can be admitted."""
    try:
        if (
            _reporter is not None
            and _reporter_pid == os.getpid()
            and _reporter.accepts_events()
        ):
            return _reporter.observation_limit(event_type)
    except Exception:
        pass
    return 0


def emit_event(**kwargs: Any) -> None:
    try:
        if _reporter is not None and _reporter_pid == os.getpid():
            _reporter.emit(**kwargs)
    except Exception:
        pass
