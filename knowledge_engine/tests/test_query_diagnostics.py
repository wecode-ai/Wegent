# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Retrieval diagnostics preserve timing boundaries and request isolation."""

import asyncio
import logging
from unittest.mock import MagicMock

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.diagnostics import (
    knowledge_context,
    log_timing,
    timed_stage,
)
from knowledge_engine.query.executor import QueryExecutor
from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
from shared.telemetry.context.span import get_request_id, request_context


def test_stage_reports_elapsed_time_and_preserves_private_failure(mocker, caplog):
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    mocker.patch("knowledge_engine.diagnostics.perf_counter", side_effect=[1.0, 1.125])
    failure = ValueError("private-provider-response")

    with request_context("request-a"), knowledge_context("157464"):
        with pytest.raises(ValueError) as caught:
            with timed_stage("query_embedding", level=logging.DEBUG):
                raise failure

    assert caught.value is failure
    assert "request_id=request-a kb_id=157464" in caplog.text
    assert "duration_ms=125.0 error_type=ValueError" in caplog.text
    assert "private-provider-response" not in caplog.text
    assert caplog.records[0].levelno == logging.ERROR
    log_timing("outside", "start")
    assert "kb_id=- stage=outside" in caplog.messages[-1]


@pytest.mark.asyncio
async def test_concurrent_queries_keep_context_in_worker_and_measure_queue(
    mocker, caplog
):
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    mocker.patch("knowledge_engine.query.executor.perf_counter", return_value=2.0)
    original_to_thread = asyncio.to_thread

    async def queued_worker(fn, submitted_at, **kwargs):
        await asyncio.sleep(0)
        return await original_to_thread(fn, submitted_at - 0.25, **kwargs)

    mocker.patch("knowledge_engine.query.executor.asyncio.to_thread", queued_worker)

    def retrieve(**kwargs):
        log_timing("worker_probe", "end", expected_kb=kwargs["knowledge_id"])
        return {"records": []}

    storage = MagicMock()
    storage.retrieve.side_effect = retrieve
    executor = QueryExecutor(storage_backend=storage, embed_model=object())

    async def query(kb_id):
        with request_context(f"request-{kb_id}"):
            return await executor.execute(
                knowledge_id=kb_id, query="private query", retrieval_config={}
            )

    with request_context("caller"):
        assert await asyncio.gather(query("1"), query("2")) == [
            {"records": []},
            {"records": []},
        ]
        assert get_request_id() == "caller"

    probes = [m for m in caplog.messages if "stage=worker_probe" in m]
    assert len(probes) == 2
    for kb_id in ("1", "2"):
        assert any(
            f"request_id=request-{kb_id} kb_id={kb_id}" in m
            and f"expected_kb={kb_id}" in m
            for m in probes
        )
    queues = [m for m in caplog.messages if "stage=worker_queue" in m]
    assert len(queues) == 2
    assert all("duration_ms=250.0" in m for m in queues)


@pytest.mark.parametrize("mode", ["hybrid", "vector", "keyword"])
@pytest.mark.parametrize("log_level", [logging.INFO, logging.DEBUG])
def test_es_stages_report_candidate_filtering_without_extra_calls(
    mode, log_level, mocker, caplog
):
    caplog.set_level(log_level, logger="knowledge_engine.diagnostics")
    mocker.patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    backend = ElasticsearchBackend({"url": "http://localhost:9200"})
    store = MagicMock()
    store.query.return_value = MagicMock(
        nodes=[TextNode(text="private document"), TextNode(text="other document")],
        similarities=[1.0, 0.49583],
    )
    create_store = mocker.patch.object(
        backend, "create_vector_store", return_value=store
    )
    embed = MagicMock()
    embed.get_query_embedding.return_value = [0.1, 0.2]

    with request_context("es-request"), knowledge_context("157464"):
        result = backend.retrieve(
            knowledge_id="157464",
            query="private query",
            embed_model=embed,
            retrieval_setting={"retrieval_mode": mode, "score_threshold": 0.5},
        )

    assert len(result["records"]) == 1
    create_store.assert_called_once()
    store.query.assert_called_once()
    assert embed.get_query_embedding.call_count == (0 if mode == "keyword" else 1)
    for stage in ("vector_store_init", "search"):
        assert any(f"stage={stage} event=end" in m for m in caplog.messages)
    if log_level == logging.DEBUG:
        for stage in ("vector_store_init", "search", "result_processing"):
            assert any(f"stage={stage} event=start" in m for m in caplog.messages)
            assert any(f"stage={stage} event=end" in m for m in caplog.messages)
    else:
        assert len(caplog.records) == 3
        assert not any("event=start" in m for m in caplog.messages)
        assert "stage=result_processing" not in caplog.text
        assert "stage=query_embedding" not in caplog.text
    assert "candidates=2 returned_records=1 score_threshold=0.5" in caplog.text
    assert "private document" not in caplog.text
    assert "private query" not in caplog.text


def test_es_embedding_failure_does_not_issue_search(mocker, caplog):
    caplog.set_level(logging.INFO, logger="knowledge_engine.diagnostics")
    mocker.patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    backend = ElasticsearchBackend({"url": "http://localhost:9200"})
    store = MagicMock()
    mocker.patch.object(backend, "create_vector_store", return_value=store)
    embed = MagicMock()
    failure = TimeoutError("private-token")
    embed.get_query_embedding.side_effect = failure

    with pytest.raises(TimeoutError) as caught:
        backend.retrieve(
            knowledge_id="157464",
            query="query",
            embed_model=embed,
            retrieval_setting={"retrieval_mode": "hybrid"},
        )

    assert caught.value is failure
    store.query.assert_not_called()
    assert "stage=query_embedding event=error" in caplog.text
    assert "error_type=TimeoutError" in caplog.text
    assert "private-token" not in caplog.text
