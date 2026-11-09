from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from dataclasses import replace
from types import ModuleType
from unittest.mock import AsyncMock, Mock

import pytest

from shared.event_reporting.config import EventReporterConfig
from shared.event_reporting.envelope import build_fact_key
from shared.event_reporting.reporter import EventReporter
from shared.event_reporting.transport import KafkaTransport


@pytest.mark.asyncio
async def test_transport_forwards_security_options_without_connecting(mocker):
    producer = Mock()
    producer.start = AsyncMock()
    producer.send_and_wait = AsyncMock()
    producer.stop = AsyncMock()
    producer_class = Mock(return_value=producer)
    fake_aiokafka = ModuleType("aiokafka")
    fake_aiokafka.AIOKafkaProducer = producer_class
    mocker.patch.dict(sys.modules, {"aiokafka": fake_aiokafka})
    cfg = config(
        security_protocol="SASL_PLAINTEXT",
        sasl_username="test-user",
        sasl_password="test-value",
    )
    transport = KafkaTransport(cfg)
    await transport.start()
    producer.start.assert_awaited_once()
    options = producer_class.call_args.kwargs
    assert options["acks"] == "all"
    assert options["security_protocol"] == "SASL_PLAINTEXT"
    assert options["sasl_plain_username"] == "test-user"
    assert "test-value" not in repr(cfg)
    await transport.send(b"fact")
    producer.send_and_wait.assert_awaited_once_with(cfg.topic, b"fact")
    await transport.stop()
    producer.stop.assert_awaited_once()


class RecordingTransport:
    def __init__(self) -> None:
        self.payloads: list[bytes] = []
        self.started = False
        self.stopped = False
        self.block = False
        self.fail = False

    async def start(self) -> None:
        self.started = True

    async def send(self, payload: bytes) -> None:
        self.payloads.append(payload)
        while self.block:
            await asyncio.sleep(0.002)
        if self.fail:
            raise ConnectionError("broker disconnected")

    async def stop(self) -> None:
        self.stopped = True


def config(**changes) -> EventReporterConfig:
    return replace(
        EventReporterConfig(
            enabled=True,
            bootstrap_servers="unused:9092",
            environment="test",
            request_timeout_ms=100,
            delivery_timeout_ms=500,
            shutdown_timeout_ms=500,
            queue_max_bytes=16 * 1024,
        ),
        **changes,
    )


def wait_for(condition) -> None:
    deadline = time.monotonic() + 2
    while not condition():
        if time.monotonic() >= deadline:
            raise AssertionError("sender did not reach expected state")
        time.sleep(0.002)


def emit(reporter, factory=lambda: {"trigger": "upload"}) -> None:
    reporter.emit(
        event_type="knowledge.document.created",
        payload_factory=factory,
        fact_key_parts=(7, 9),
        kb_id=7,
        document_id=9,
        status="success",
    )


def wait_for_running(reporter) -> None:
    # ACK accounting happens inside _deliver; admission opens after gather returns.
    # Wait for the lifecycle checkpoint, not the earlier accounting observation.
    wait_for(lambda: reporter.health()["sender_state"] == "running")


@pytest.fixture
def sender():
    transport = RecordingTransport()
    reporter = EventReporter(
        "test",
        config=config(queue_max_bytes=128 * 1024),
        transport_factory=lambda _: transport,
    )
    reporter.start()
    wait_for(reporter.accepts_events)
    yield reporter, transport
    transport.block = False
    reporter.shutdown()


def test_disabled_does_not_execute_factory():
    reporter = EventReporter("test", config=config(enabled=False))
    reporter.start()
    factory = Mock(side_effect=AssertionError("must not execute"))
    emit(reporter, factory)
    factory.assert_not_called()
    assert reporter.health()["sender_state"] == "disabled"


def test_sends_scalar_fact_and_ack(sender):
    reporter, transport = sender
    emit(reporter)
    wait_for_running(reporter)
    value = json.loads(transport.payloads[0])
    assert value["fact_key"] == "v1|knowledge.document.created|7|9"
    assert value["data"] == {"trigger": "upload"}
    assert value["deployment_environment"] == "test"
    assert reporter.health()["sender_state"] == "running"


def test_multiple_events_drain_after_confirmed_probe(sender, monkeypatch):
    reporter, transport = sender
    emit(reporter)
    wait_for_running(reporter)
    paused, resume = threading.Event(), threading.Event()
    pop_batch = reporter._queue.pop_batch

    def pause_before_queue_lock(limit):
        paused.set()
        assert resume.wait(2)
        return pop_batch(limit)

    monkeypatch.setattr(reporter._queue, "pop_batch", pause_before_queue_lock)
    assert paused.wait(2)
    try:
        for _ in range(20):
            emit(reporter)
    finally:
        resume.set()
    reporter.shutdown()
    assert len(transport.payloads) == 21
    assert reporter.health()["acked_total"] == 21
    assert transport.stopped


@pytest.mark.parametrize(
    "data",
    [
        {"query": "private content"},
        {"trigger": "x" * 257},
        {"trigger": object()},
        {"knowledge_base_ids": list(range(65))},
        {"content_bytes": 1 << 1000},
    ],
)
def test_rejects_unbounded_or_noncontract_data(sender, data):
    reporter, transport = sender
    emit(reporter, lambda: data)
    assert reporter.health()["contract_error_total"] == 1
    assert not transport.payloads


def test_factory_error_does_not_call_logging_handlers(sender, monkeypatch):
    reporter, _ = sender
    handler = Mock(side_effect=AssertionError("caller must not log"))
    monkeypatch.setattr("logging.Logger.exception", handler)
    emit(reporter, Mock(side_effect=RuntimeError("private contents")))
    handler.assert_not_called()
    assert reporter.health()["contract_error_total"] == 1


def test_fields_factory_is_guarded_before_extraction():
    reporter = EventReporter("test", config=config(enabled=False))
    factory = Mock(side_effect=AssertionError("must not inspect ORM"))
    reporter.emit(event_type="knowledge.kb.created", fields_factory=factory)
    factory.assert_not_called()


def test_start_failure_cleans_up_and_drops_before_build():
    transport = RecordingTransport()
    started = threading.Event()

    async def fail():
        started.set()
        raise ConnectionError("offline")

    transport.start = fail
    reporter = EventReporter(
        "test", config=config(), transport_factory=lambda _: transport
    )
    reporter.start()
    assert started.wait(1)
    wait_for(lambda: transport.stopped)
    factory = Mock()
    emit(reporter, factory)
    factory.assert_not_called()
    reporter.shutdown()
    assert reporter.health().get("enqueued_total", 0) == 0


def test_runtime_failure_degrades_and_recovers_without_business_replay():
    broken, healthy = RecordingTransport(), RecordingTransport()
    broken.fail = True
    transports = iter([broken, healthy])
    reporter = EventReporter(
        "test", config=config(), transport_factory=lambda _: next(transports)
    )
    try:
        reporter.start()
        wait_for(reporter.accepts_events)
        emit(reporter)
        wait_for(lambda: broken.stopped)
        factory = Mock()
        emit(reporter, factory)
        factory.assert_not_called()
        wait_for(reporter.accepts_events)
        emit(reporter)
        wait_for_running(reporter)
        assert len(broken.payloads) == len(healthy.payloads) == 1
        assert reporter.health()["delivery_failed_total"] == 1
    finally:
        reporter.shutdown()


def test_half_open_allows_only_one_pending_trial(sender):
    reporter, transport = sender
    transport.block = True
    emit(reporter)
    factory = Mock()
    emit(reporter, factory)
    factory.assert_not_called()
    wait_for(lambda: len(transport.payloads) == 1)


def test_queue_reserves_inflight_bytes_and_rejects_before_factory():
    transport = RecordingTransport()
    reporter = EventReporter(
        "test",
        config=config(queue_max_bytes=1024, event_max_bytes=700),
        transport_factory=lambda _: transport,
    )
    try:
        reporter.start()
        wait_for(reporter.accepts_events)
        emit(reporter)
        wait_for_running(reporter)
        transport.block = True
        emit(reporter)
        wait_for(lambda: reporter.health()["in_flight_events"] == 1)
        factory = Mock()
        emit(reporter, factory)
        factory.assert_not_called()
        assert reporter.health()["dropped_by_reason"]["queue_full"] == 1
    finally:
        transport.block = False
        reporter.shutdown()


def test_queue_busy_does_not_build_or_wait(sender):
    reporter, _ = sender
    factory = Mock()
    reporter._queue._lock.acquire()
    try:
        emit(reporter, factory)
    finally:
        reporter._queue._lock.release()
    factory.assert_not_called()
    assert reporter.health()["dropped_by_reason"]["queue_busy"] == 1


def test_metric_lock_contention_does_not_wait(sender):
    reporter, _ = sender
    reporter._state_lock.acquire()
    try:
        emit(reporter)
    finally:
        reporter._state_lock.release()


def test_shutdown_is_bounded_and_no_double_terminal_count(sender):
    reporter, transport = sender
    transport.block = True
    emit(reporter)
    wait_for(lambda: reporter.health()["in_flight_events"] == 1)
    started = time.monotonic()
    reporter.shutdown(timeout_s=0.02)
    assert time.monotonic() - started < 0.5
    factory = Mock()
    emit(reporter, factory)
    factory.assert_not_called()
    transport.block = False
    wait_for(lambda: not reporter._thread.is_alive())
    health = reporter.health()
    assert health.get("delivery_unknown_total", 0) == 1
    assert health.get("acked_total", 0) == 0


def test_cleanup_failure_never_creates_replacement():
    transport = RecordingTransport()
    transport.fail = True

    async def fail_stop():
        raise RuntimeError("cleanup failed")

    transport.stop = fail_stop
    factory = Mock(return_value=transport)
    reporter = EventReporter("test", config=config(), transport_factory=factory)
    reporter.start()
    wait_for(reporter.accepts_events)
    emit(reporter)
    wait_for(lambda: not reporter._thread.is_alive())
    assert reporter.health()["sender_state"] == "failed"
    assert factory.call_count == 1
    reporter.shutdown()


@pytest.mark.parametrize(
    "key,value",
    [
        ("EVENT_KAFKA_LINGER_MS", "invalid"),
        ("EVENT_REPORTING_ENABLED", "invalid"),
        ("EVENT_KAFKA_ACKS", "1"),
        ("EVENT_KAFKA_COMPRESSION_TYPE", "bad"),
    ],
)
def test_invalid_config_never_raises(key, value):
    resolved = EventReporterConfig.from_mapping(
        {
            "EVENT_REPORTING_ENABLED": True,
            "EVENT_KAFKA_BOOTSTRAP_SERVERS": "unused",
            "EVENT_KAFKA_ENVIRONMENT": "test",
            key: value,
        },
        "test",
    )
    assert resolved.validation_error() is not None
    reporter = EventReporter("test", config=resolved)
    reporter.start()
    assert reporter.health()["sender_state"] == "misconfigured"


def test_fact_key_percent_encodes_parts():
    assert (
        build_fact_key("knowledge.test", ("a|b", "中文", 3))
        == "v1|knowledge.test|a%7Cb|%E4%B8%AD%E6%96%87|3"
    )


def test_fork_resets_inherited_lock_and_singleton(monkeypatch):
    from shared.event_reporting import reporter as module

    old = threading.Lock()
    old.acquire()
    monkeypatch.setattr(module, "_reporter_lock", old)
    monkeypatch.setattr(module, "_reporter", object())
    monkeypatch.setattr(module, "_reporter_pid", 1)
    module._after_fork()
    assert module._reporter is None
    assert module._reporter_lock.acquire(blocking=False)
    module._reporter_lock.release()
    old.release()
