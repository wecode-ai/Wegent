import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import Column, Integer, create_engine, event
from sqlalchemy.orm import Session, declarative_base

from app.services.context.context_service import context_service
from app.services.knowledge.document_read_service import DocumentReadService
from app.services.knowledge.generation_reporting import report_generation
from app.services.knowledge.retrieval_persistence import RetrievalPersistenceService
from app.services.knowledge.wiki_reporting import (
    binding_fact,
    emit_binding_snapshot,
    wiki_request,
)
from shared.event_reporting import reporter
from shared.event_reporting.config import EventReporterConfig


@pytest.fixture
def sink(monkeypatch):
    instance = reporter.EventReporter(
        "backend-test",
        config=EventReporterConfig(
            enabled=True,
            environment="test",
            bootstrap_servers="unused",
            adv_read_wiki_enabled=True,
            adv_model_storage_enabled=True,
            adv_quality_detail_enabled=True,
        ),
    )
    instance._sender_state = "running"
    monkeypatch.setattr(reporter, "_reporter", instance)
    monkeypatch.setattr(reporter, "_reporter_pid", os.getpid())
    return instance


def records(sink):
    return [json.loads(item.payload) for item in sink._queue.discard()]


@pytest.mark.asyncio
async def test_commit_then_failure_keeps_only_true_binding_fact_without_select(sink):
    base = declarative_base()

    class Document(base):
        __tablename__ = "adv_test_documents"
        id = Column(Integer, primary_key=True)
        kind_id = Column(Integer)

    engine = create_engine("sqlite://")
    base.metadata.create_all(engine)

    def prohibit_select(conn, cursor, statement, *args):
        assert not statement.lstrip().upper().startswith("SELECT")

    event.listen(engine, "before_cursor_execute", prohibit_select)
    failure = RuntimeError("do not log this message")

    @wiki_request("bind")
    async def request(knowledge_base_id, body, db):
        first = Document(id=1, kind_id=knowledge_base_id)
        db.add(first)
        db.flush()
        first_snapshot = binding_fact(db, first, "created", committed=True)
        db.commit()
        emit_binding_snapshot(first_snapshot)
        second = Document(id=2, kind_id=knowledge_base_id)
        db.add(second)
        db.flush()
        binding_fact(db, second, "created", committed=True)
        db.rollback()
        raise failure

    with Session(engine, expire_on_commit=True) as db:
        with pytest.raises(RuntimeError) as caught:
            await request(11, SimpleNamespace(connection_id="conn"), db)
    assert caught.value is failure
    emitted = records(sink)
    assert len(emitted) == 2
    assert emitted[0]["document_id"] == 1
    assert emitted[0]["data"]["stage"] == "committed"
    assert emitted[1]["status"] == "failed"
    assert "do not log" not in json.dumps(emitted)
    engine.dispose()


@pytest.mark.asyncio
async def test_binding_budget_does_not_limit_business_or_leak_context(sink):
    @wiki_request("bind")
    async def request(knowledge_base_id, db):
        for document_id in range(140):
            binding_fact(
                db,
                SimpleNamespace(id=document_id, kind_id=knowledge_base_id),
                "processing",
            )
        return 140

    assert await request(11, MagicMock()) == 140
    assert len(records(sink)) == 129
    binding_fact(MagicMock(), SimpleNamespace(id=999, kind_id=11), "processing")
    assert not records(sink)


def test_read_results_include_scope_denial_without_content_or_kb_disclosure(
    sink, monkeypatch
):
    service = DocumentReadService()
    documents = {
        1: SimpleNamespace(id=1, kind_id=11, attachment_id=0, name="private-title"),
        2: SimpleNamespace(id=2, kind_id=22, attachment_id=0, name="private-title"),
    }
    monkeypatch.setattr(service, "_load_documents", lambda *a, **k: documents)
    monkeypatch.setattr(service, "_load_attachment_contexts", lambda *a: {})
    result = service.read_documents(
        MagicMock(),
        document_ids=[1, 2, 3],
        knowledge_base_ids=[11],
        entrypoint="kb_head",
    )
    assert result[0]["returned_length"] == 0
    emitted = records(sink)
    assert len(emitted) == 3
    assert emitted[0]["data"]["returned_length"] == 0
    assert emitted[0]["data"]["entrypoint"] == "kb_head"
    assert emitted[1]["kb_id"] is None
    assert emitted[2]["error_code"] == "DOCUMENT_NOT_FOUND"
    assert "private-title" not in json.dumps(emitted)


def test_generation_copies_original_task_failure_not_answer_body(sink):
    result = SimpleNamespace(
        success=False,
        task_id=5,
        subtask_id=6,
        raw_content=object(),
        parsed_content=object(),
        error="private-error",
    )
    assert (
        report_generation(
            result,
            config=SimpleNamespace(knowledge_base_id=11, document_id=2),
            model_config={"model_name": "model", "api_key": "private-key"},
        )
        is result
    )
    record = records(sink)[0]
    assert record["status"] == "failed"
    assert record["data"]["model_name"] == "model"
    assert record["data"]["stage"] == "background_task"
    assert "private" not in json.dumps(record)


def test_retrieval_context_fact_is_emitted_only_after_create_returns(sink, monkeypatch):
    service = RetrievalPersistenceService()
    create_context = MagicMock(return_value=SimpleNamespace(id=91))
    monkeypatch.setattr(
        context_service,
        "get_knowledge_base_context_map_by_subtask",
        MagicMock(return_value={}),
    )
    monkeypatch.setattr(
        context_service,
        "create_knowledge_base_context_with_result",
        create_context,
    )

    service.persist_retrieval_result(
        MagicMock(),
        user_subtask_id=7,
        user_id=8,
        query="private-query",
        mode="rag_retrieval",
        records=[
            {
                "knowledge_base_id": 11,
                "document_id": 12,
                "title": "private-title",
                "content": "private-content",
                "score": 0.9,
            }
        ],
    )

    create_context.assert_called_once()
    record = records(sink)[0]
    assert record["event_type"] == "knowledge.retrieval.context.recorded"
    assert record["data"]["context_id"] == 91
    assert record["data"]["operation"] == "created"
    assert record["data"]["stage"] == "persisted"
    assert "private" not in json.dumps(record)


def test_retrieval_context_fact_is_not_emitted_when_update_does_not_persist(
    sink, monkeypatch
):
    service = RetrievalPersistenceService()
    monkeypatch.setattr(
        context_service,
        "get_knowledge_base_context_map_by_subtask",
        MagicMock(return_value={11: SimpleNamespace(id=91)}),
    )
    monkeypatch.setattr(
        context_service,
        "update_knowledge_base_retrieval_result",
        MagicMock(return_value=None),
    )

    service.persist_retrieval_result(
        MagicMock(),
        user_subtask_id=7,
        user_id=8,
        query="private-query",
        mode="rag_retrieval",
        records=[
            {
                "knowledge_base_id": 11,
                "title": "private-title",
                "content": "private-content",
                "score": 0.9,
            }
        ],
    )

    assert not records(sink)


@pytest.mark.asyncio
@pytest.mark.parametrize("ok", [True, False])
async def test_wiki_actual_connector_result_is_not_http_success(sink, monkeypatch, ok):
    from app.api.endpoints import external_wiki
    from app.schemas.external_wiki import WikiConnectionTestRequest

    connector = SimpleNamespace(
        test_connection=AsyncMock(
            return_value=SimpleNamespace(ok=ok, message="private", version="v1")
        )
    )
    monkeypatch.setattr(external_wiki, "register_builtin_connectors", lambda: None)
    monkeypatch.setattr(external_wiki, "WIKI_CONNECTORS", {"wikijs": connector})
    monkeypatch.setattr(external_wiki, "validate_wiki_site_url", lambda url: url)
    db = MagicMock()
    result = await external_wiki.test_wiki_connection(
        WikiConnectionTestRequest(
            connector_type="wikijs",
            site_url="https://unused.invalid",
            api_key="private",
        ),
        db,
        SimpleNamespace(id=7),
    )
    assert result.ok is ok
    connector.test_connection.assert_awaited_once()
    db.commit.assert_called_once()
    emitted = records(sink)
    assert len(emitted) == 1
    assert emitted[0]["status"] == ("success" if ok else "failed")
    assert emitted[0]["data"]["stage"] == "connector_call"
    assert "private" not in json.dumps(emitted)


@pytest.mark.asyncio
async def test_wiki_validation_failure_does_not_invoke_connector(sink, monkeypatch):
    from app.api.endpoints import external_wiki
    from app.schemas.external_wiki import WikiConnectionTestRequest

    connector = SimpleNamespace(test_connection=AsyncMock())
    monkeypatch.setattr(external_wiki, "register_builtin_connectors", lambda: None)
    monkeypatch.setattr(external_wiki, "WIKI_CONNECTORS", {"wikijs": connector})
    result = await external_wiki.test_wiki_connection(
        WikiConnectionTestRequest(connector_type="wikijs"),
        MagicMock(),
        SimpleNamespace(id=7),
    )
    assert result.ok is False
    connector.test_connection.assert_not_awaited()
    record = records(sink)[0]
    assert record["data"]["reason_code"] == "missing_site_url"
    assert record["data"]["stage"] == "validation"
