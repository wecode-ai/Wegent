# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract tests for pure execution-config resolution.

The module resolves the configuration the runtime executes from the stored
configuration plus the resources the caller authorized. These tests drive it
through a minimal caller that never loads Wegent product tables.
"""

from __future__ import annotations

import pytest

from shared.knowledge_module import (
    AuthorizedRetrievalResources,
    KnowledgeConfigError,
    RetrievalResource,
    resolve_execution_config,
)

_RETRIEVER = RetrievalResource(name="retriever-a", kind="Retriever")
_EMBEDDING = RetrievalResource(name="embed-a", kind="Model", category="embedding")

_STORED_CONFIG = {
    "retriever_name": "retriever-a",
    "retriever_namespace": "default",
    "embedding_config": {"model_name": "embed-a", "model_namespace": "default"},
}


def _authorized() -> AuthorizedRetrievalResources:
    return AuthorizedRetrievalResources(
        retriever=_RETRIEVER, embedding_model=_EMBEDDING
    )


def test_resolves_stored_retrieval_parameters() -> None:
    stored = {
        **_STORED_CONFIG,
        "top_k": 7,
        "score_threshold": 0.42,
        "retrieval_mode": "hybrid",
        "hybrid_weights": {"vector_weight": 0.6, "keyword_weight": 0.4},
    }

    resolved = resolve_execution_config(stored, _authorized())

    assert resolved.retriever == _RETRIEVER
    assert resolved.embedding_model == _EMBEDDING
    assert resolved.retrieval_config == {
        "top_k": 7,
        "score_threshold": 0.42,
        "retrieval_mode": "hybrid",
        "vector_weight": 0.6,
        "keyword_weight": 0.4,
    }


def test_historical_config_without_optional_fields_uses_20_and_0_7() -> None:
    resolved = resolve_execution_config(_STORED_CONFIG, _authorized())

    assert resolved.retrieval_config == {
        "top_k": 20,
        "score_threshold": 0.7,
        "retrieval_mode": "vector",
    }


def test_historical_top_k_beyond_creation_limit_is_kept() -> None:
    stored = {**_STORED_CONFIG, "top_k": 50}

    resolved = resolve_execution_config(stored, _authorized())

    assert resolved.retrieval_config["top_k"] == 50


def test_retrieval_override_replaces_parameters_only() -> None:
    stored = {**_STORED_CONFIG, "top_k": 20, "score_threshold": 0.7}

    resolved = resolve_execution_config(
        stored,
        _authorized(),
        retrieval_override={"top_k": 3, "score_threshold": 0.25},
    )

    assert resolved.retrieval_config["top_k"] == 3
    assert resolved.retrieval_config["score_threshold"] == 0.25
    assert resolved.retriever == _RETRIEVER


def test_rejects_resource_outside_authorized_set() -> None:
    stored = {**_STORED_CONFIG, "retriever_name": "other-retriever"}

    with pytest.raises(KnowledgeConfigError, match="not in the authorized"):
        resolve_execution_config(stored, _authorized())


def test_rejects_missing_authorized_resource() -> None:
    with pytest.raises(KnowledgeConfigError, match="not in the authorized"):
        resolve_execution_config(
            _STORED_CONFIG,
            AuthorizedRetrievalResources(retriever=_RETRIEVER),
        )


def test_rejects_wrong_resource_category() -> None:
    authorized = AuthorizedRetrievalResources(
        retriever=_RETRIEVER,
        embedding_model=RetrievalResource(name="embed-a", kind="Model"),
    )

    with pytest.raises(KnowledgeConfigError, match="not in the authorized"):
        resolve_execution_config(_STORED_CONFIG, authorized)


def test_rejects_incomplete_stored_config() -> None:
    with pytest.raises(KnowledgeConfigError, match="retriever_name"):
        resolve_execution_config({"top_k": 5}, _authorized())


def test_rejects_invalid_retrieval_mode() -> None:
    stored = {**_STORED_CONFIG, "retrieval_mode": "semantic"}

    with pytest.raises(KnowledgeConfigError, match="retrieval_mode"):
        resolve_execution_config(stored, _authorized())


def test_rejects_invalid_score_threshold() -> None:
    stored = {**_STORED_CONFIG, "score_threshold": 1.5}

    with pytest.raises(KnowledgeConfigError, match="score_threshold"):
        resolve_execution_config(stored, _authorized())
