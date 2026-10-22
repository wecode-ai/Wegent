# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pure knowledge execution-config resolution.

Executing a stored knowledge base resolves one retrieval configuration: the
retriever, embedding model and retrieval parameters the runtime actually uses.
This module owns that rule so every side resolves configuration the same way,
without loading Wegent product ORM models, database sessions or task workers.

Only resources the caller authorized for the current operation can be used. The
adapter reports the resolved records for those references; the module compares
them against the stored configuration and rejects anything outside the set.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .adapter import (
    RETRIEVER_RESOURCE_KIND,
    RetrievalResource,
)
from .config import (
    DEFAULT_RETRIEVAL_MODE,
    VALID_RETRIEVAL_MODES,
    KnowledgeConfigError,
    _matches_embedding_slot,
    _matches_retriever_slot,
    _read_embedding_reference,
    _read_reference,
    _validate_hybrid_weights,
)

# Executing a stored configuration that predates the current optional fields
# keeps the runtime's historical fallback, which differs from the creation
# fallback (top_k=5, score_threshold=0.5).
HISTORICAL_TOP_K_FALLBACK = 20
HISTORICAL_SCORE_THRESHOLD_FALLBACK = 0.7


@dataclass(frozen=True)
class AuthorizedRetrievalResources:
    """The retrieval resources the caller authorized for one execution.

    Resource identities describe the logical references the adapter authorized,
    even when a reference resolves to a public record in another namespace.
    The adapter owns that resolution; the module cannot widen the reference.
    ``None`` means the reference is not in the
    authorized set, which rejects the execution instead of widening the lookup.
    """

    retriever: RetrievalResource | None = None
    embedding_model: RetrievalResource | None = None


@dataclass(frozen=True)
class RetrievalResourceSelection:
    """The retrieval resources a caller explicitly selected for one execution.

    The selection names the records the execution must use. Every reference has
    to resolve to a record inside :class:`AuthorizedRetrievalResources`; the
    module rejects anything outside that set instead of falling back to the
    stored configuration.
    """

    retriever_name: str
    embedding_model_name: str
    retriever_namespace: str = "default"
    embedding_model_namespace: str = "default"


@dataclass(frozen=True)
class ResolvedExecutionConfig:
    """One knowledge base's resolved execution configuration."""

    retriever: RetrievalResource
    embedding_model: RetrievalResource
    retrieval_config: dict[str, Any]


def resolve_management_config(
    stored_config: Mapping[str, Any] | None,
    authorized_retriever: RetrievalResource | None,
) -> RetrievalResource:
    """Resolve only the authorized storage resource needed to manage an index."""
    reference = _read_reference(
        dict(stored_config or {}), "retriever_name", "retriever_namespace"
    )
    if reference is None:
        raise KnowledgeConfigError("stored config requires a retriever_name")
    return _authorized_slot(
        reference,
        authorized_retriever,
        matches=_matches_retriever_slot,
        label="retriever",
    )


def resolve_execution_config(
    stored_config: Mapping[str, Any] | None,
    authorized: AuthorizedRetrievalResources,
    *,
    retrieval_override: Mapping[str, Any] | None = None,
    resource_selection: RetrievalResourceSelection | None = None,
) -> ResolvedExecutionConfig:
    """Resolve the configuration used to execute one knowledge base.

    Without a ``resource_selection`` the stored configuration names the
    retriever and embedding model; both must be inside the authorized set for
    this operation. An explicit selection supersedes the stored references,
    which keeps a public caller's authorized resources effective even when the
    knowledge base stores different ones. Missing optional retrieval fields fall
    back to ``top_k=20`` and ``score_threshold=0.7`` for historical
    configurations, and ``retrieval_mode`` defaults to ``vector``.

    Raises :class:`KnowledgeConfigError` when the stored configuration is
    incomplete, when a resource is outside the authorized set, or when the
    effective retrieval parameters are invalid.
    """
    stored = dict(stored_config or {})
    retriever_reference, embedding_reference = _resolve_resource_references(
        stored, resource_selection
    )

    retriever = _authorized_slot(
        retriever_reference,
        authorized.retriever,
        matches=_matches_retriever_slot,
        label=RETRIEVER_RESOURCE_KIND.lower(),
    )
    embedding_model = _authorized_slot(
        embedding_reference,
        authorized.embedding_model,
        matches=_matches_embedding_slot,
        label="embedding model",
    )
    retrieval_config = _resolve_retrieval_parameters(stored, retrieval_override)
    return ResolvedExecutionConfig(
        retriever=retriever,
        embedding_model=embedding_model,
        retrieval_config=retrieval_config,
    )


def _resolve_resource_references(
    stored: Mapping[str, Any],
    selection: RetrievalResourceSelection | None,
) -> tuple[tuple[str, str], tuple[str, str]]:
    """Return the references the execution names, preferring an explicit choice."""
    if selection is not None:
        return (
            (selection.retriever_name, selection.retriever_namespace or "default"),
            (
                selection.embedding_model_name,
                selection.embedding_model_namespace or "default",
            ),
        )

    retriever_reference = _read_reference(
        stored, "retriever_name", "retriever_namespace"
    )
    if retriever_reference is None:
        raise KnowledgeConfigError("stored config requires a retriever_name")
    embedding_reference = _read_embedding_reference(stored)
    if embedding_reference is None:
        raise KnowledgeConfigError("stored config requires an embedding model_name")
    return retriever_reference, embedding_reference


def _authorized_slot(
    reference: tuple[str, str],
    record: RetrievalResource | None,
    *,
    matches,
    label: str,
) -> RetrievalResource:
    """Return the authorized record for a reference, or reject the execution."""
    if not matches(record) or (record.name, record.namespace or "default") != reference:
        raise KnowledgeConfigError(
            f"{label} {reference!r} is not in the authorized retrieval resources"
        )
    assert record is not None
    return record


def _resolve_retrieval_parameters(
    stored: Mapping[str, Any],
    override: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Merge stored retrieval parameters with a per-request override."""
    applied = dict(override or {})

    mode = applied.get("retrieval_mode", stored.get("retrieval_mode"))
    mode = mode or DEFAULT_RETRIEVAL_MODE
    if mode not in VALID_RETRIEVAL_MODES:
        raise KnowledgeConfigError(
            f"retrieval_mode must be one of {sorted(VALID_RETRIEVAL_MODES)}, "
            f"got {mode!r}"
        )

    top_k = applied.get("top_k", stored.get("top_k"))
    if top_k is None:
        top_k = HISTORICAL_TOP_K_FALLBACK
    elif not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1:
        raise KnowledgeConfigError("top_k must be a positive integer")

    score_threshold = applied.get("score_threshold", stored.get("score_threshold"))
    if score_threshold is None:
        score_threshold = HISTORICAL_SCORE_THRESHOLD_FALLBACK
    elif (
        not isinstance(score_threshold, (int, float))
        or isinstance(score_threshold, bool)
        or not 0.0 <= float(score_threshold) <= 1.0
    ):
        raise KnowledgeConfigError(
            f"score_threshold must be between 0.0 and 1.0, got {score_threshold!r}"
        )

    retrieval_config: dict[str, Any] = {
        "top_k": top_k,
        "score_threshold": float(score_threshold),
        "retrieval_mode": mode,
    }
    if mode == "hybrid":
        retrieval_config.update(_resolve_hybrid_weights(applied, stored))
    return retrieval_config


def _resolve_hybrid_weights(
    applied: Mapping[str, Any], stored: Mapping[str, Any]
) -> dict[str, float]:
    """Return validated hybrid weights from a per-request or stored override."""
    vector_weight = applied.get("vector_weight")
    keyword_weight = applied.get("keyword_weight")
    if vector_weight is None and keyword_weight is None:
        weights = stored.get("hybrid_weights")
        if weights is None:
            return {}
        validated = _validate_hybrid_weights(weights)
        return {
            "vector_weight": validated["vector_weight"],
            "keyword_weight": validated["keyword_weight"],
        }

    validated = _validate_hybrid_weights(
        {"vector_weight": vector_weight, "keyword_weight": keyword_weight}
    )
    return {
        "vector_weight": validated["vector_weight"],
        "keyword_weight": validated["keyword_weight"],
    }
