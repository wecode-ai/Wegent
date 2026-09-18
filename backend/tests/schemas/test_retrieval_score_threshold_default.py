# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Each backend schema keeps the default it had before the Milvus branch.

The knowledge base schemas prefill ``0.5`` for the create/edit forms, while the
retrieval request schemas prefill ``0.7`` for programmatic search. The layers
are intentionally not unified: an explicitly passed threshold, including
``0``, is never replaced by a default.
"""

from app.schemas.kind import RetrievalConfig
from app.schemas.knowledge import RetrievalConfigCreate
from app.schemas.knowledge_search import KnowledgeSearchRequest
from app.schemas.rag import RetrieveRequest


def test_create_schema_keeps_the_knowledge_base_default() -> None:
    assert RetrievalConfigCreate().score_threshold == 0.5
    assert RetrievalConfigCreate(score_threshold=0).score_threshold == 0


def test_complete_config_schema_keeps_the_knowledge_base_default() -> None:
    required = {
        "retriever_name": "retriever-1",
        "embedding_config": {"model_name": "embedding-1"},
    }

    assert RetrievalConfig(**required).score_threshold == 0.5
    assert RetrievalConfig(**required, score_threshold=0.7).score_threshold == 0.7


def test_knowledge_search_request_keeps_the_retrieval_default() -> None:
    request = KnowledgeSearchRequest(knowledge_base_id=1, query="release checklist")

    assert request.score_threshold == 0.7
    explicit = KnowledgeSearchRequest(
        knowledge_base_id=1, query="release checklist", score_threshold=0
    )
    assert explicit.score_threshold == 0


def test_retrieve_request_keeps_the_retrieval_default() -> None:
    required = {
        "query": "release checklist",
        "knowledge_id": "7",
        "retriever_ref": {"name": "retriever-1"},
        "embedding_model_ref": {"model_name": "embedding-1"},
    }

    assert RetrieveRequest(**required).score_threshold == 0.7
    assert RetrieveRequest(**required, score_threshold=0.5).score_threshold == 0.5
