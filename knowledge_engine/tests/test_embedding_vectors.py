# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the shared batch embedding preparation and vector validation."""

import pytest

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError
from knowledge_engine.embedding.space import compute_embedding_space
from knowledge_engine.embedding.vectors import (
    EmptyEmbeddingBatchError,
    InvalidEmbeddingVectorError,
    prepare_query_vector,
    prepare_text_vectors,
)


class _FakeEmbedModel:
    """Deterministic embed model double recording every call."""

    def __init__(self, vectors, *, configured_dimension=None):
        self.vectors = vectors
        self._configured_dimension = configured_dimension
        self.calls: list[list[str]] = []

    def get_text_embedding_batch(self, texts, **kwargs):
        self.calls.append(list(texts))
        return self.vectors


def test_prepare_text_vectors_returns_validated_vectors():
    """A valid batch is returned unchanged after validation."""
    model = _FakeEmbedModel([[1.0, 0.0], [0.0, 2.0]])

    vectors = prepare_text_vectors(model, ["a", "b"])

    assert vectors == [[1.0, 0.0], [0.0, 2.0]]
    assert model.calls == [["a", "b"]]


def test_prepare_text_vectors_rejects_empty_batch_without_calling_model():
    """An empty batch is rejected before the provider is called."""
    model = _FakeEmbedModel([])

    with pytest.raises(EmptyEmbeddingBatchError):
        prepare_text_vectors(model, [])

    assert model.calls == []


def test_prepare_text_vectors_rejects_count_mismatch():
    """A provider returning fewer vectors than texts is rejected."""
    model = _FakeEmbedModel([[1.0, 0.0]])

    with pytest.raises(InvalidEmbeddingVectorError):
        prepare_text_vectors(model, ["a", "b"])


@pytest.mark.parametrize(
    "vectors",
    [
        [[1.0, 0.0], [1.0]],
        [[1.0, float("nan")]],
        [[1.0, float("inf")]],
        [[0.0, 0.0]],
        [[True, 1.0]],
        [["1", "0"]],
    ],
)
def test_prepare_text_vectors_rejects_invalid_vectors(vectors):
    """Ragged, non-finite, zero-norm and non-numeric vectors are rejected."""
    model = _FakeEmbedModel(vectors)

    with pytest.raises(InvalidEmbeddingVectorError):
        prepare_text_vectors(model, [f"t{i}" for i in range(len(vectors))])


def test_prepare_text_vectors_rejects_configured_dimension_mismatch():
    """The configured model dimension is used to validate, not to guess."""
    model = _FakeEmbedModel([[1.0, 0.0]], configured_dimension=3)

    with pytest.raises(EmbeddingDimensionMismatchError):
        prepare_text_vectors(model, ["a"])


def test_prepare_query_vector_uses_the_query_embedding_entry_point():
    """Queries use the provider's query-side embedding, not the text batch."""

    class _QueryModel:
        def __init__(self):
            self.queries: list[str] = []

        def get_query_embedding(self, query):
            self.queries.append(query)
            return [0.5, 0.5]

    model = _QueryModel()

    assert prepare_query_vector(model, "how does it work") == [0.5, 0.5]
    assert model.queries == ["how does it work"]


def test_compute_embedding_space_is_stable_and_ignores_credentials():
    """The space digest is stable and never contains API keys or tokens."""
    model = _FakeEmbedModel([], configured_dimension=1536)
    model.model_name = "text-embedding-3-small"
    model.api_key = "sk-secret"
    model.api_url = "https://user:pass@example.test/v1/embeddings"

    first = compute_embedding_space(model)
    second = compute_embedding_space(model)

    assert first == second
    assert "sk-secret" not in first
    assert "pass" not in first


def test_compute_embedding_space_differs_across_models():
    """Different model identities produce different space digests."""
    first = _FakeEmbedModel([], configured_dimension=1536)
    first.model_name = "text-embedding-3-small"
    second = _FakeEmbedModel([], configured_dimension=1536)
    second.model_name = "text-embedding-3-large"

    assert compute_embedding_space(first) != compute_embedding_space(second)


def test_compute_embedding_space_differs_across_providers():
    """Same model name and dimension from different providers is a new space."""
    first = _FakeEmbedModel([], configured_dimension=1536)
    first.model_name = "shared-model-name"
    first.api_url = "https://provider-a.test/v1/embeddings"
    second = _FakeEmbedModel([], configured_dimension=1536)
    second.model_name = "shared-model-name"
    second.api_url = "https://provider-b.test/v1/embeddings"

    assert compute_embedding_space(first) != compute_embedding_space(second)


def test_compute_embedding_space_ignores_endpoint_credentials():
    """Rotating keys or userinfo must not change the space digest."""
    with_credentials = _FakeEmbedModel([], configured_dimension=1536)
    with_credentials.model_name = "shared-model-name"
    with_credentials.api_url = (
        "https://user:secret@provider-a.test/v1/embeddings?api-version=1"
    )
    without_credentials = _FakeEmbedModel([], configured_dimension=1536)
    without_credentials.model_name = "shared-model-name"
    without_credentials.api_url = "https://provider-a.test/v1/embeddings"

    assert compute_embedding_space(with_credentials) == compute_embedding_space(
        without_credentials
    )
    assert "secret" not in compute_embedding_space(with_credentials)
