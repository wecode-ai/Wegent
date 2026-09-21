# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding dimension contract enforced when a Model resource is written."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from app.core.exceptions import ValidationException
from knowledge_engine.embedding.contract import is_positive_int

EMBEDDING_MODEL_TYPE = "embedding"


def declared_embedding_dimension(spec: Optional[Mapping[str, Any]]) -> Any:
    """Return the dimension declared by a Model spec, if it declares one."""
    if not spec:
        return None
    embedding_config = spec.get("embeddingConfig") or {}
    if not isinstance(embedding_config, Mapping):
        return None
    return embedding_config.get("dimensions")


def validate_embedding_dimension_declaration(
    *,
    spec: Mapping[str, Any],
    stored_spec: Optional[Mapping[str, Any]],
    name: str,
) -> None:
    """Enforce the embedding dimension contract of a Model resource write.

    Embedding models must declare a stable positive integer dimension. An
    existing model may only gain a dimension it never declared; a declared
    dimension is immutable.
    """
    if not _declares_embedding(spec, stored_spec):
        return

    declared = declared_embedding_dimension(spec)
    if not is_positive_int(declared):
        raise ValidationException(
            f"Embedding model '{name}' must declare a positive integer "
            "embeddingConfig.dimensions"
        )

    stored = declared_embedding_dimension(stored_spec)
    if not is_positive_int(stored):
        # A model that never declared a dimension may declare one once.
        return
    if stored != declared:
        raise ValidationException(
            f"Embedding model '{name}' declares immutable embeddingConfig.dimensions "
            f"{stored}; {declared} is not allowed"
        )


def _model_type(spec: Mapping[str, Any]) -> str:
    """Return the model category, accepting the legacy nested location too."""
    model_type = spec.get("modelType")
    if model_type is None:
        model_config = spec.get("modelConfig") or {}
        if isinstance(model_config, Mapping):
            model_type = model_config.get("modelType")
    return str(model_type or "llm").lower()


def _declares_embedding(
    spec: Mapping[str, Any],
    stored_spec: Optional[Mapping[str, Any]],
) -> bool:
    """Return whether the write concerns an embedding model.

    The stored resource decides as well, so an update cannot silence the
    contract by omitting or changing the declared category.
    """
    if _model_type(spec) == EMBEDDING_MODEL_TYPE:
        return True
    return stored_spec is not None and _model_type(stored_spec) == EMBEDDING_MODEL_TYPE
