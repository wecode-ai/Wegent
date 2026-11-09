import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from tenacity import wait_none

from knowledge_engine.embedding.custom import CustomEmbedding
from knowledge_engine.query.executor import QueryExecutor
from knowledge_runtime.config import Settings
from shared.event_reporting import reporter
from shared.event_reporting.config import EventReporterConfig


@pytest.fixture
def sink(monkeypatch):
    instance = reporter.EventReporter(
        "runtime-test",
        config=EventReporterConfig(
            enabled=True,
            bootstrap_servers="unused",
            environment="test",
            adv_attribution_enabled=True,
            adv_model_storage_enabled=True,
            adv_quality_detail_enabled=True,
            adv_result_detail_limit=2,
        ),
    )
    instance._sender_state = "running"
    monkeypatch.setattr(reporter, "_reporter", instance)
    monkeypatch.setattr(reporter, "_reporter_pid", os.getpid())
    return instance


def records(sink):
    return [json.loads(item.payload) for item in sink._queue.discard()]


def test_runtime_settings_preserve_sasl_password():
    settings = Settings(
        _env_file=None,
        EVENT_REPORTING_ENABLED=True,
        EVENT_KAFKA_ADV_QUALITY_DETAIL_ENABLED=True,
        EVENT_KAFKA_ADV_RESULT_DETAIL_LIMIT=7,
        EVENT_KAFKA_BOOTSTRAP_SERVERS="kafka:9092",
        EVENT_KAFKA_ENVIRONMENT="test",
        EVENT_KAFKA_SECURITY_PROTOCOL="SASL_PLAINTEXT",
        EVENT_KAFKA_SASL_USERNAME="user",
        EVENT_KAFKA_SASL_PASSWORD="password",
    )

    config = settings.event_reporter_config("knowledge_runtime")

    assert config.sasl_password == "password"
    assert config.adv_quality_detail_enabled is True
    assert config.adv_result_detail_limit == 7
    assert config.validation_error() is None


@pytest.mark.asyncio
async def test_target_uses_normalized_effective_parameters_and_original_result(sink):
    result = {"records": [], "total": 7}
    storage = SimpleNamespace(retrieve=Mock(return_value=result))
    executor = QueryExecutor(
        storage_backend=storage,
        embed_model=object(),
        attribution_factory=lambda: {"retriever_name": "actual-override"},
    )
    returned = await executor.execute(
        knowledge_id="17",
        query="private-query",
        retrieval_config={
            "top_k": 0,
            "score_threshold": 0,
            "retrieval_mode": "keyword",
        },
    )
    assert returned is result
    storage.retrieve.assert_called_once()
    record = records(sink)[0]
    assert record["kb_id"] == "17"
    assert record["data"]["retriever_name"] == "actual-override"
    assert record["data"]["top_k"] == 20
    assert record["data"]["score_threshold"] == 0
    assert record["data"]["stage"] == "target_result"
    assert "private-query" not in json.dumps(record)


@pytest.mark.asyncio
async def test_custom_embedding_retry_async_bridge_emits_once(sink, monkeypatch):
    response = Mock()
    response.json.return_value = {"data": [{"embedding": [0.1, 0.2]}]}
    post = Mock(side_effect=[ConnectionError("private"), response])
    monkeypatch.setattr("knowledge_engine.embedding.custom.requests.post", post)
    monkeypatch.setattr(CustomEmbedding._call_api.retry, "wait", wait_none())
    embedding = CustomEmbedding(
        api_url="https://unused.invalid", model="actual-model", dimensions=2
    )
    assert await embedding._aget_query_embedding("private-input") == [0.1, 0.2]
    assert post.call_count == 2
    emitted = records(sink)
    assert len(emitted) == 1
    assert emitted[0]["data"]["model_name"] == "actual-model"
    assert emitted[0]["status"] == "success"
    assert "private" not in json.dumps(emitted)


@pytest.mark.asyncio
async def test_runtime_lifespan_keeps_optional_invalid_settings_nonfatal(monkeypatch):
    import knowledge_runtime.main as main

    settings = Settings(
        _env_file=None,
        DATABASE_URL="",
        EVENT_KAFKA_REQUEST_TIMEOUT_MS="invalid",
        EVENT_KAFKA_ADV_ATTRIBUTION_ENABLED="true",
    )
    # An environment may supply DATABASE_URL through its other alias.
    settings.database_url = ""
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "setup_logging", Mock())
    monkeypatch.setattr(main, "require_internal_service_token_configured", Mock())
    initialize = Mock()
    shutdown = Mock()
    monkeypatch.setattr(main, "init_event_reporter", initialize)
    monkeypatch.setattr(main, "shutdown_event_reporter", shutdown)
    with pytest.raises(RuntimeError):
        async with main.lifespan(main.app):
            assert initialize.call_args.kwargs["config"].error
            raise RuntimeError("application shutdown")
    shutdown.assert_called_once()


@pytest.mark.asyncio
async def test_resolved_target_attributes_each_backend_without_exposing_config(
    sink, monkeypatch
):
    from knowledge_runtime.services import query_executor as runtime
    from knowledge_runtime.services.config_resolver import QueryConfig
    from knowledge_runtime.services.query_planner import QueryPlanner
    from shared.knowledge_contracts import (
        RuntimeEmbeddingModelConfig,
        RuntimeRetrievalConfig,
        RuntimeRetrieverConfig,
    )

    for kb_id, storage_type in [(11, "elasticsearch"), (22, "milvus")]:
        storage = SimpleNamespace(
            event_storage_type=storage_type,
            retrieve=Mock(return_value={"records": []}),
        )
        model = SimpleNamespace(model_name=f"actual-{kb_id}")
        storage_factory = Mock(return_value=storage)
        embedding_factory = Mock(return_value=model)
        monkeypatch.setattr(
            runtime, "create_storage_backend_from_runtime_config", storage_factory
        )
        monkeypatch.setattr(
            runtime, "create_embedding_model_from_runtime_config", embedding_factory
        )
        config = QueryConfig(
            knowledge_base_id=kb_id,
            index_owner_user_id=7,
            retriever_config=RuntimeRetrieverConfig(
                name=f"retriever-{kb_id}",
                namespace="custom",
                storage_config={"type": storage_type, "api_key": "private"},
            ),
            embedding_model_config=RuntimeEmbeddingModelConfig(
                model_name=f"configured-{kb_id}",
                model_namespace="custom",
                resolved_config={"model_id": f"provider-{kb_id}", "api_key": "private"},
            ),
            retrieval_config=RuntimeRetrievalConfig(top_k=3, score_threshold=0.5),
        )
        target = runtime.QueryExecutor._build_query_target(
            kb_id, config, QueryPlanner().plan("private-query")
        )
        await target.adapter.execute(
            knowledge_id=str(kb_id),
            query="private-query",
            retrieval_config=config.retrieval_config,
        )
        storage_factory.assert_called_once()
        embedding_factory.assert_called_once()
    emitted = records(sink)
    assert [item["data"]["storage_type"] for item in emitted] == [
        "elasticsearch",
        "milvus",
    ]
    assert [item["data"]["model_name"] for item in emitted] == [
        "actual-11",
        "actual-22",
    ]
    assert all(item["data"]["retriever_namespace"] == "custom" for item in emitted)
    assert "private" not in json.dumps(emitted)


@pytest.mark.asyncio
async def test_runtime_final_results_emit_bounded_ranked_identities(sink, monkeypatch):
    from knowledge_runtime.services import query_executor as runtime
    from knowledge_runtime.services.config_resolver import QueryConfig
    from shared.knowledge_contracts import (
        RuntimeEmbeddingModelConfig,
        RuntimeRetrievalConfig,
        RuntimeRetrieverConfig,
    )

    config = QueryConfig(
        knowledge_base_id=11,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever",
            namespace="default",
            storage_config={"type": "milvus"},
        ),
        embedding_model_config=RuntimeEmbeddingModelConfig(
            model_name="embedding",
            model_namespace="default",
            resolved_config={},
        ),
        retrieval_config=RuntimeRetrievalConfig(),
    )
    loader = Mock()
    loader.resolve_query_configs.return_value = {11: config}
    monkeypatch.setattr(
        runtime,
        "query_documents",
        AsyncMock(
            return_value={
                "records": [
                    {
                        "content": "private-content",
                        "title": "private-title",
                        "score": score,
                        "metadata": {"private": True},
                        "knowledge_id": "11",
                        "document_id": document_id,
                    }
                    for document_id, score in [(1, 0.9), (2, 0.8), (3, 0.7)]
                ],
                "total": 7,
                "total_estimated_tokens": 12,
            }
        ),
    )
    monkeypatch.setattr(
        runtime,
        "create_storage_backend_from_runtime_config",
        Mock(return_value=SimpleNamespace(event_storage_type="milvus")),
    )
    monkeypatch.setattr(
        runtime,
        "create_embedding_model_from_runtime_config",
        Mock(return_value=SimpleNamespace(model_name="embedding")),
    )
    request = SimpleNamespace(
        query="private-query",
        user_id=7,
        search_hints=None,
        knowledge_base_ids=[11],
        knowledge_base_retrieval_overrides=None,
        authorized_resources=[SimpleNamespace(knowledge_base_id=11)],
        scope=None,
        document_ids=None,
        metadata_condition=None,
        max_results=3,
    )

    result = await runtime.QueryExecutor(config_loader=loader).execute(request)

    assert len(result.records) == 3
    emitted = records(sink)
    quality_events = [
        item
        for item in emitted
        if item["event_type"] == "knowledge.retrieval.result.observed"
    ]
    usage_events = [
        item
        for item in emitted
        if item["event_type"] == "knowledge.usage.document.recorded"
    ]
    assert [item["document_id"] for item in quality_events] == [1, 2]
    assert [item["data"]["rank"] for item in quality_events] == [1, 2]
    assert all(item["data"]["returned_count"] == 3 for item in quality_events)
    assert usage_events == []
    assert "private" not in json.dumps(emitted)
