# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas invent the same "no threshold configured" number as the engines.

A threshold is a rule about a score scale, and the scale belongs to the engine,
so every layer that has to fill an absent value must read the shared constant.
An explicitly passed threshold stays untouched.
"""

from app.schemas.kind import RetrievalConfig
from app.schemas.knowledge import RetrievalConfigCreate
from app.schemas.knowledge_search import KnowledgeSearchRequest
from app.schemas.rag import RetrieveRequest
from shared.models import DEFAULT_SCORE_THRESHOLD


def test_create_schema_fills_an_absent_threshold_with_the_shared_constant() -> None:
    assert RetrievalConfigCreate().score_threshold == DEFAULT_SCORE_THRESHOLD
    assert RetrievalConfigCreate(score_threshold=0.7).score_threshold == 0.7


def test_complete_config_schema_fills_an_absent_threshold() -> None:
    required = {
        "retriever_name": "retriever-1",
        "embedding_config": {"model_name": "embedding-1"},
    }

    assert RetrievalConfig(**required).score_threshold == DEFAULT_SCORE_THRESHOLD
    assert RetrievalConfig(**required, score_threshold=0.7).score_threshold == 0.7


def test_knowledge_search_request_fills_an_absent_threshold() -> None:
    request = KnowledgeSearchRequest(knowledge_base_id=1, query="release checklist")

    assert request.score_threshold == DEFAULT_SCORE_THRESHOLD
    explicit = KnowledgeSearchRequest(
        knowledge_base_id=1, query="release checklist", score_threshold=0.7
    )
    assert explicit.score_threshold == 0.7


def test_retrieve_request_fills_an_absent_threshold() -> None:
    required = {
        "query": "release checklist",
        "knowledge_id": "7",
        "retriever_ref": {"name": "retriever-1"},
        "embedding_model_ref": {"model_name": "embedding-1"},
    }

    assert RetrieveRequest(**required).score_threshold == DEFAULT_SCORE_THRESHOLD
    assert RetrieveRequest(**required, score_threshold=0.7).score_threshold == 0.7
