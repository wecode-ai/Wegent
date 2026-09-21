# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dense vector dimension contract of Milvus collections."""

from __future__ import annotations

from typing import Any, NamedTuple, Optional

from pymilvus import MilvusClient

from knowledge_engine.embedding.contract import is_positive_int
from knowledge_engine.embedding.errors import CollectionDimensionMismatchError


class CollectionSnapshot(NamedTuple):
    """What a collection currently declares to the dimension contract."""

    exists: bool
    dimension: Optional[int]


def read_collection_snapshot(
    client: MilvusClient,
    collection_name: str,
) -> CollectionSnapshot:
    """Read whether a collection exists and which vector dimension it stores."""
    if not client.has_collection(collection_name):
        return CollectionSnapshot(exists=False, dimension=None)
    description = client.describe_collection(collection_name=collection_name)
    return CollectionSnapshot(
        exists=True,
        dimension=vector_field_dimension(description),
    )


def vector_field_dimension(description: Any) -> Optional[int]:
    """Return the dimension declared by a collection description, if any."""
    fields = description.get("fields") if isinstance(description, dict) else None
    for field in fields or []:
        params = field.get("params") or {}
        dimension = params.get("dim")
        if is_positive_int(dimension):
            return dimension
    return None


def raise_on_dimension_mismatch(
    *,
    stored_dim: Optional[int],
    expected_dim: int,
    model: str,
) -> None:
    """Fail when an existing collection does not hold the expected dimension.

    Raises:
        CollectionDimensionMismatchError: When the collection vector field
            stores another dimension, or declares no dense vector dimension.
    """
    if stored_dim == expected_dim:
        return
    if stored_dim is None:
        raise CollectionDimensionMismatchError.missing_vector_dimension(
            model=model,
            expected=expected_dim,
        )
    raise CollectionDimensionMismatchError(
        model=model,
        expected=expected_dim,
        actual=stored_dim,
    )


def embedding_model_name(embed_model: Any) -> str:
    """Return a stable, non-sensitive name for an embedding model."""
    name = getattr(embed_model, "model_name", None)
    if isinstance(name, str) and name:
        return name
    return type(embed_model).__name__
