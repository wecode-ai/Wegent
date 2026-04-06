# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import pytest
from knowledge_runtime.services.handlers import RuntimeHandlers

from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RemoteQueryRequest,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


@pytest.mark.asyncio
async def test_query_handler_executes_engine_queries_and_merges_results(mocker) -> None:
    first_backend = object()
    second_backend = object()
    first_embed_model = object()
    second_embed_model = object()
    first_executor = MagicMock()
    first_executor.execute = AsyncMock(
        return_value={
            "records": [
                {
                    "content": "Lower score",
                    "score": 0.5,
                    "title": "Doc B",
                    "metadata": {"doc_ref": "22"},
                }
            ]
        }
    )
    second_executor = MagicMock()
    second_executor.execute = AsyncMock(
        return_value={
            "records": [
                {
                    "content": "Higher score",
                    "score": 0.9,
                    "title": "Doc A",
                    "metadata": {"doc_ref": "11"},
                }
            ]
        }
    )

    mocker.patch(
        "knowledge_runtime.services.handlers.create_storage_backend_from_runtime_config",
        side_effect=[first_backend, second_backend],
    )
    mocker.patch(
        "knowledge_runtime.services.handlers.create_embedding_model_from_runtime_config",
        side_effect=[first_embed_model, second_embed_model],
    )
    query_executor_cls = mocker.patch(
        "knowledge_runtime.services.handlers.QueryExecutor",
        side_effect=[first_executor, second_executor],
    )

    handlers = RuntimeHandlers()
    request = RemoteQueryRequest(
        knowledge_base_ids=[1, 2],
        query="release checklist",
        max_results=1,
        document_ids=[11, 22],
        metadata_condition={
            "operator": "or",
            "conditions": [
                {"key": "source", "operator": "==", "value": "kb"},
                {"key": "lang", "operator": "==", "value": "zh"},
            ],
        },
        knowledge_base_configs=[
            RemoteKnowledgeBaseQueryConfig(
                knowledge_base_id=1,
                index_owner_user_id=101,
                retriever_config=RuntimeRetrieverConfig(
                    name="retriever-a",
                    storage_config={"type": "qdrant", "url": "http://qdrant:6333"},
                ),
                embedding_model_config=RuntimeEmbeddingModelConfig(
                    model_name="embedding-a",
                    resolved_config={
                        "protocol": "openai",
                        "model_id": "text-embedding-3-small",
                    },
                ),
                retrieval_config=RuntimeRetrievalConfig(
                    top_k=5,
                    score_threshold=0.4,
                    retrieval_mode="vector",
                ),
            ),
            RemoteKnowledgeBaseQueryConfig(
                knowledge_base_id=2,
                index_owner_user_id=202,
                retriever_config=RuntimeRetrieverConfig(
                    name="retriever-b",
                    storage_config={"type": "qdrant", "url": "http://qdrant:6333"},
                ),
                embedding_model_config=RuntimeEmbeddingModelConfig(
                    model_name="embedding-b",
                    resolved_config={
                        "protocol": "openai",
                        "model_id": "text-embedding-3-small",
                    },
                ),
                retrieval_config=RuntimeRetrievalConfig(
                    top_k=5,
                    score_threshold=0.4,
                    retrieval_mode="vector",
                ),
            ),
        ],
    )

    response = await handlers.query(request)

    assert response.model_dump() == {
        "records": [
            {
                "content": "Higher score",
                "title": "Doc A",
                "score": 0.9,
                "metadata": {"doc_ref": "11"},
                "knowledge_base_id": 2,
                "document_id": 11,
                "index_family": "chunk_vector",
            }
        ],
        "total": 1,
        "total_estimated_tokens": 0,
    }
    assert query_executor_cls.call_count == 2
    first_executor.execute.assert_awaited_once_with(
        knowledge_id="1",
        query="release checklist",
        retrieval_config=request.knowledge_base_configs[0].retrieval_config,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {
                    "operator": "and",
                    "conditions": [
                        {"key": "doc_ref", "operator": "in", "value": ["11", "22"]}
                    ],
                },
                {
                    "operator": "or",
                    "conditions": [
                        {"key": "source", "operator": "==", "value": "kb"},
                        {"key": "lang", "operator": "==", "value": "zh"},
                    ],
                },
            ],
        },
        user_id=101,
    )
    second_executor.execute.assert_awaited_once_with(
        knowledge_id="2",
        query="release checklist",
        retrieval_config=request.knowledge_base_configs[1].retrieval_config,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {
                    "operator": "and",
                    "conditions": [
                        {"key": "doc_ref", "operator": "in", "value": ["11", "22"]}
                    ],
                },
                {
                    "operator": "or",
                    "conditions": [
                        {"key": "source", "operator": "==", "value": "kb"},
                        {"key": "lang", "operator": "==", "value": "zh"},
                    ],
                },
            ],
        },
        user_id=202,
    )
