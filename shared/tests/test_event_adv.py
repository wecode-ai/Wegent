"""Advanced contracts exercised through the real bounded reporter."""

import asyncio
import json
import os
import threading
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest

from shared.event_reporting import operations, reporter
from shared.event_reporting.catalogs.knowledge.quality import (
    RetrievalResultObserver,
    new_quality_execution_id,
    report_retrieval_context,
)
from shared.event_reporting.config import EventReporterConfig
from shared.event_reporting.contracts import ADV_GROUPS
from shared.event_reporting.operations import operation_fact


@pytest.fixture
def sink(monkeypatch):
    instance = reporter.EventReporter(
        "test",
        config=EventReporterConfig(
            enabled=True,
            environment="test",
            bootstrap_servers="unused",
            adv_attribution_enabled=True,
            adv_model_storage_enabled=True,
            adv_read_wiki_enabled=True,
            adv_quality_detail_enabled=True,
            adv_result_detail_limit=2,
        ),
    )
    instance._sender_state = "running"
    monkeypatch.setattr(reporter, "_reporter", instance)
    monkeypatch.setattr(reporter, "_reporter_pid", os.getpid())
    return instance


def events(sink):
    return [json.loads(item.payload) for item in sink._queue.discard()]


@pytest.mark.parametrize("event,group", ADV_GROUPS.items())
def test_groups_disabled_before_factory(sink, event, group):
    sink._config = replace(sink._config, **{group: False})
    sink.emit(event_type=event, fields_factory=lambda: pytest.fail("must not extract"))
    assert not events(sink)
    sink.emit(event_type="knowledge.kb.created")
    assert len(events(sink)) == 1


@pytest.mark.parametrize(
    "value,expected", [("true", True), ("false", False), ("bad", False)]
)
def test_optional_group_configuration(value, expected):
    config = EventReporterConfig.from_mapping(
        {"EVENT_KAFKA_ADV_MODEL_STORAGE_ENABLED": value}, "test"
    )
    assert config.adv_model_storage_enabled is expected
    assert bool(config.error) is (value == "bad")


def test_advanced_defaults_use_new_names_and_ten_result_limit():
    config = EventReporterConfig.from_mapping({}, "test")

    assert config.adv_attribution_enabled is False
    assert config.adv_read_wiki_enabled is False
    assert config.adv_model_storage_enabled is False
    assert config.adv_quality_detail_enabled is False
    assert config.adv_result_detail_limit == 10


@pytest.mark.parametrize(
    "value,valid", [(0, True), (100, True), (-1, False), (101, False)]
)
def test_result_detail_limit_is_bounded(value, valid):
    config = EventReporterConfig.from_mapping(
        {
            "EVENT_REPORTING_ENABLED": "true",
            "EVENT_KAFKA_BOOTSTRAP_SERVERS": "unused",
            "EVENT_KAFKA_ENVIRONMENT": "test",
            "EVENT_KAFKA_ADV_RESULT_DETAIL_LIMIT": str(value),
        },
        "test",
    )
    assert (config.validation_error() is None) is valid


def test_final_result_observer_is_bounded_and_content_free(sink):
    observer = RetrievalResultObserver.start(3)
    for rank in range(1, 4):
        observer.capture(
            SimpleNamespace(
                knowledge_base_id=11,
                document_id=rank,
                score=1.0 / rank,
                content="private-content",
                title="private-title",
            ),
            rank,
        )
    observer.flush()

    emitted = events(sink)
    assert len(emitted) == 2
    assert [item["data"]["rank"] for item in emitted] == [1, 2]
    assert all(item["data"]["returned_count"] == 3 for item in emitted)
    assert len({item["data"]["execution_id"] for item in emitted}) == 1
    assert "private" not in json.dumps(emitted)


def test_persisted_context_fact_contains_only_committed_identity(sink):
    execution_id = new_quality_execution_id("knowledge.retrieval.context.recorded")
    report_retrieval_context(
        execution_id=execution_id,
        context_id=91,
        subtask_id=7,
        kb_id=11,
        operation="created",
        injection_mode="rag_retrieval",
        chunk_count=3,
        restricted_mode=False,
    )

    record = events(sink)[0]
    assert record["data"]["context_id"] == 91
    assert record["data"]["subtask_id"] == 7
    assert record["data"]["stage"] == "persisted"


@pytest.mark.parametrize("mode", ["disabled", "degraded", "busy", "full"])
def test_admission_never_extracts_unavailable_payload(sink, mode):
    if mode in {"disabled", "degraded"}:
        sink._sender_state = mode
    elif mode == "busy":
        sink._queue._lock.acquire()
    else:
        sink._queue._max_bytes = 0
    try:

        @operation_fact(
            "knowledge.storage.operation.finished",
            operation="retrieve",
            data_factory=lambda *args: pytest.fail("no extraction before admission"),
        )
        def call():
            return original

        original = object()
        assert call() is original
    finally:
        if mode == "busy":
            sink._queue._lock.release()
    assert not events(sink)


@pytest.mark.asyncio
async def test_thread_context_links_are_scoped_and_do_not_scan_results(
    sink, monkeypatch
):
    # This test verifies concurrent ContextVar isolation, not drop-newest behavior.
    # Serialize only the collector admission so expected records are deterministic.
    original_emit = sink.emit
    emit_lock = threading.Lock()

    def serialized_emit(**kwargs):
        with emit_lock:
            original_emit(**kwargs)

    monkeypatch.setattr(sink, "emit", serialized_emit)

    class Result:
        @property
        def content(self):
            pytest.fail("must not inspect content")

    original = Result()

    @operation_fact("knowledge.embedding.call.finished", operation="query")
    def embedding():
        return original

    @operation_fact("knowledge.storage.operation.finished", operation="retrieve")
    def storage(knowledge_id):
        assert embedding() is original
        return original

    @operation_fact("knowledge.retrieval.target.finished", operation="retrieve")
    async def target(knowledge_id):
        return await asyncio.to_thread(storage, knowledge_id)

    assert await asyncio.gather(target("11"), target("22")) == [original, original]
    records = events(sink)
    assert len(records) == 6
    by_id = {item["data"]["operation_id"]: item for item in records}
    for record in records:
        parent = record["data"]["parent_operation_id"]
        if parent:
            assert by_id[parent]["kb_id"] == record["kb_id"]
        assert "content" not in record["data"]
    assert operations._identity.get() == (None, None)
    assert operations._active.get() == frozenset()


@pytest.mark.asyncio
async def test_cancellation_and_original_error_survive_reporting(sink):
    error = asyncio.CancelledError()

    @operation_fact("knowledge.retrieval.target.finished", operation="retrieve")
    async def target():
        raise error

    with pytest.raises(asyncio.CancelledError) as caught:
        await target()
    assert caught.value is error
    assert events(sink)[0]["status"] == "cancelled"
    assert operations._active.get() == frozenset()


def test_metadata_failure_cannot_break_business(sink, monkeypatch):
    monkeypatch.setattr(operations, "uuid4", lambda: 1 / 0)

    @operation_fact("knowledge.storage.operation.finished", operation="retrieve")
    def call():
        return 42

    assert call() == 42
    assert not events(sink)


def test_nested_same_kind_is_one_logical_fact(sink):
    @operation_fact("knowledge.embedding.call.finished", operation="inner")
    def inner():
        return 7

    @operation_fact("knowledge.embedding.call.finished", operation="outer")
    def outer():
        return inner()

    assert outer() == 7
    records = events(sink)
    assert len(records) == 1
    assert records[0]["data"]["operation"] == "outer"


@pytest.mark.parametrize("fail_business", [False, True])
def test_invalid_fields_never_replace_business_return_or_exception(sink, fail_business):
    original = object()
    error = ValueError("business-error")

    @operation_fact(
        "knowledge.storage.operation.finished",
        operation="retrieve",
        data_factory=lambda *args: {"content": "forbidden"},
    )
    def call():
        if fail_business:
            raise error
        return original

    if fail_business:
        with pytest.raises(ValueError) as caught:
            call()
        assert caught.value is error
    else:
        assert call() is original
    assert not events(sink)


def test_operation_fact_reports_monotonic_duration(sink):
    """duration_ms is measured with a monotonic clock, not wall-clock math."""

    @operation_fact("knowledge.storage.operation.finished", operation="upsert")
    def call():
        time.sleep(0.01)
        return "ok"

    assert call() == "ok"
    payload = events(sink)[0]
    assert payload["event_type"] == "knowledge.storage.operation.finished"
    assert isinstance(payload["duration_ms"], int)
    assert payload["duration_ms"] >= 10
