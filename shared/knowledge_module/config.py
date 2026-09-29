# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pure knowledge configuration composition and validation.

Creating or editing a knowledge base resolves one retrieval configuration: the
retriever, embedding model, retrieval mode and retrieval parameters. This module
owns that business rule so every side composes and validates configuration the
same way, without loading Wegent product ORM models, database sessions or task
workers.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional, TypedDict

from .adapter import (
    EMBEDDING_RESOURCE_CATEGORY,
    MODEL_RESOURCE_KIND,
    RETRIEVER_RESOURCE_KIND,
    KnowledgeConfigAdapter,
    RetrievalProfileRecord,
    RetrievalResource,
)

DEFAULT_RETRIEVAL_MODE = "vector"
DEFAULT_TOP_K = 5
DEFAULT_SCORE_THRESHOLD = 0.5
MIN_TOP_K = 1
MAX_TOP_K = 10
VALID_RETRIEVAL_MODES = frozenset({"vector", "keyword", "hybrid"})

# The composition priority, highest first, is: explicit retrieval config,
# explicit resource arguments, a valid system profile, then authorized
# namespace defaults.


class KnowledgeConfigError(ValueError):
    """Raised when a knowledge retrieval configuration violates module rules."""


class ProfileHealth(TypedDict):
    """Safe validation state of a stored system profile."""

    status: Literal["missing", "valid", "invalid"]
    fallback_reason: Optional[
        Literal[
            "retriever_unavailable",
            "embedding_model_unavailable",
            "profile_incomplete",
        ]
    ]


def evaluate_profile(record: RetrievalProfileRecord) -> ProfileHealth:
    """Decide whether a stored profile record is usable for composition.

    The adapter reports the profile's resources only when it has authorized
    them. A record is `valid` only when it names both references and both
    resolved resources match their slot: a Retriever for the retriever slot and a
    Model whose category is ``embedding`` for the embedding slot.
    """
    configured = record.configured
    if not configured:
        return {"status": "missing", "fallback_reason": None}

    retriever_name = configured.get("retriever_name")
    embedding_config = configured.get("embedding_config") or {}
    embedding_name = (
        embedding_config.get("model_name")
        if isinstance(embedding_config, Mapping)
        else None
    )
    if not retriever_name or not embedding_name:
        return {"status": "invalid", "fallback_reason": "profile_incomplete"}

    retriever = record.retriever
    if not _matches_retriever_slot(retriever):
        return {"status": "invalid", "fallback_reason": "retriever_unavailable"}

    embedding_model = record.embedding_model
    if not _matches_embedding_slot(embedding_model):
        return {"status": "invalid", "fallback_reason": "embedding_model_unavailable"}

    return {"status": "valid", "fallback_reason": None}


def prepare_knowledge_config(
    adapter: KnowledgeConfigAdapter,
    *,
    namespace: str = "default",
    retrieval_config: Mapping[str, Any] | None = None,
    retriever_name: str | None = None,
    retriever_namespace: str | None = None,
    embedding_model_name: str | None = None,
    embedding_model_namespace: str | None = None,
    rag_config_mode: str = "auto",
) -> dict[str, Any] | None:
    """Compose and validate the retrieval config written at creation time.

    Explicit input, a valid system profile and authorized candidates are merged
    by the documented priority. When no source supplies a value, the creation
    fallback is ``top_k=5`` and ``score_threshold=0.5``. Returns ``None`` when RAG
    is disabled, or when no retriever or embedding model can be resolved at all,
    so the existing callers keep their "no retrieval config" behaviour.
    """
    if rag_config_mode == "disabled":
        return None

    resolved: dict[str, Any] = {}
    profile = adapter.retrieval_profile()
    if evaluate_profile(profile)["status"] == "valid":
        resolved = _overlay_config(resolved, profile.configured)

    explicit_resources = _explicit_resource_overrides(
        retriever_name=retriever_name,
        retriever_namespace=retriever_namespace,
        embedding_model_name=embedding_model_name,
        embedding_model_namespace=embedding_model_namespace,
    )
    resolved = _overlay_config(resolved, explicit_resources)
    resolved = _overlay_config(resolved, retrieval_config)

    retriever = _read_reference(resolved, "retriever_name", "retriever_namespace")
    if retriever is None:
        retriever = _authorized_retriever(adapter.default_retriever(namespace))

    embedding = _read_embedding_reference(resolved)
    if embedding is None:
        embedding = _authorized_embedding_model(
            adapter.default_embedding_model(namespace)
        )

    if retriever is None or embedding is None:
        return None

    return validate_knowledge_config(
        {
            **resolved,
            "retriever_name": retriever[0],
            "retriever_namespace": retriever[1],
            "embedding_config": {
                "model_name": embedding[0],
                "model_namespace": embedding[1],
            },
        }
    )


def validate_knowledge_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a fully composed create-time config and return its saved shape."""
    normalized = validate_retrieval_config_update(config)

    retriever_name = normalized.get("retriever_name")
    if not isinstance(retriever_name, str) or not retriever_name:
        raise KnowledgeConfigError("retrieval config requires a retriever_name")

    embedding_config = normalized.get("embedding_config") or {}
    if not isinstance(embedding_config, Mapping):
        raise KnowledgeConfigError("retrieval config embedding_config must be a map")
    embedding_name = embedding_config.get("model_name")
    if not isinstance(embedding_name, str) or not embedding_name:
        raise KnowledgeConfigError("retrieval config requires an embedding model_name")

    normalized["retriever_namespace"] = (
        normalized.get("retriever_namespace") or "default"
    )
    normalized.setdefault("retrieval_mode", DEFAULT_RETRIEVAL_MODE)
    normalized.setdefault("top_k", DEFAULT_TOP_K)
    normalized.setdefault("score_threshold", DEFAULT_SCORE_THRESHOLD)
    normalized["embedding_config"] = {
        "model_name": embedding_name,
        "model_namespace": embedding_config.get("model_namespace") or "default",
    }
    return normalized


def validate_retrieval_config_update(
    config: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Validate the retrieval fields an edit writes, ignoring legacy values.

    Edits only write the fields the caller sent, so a knowledge base whose stored
    configuration predates the current limits keeps those stored values; they are
    never re-validated just because another field changed.
    """
    provided = {
        key: value for key, value in (config or {}).items() if value is not None
    }

    mode = provided.get("retrieval_mode")
    if mode is not None and mode not in VALID_RETRIEVAL_MODES:
        raise KnowledgeConfigError(
            f"retrieval_mode must be one of {sorted(VALID_RETRIEVAL_MODES)}, got {mode!r}"
        )

    top_k = provided.get("top_k")
    if top_k is not None and (not isinstance(top_k, int) or isinstance(top_k, bool)):
        raise KnowledgeConfigError("top_k must be an integer")
    if top_k is not None and not (MIN_TOP_K <= top_k <= MAX_TOP_K):
        raise KnowledgeConfigError(
            f"top_k must be between {MIN_TOP_K} and {MAX_TOP_K}, got {top_k!r}"
        )

    score_threshold = provided.get("score_threshold")
    if score_threshold is not None:
        if not isinstance(score_threshold, (int, float)) or isinstance(
            score_threshold, bool
        ):
            raise KnowledgeConfigError("score_threshold must be a number")
        if not 0.0 <= float(score_threshold) <= 1.0:
            raise KnowledgeConfigError(
                f"score_threshold must be between 0.0 and 1.0, "
                f"got {score_threshold!r}"
            )

    hybrid_weights = provided.get("hybrid_weights")
    if hybrid_weights is not None:
        provided["hybrid_weights"] = _validate_hybrid_weights(hybrid_weights)

    return dict(provided)


def _validate_hybrid_weights(weights: Any) -> dict[str, float]:
    model_dump = getattr(weights, "model_dump", None)
    if callable(model_dump):
        weights = model_dump()
    if not isinstance(weights, Mapping):
        raise KnowledgeConfigError("hybrid_weights must be a map")
    vector_weight = weights.get("vector_weight")
    keyword_weight = weights.get("keyword_weight")
    for name, value in (
        ("vector_weight", vector_weight),
        ("keyword_weight", keyword_weight),
    ):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise KnowledgeConfigError(f"hybrid_weights.{name} must be a number")
        if not 0.0 <= float(value) <= 1.0:
            raise KnowledgeConfigError(
                f"hybrid_weights.{name} must be between 0.0 and 1.0, got {value!r}"
            )
    total = float(vector_weight) + float(keyword_weight)
    if not 0.99 <= total <= 1.01:
        raise KnowledgeConfigError(f"hybrid_weights must sum to 1.0, got {total}")
    return {
        "vector_weight": float(vector_weight),
        "keyword_weight": float(keyword_weight),
    }


def _overlay_config(
    base: Mapping[str, Any] | None, override: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Overlay one retrieval config on another, field by field.

    ``embedding_config`` is merged per field so an override that only names the
    model keeps the base namespace, matching how the stored configurations were
    always completed.
    """
    resolved = dict(base or {})
    overrides = dict(override or {})
    base_embedding = resolved.get("embedding_config") or {}
    override_embedding = overrides.pop("embedding_config", None)
    if isinstance(base_embedding, Mapping) or isinstance(override_embedding, Mapping):
        merged_embedding = dict(base_embedding or {})
        merged_embedding.update(dict(override_embedding or {}))
        if merged_embedding:
            resolved["embedding_config"] = merged_embedding
    resolved.update(overrides)
    return {key: value for key, value in resolved.items() if value is not None}


def _explicit_resource_overrides(
    *,
    retriever_name: str | None,
    retriever_namespace: str | None,
    embedding_model_name: str | None,
    embedding_model_namespace: str | None,
) -> dict[str, Any]:
    overrides: dict[str, Any] = {}
    if retriever_name:
        overrides["retriever_name"] = retriever_name
    if retriever_namespace:
        overrides["retriever_namespace"] = retriever_namespace
    embedding: dict[str, Any] = {}
    if embedding_model_name:
        embedding["model_name"] = embedding_model_name
    if embedding_model_namespace:
        embedding["model_namespace"] = embedding_model_namespace
    if embedding:
        overrides["embedding_config"] = embedding
    return overrides


def _read_reference(
    config: Mapping[str, Any], name_key: str, namespace_key: str
) -> tuple[str, str] | None:
    name = config.get(name_key)
    if not isinstance(name, str) or not name:
        return None
    namespace = config.get(namespace_key)
    return (name, namespace if isinstance(namespace, str) and namespace else "default")


def _read_embedding_reference(config: Mapping[str, Any]) -> tuple[str, str] | None:
    embedding_config = config.get("embedding_config")
    if not isinstance(embedding_config, Mapping):
        return None
    return _read_reference(embedding_config, "model_name", "model_namespace")


def _authorized_retriever(
    candidate: RetrievalResource | None,
) -> tuple[str, str] | None:
    if candidate is None:
        return None
    if not _matches_retriever_slot(candidate):
        raise KnowledgeConfigError(
            f"retriever candidate {candidate.name!r} is not a "
            f"{RETRIEVER_RESOURCE_KIND} resource"
        )
    return (candidate.name, candidate.namespace or "default")


def _authorized_embedding_model(
    candidate: RetrievalResource | None,
) -> tuple[str, str] | None:
    if candidate is None:
        return None
    if not _matches_embedding_slot(candidate):
        raise KnowledgeConfigError(
            f"embedding candidate {candidate.name!r} is not an "
            f"{EMBEDDING_RESOURCE_CATEGORY} model"
        )
    return (candidate.name, candidate.namespace or "default")


def _matches_retriever_slot(resource: RetrievalResource | None) -> bool:
    """A retriever slot only accepts a Retriever record."""
    return resource is not None and resource.kind == RETRIEVER_RESOURCE_KIND


def _matches_embedding_slot(resource: RetrievalResource | None) -> bool:
    """An embedding slot only accepts an embedding Model record."""
    return (
        resource is not None
        and resource.kind == MODEL_RESOURCE_KIND
        and resource.category == EMBEDDING_RESOURCE_CATEGORY
    )
