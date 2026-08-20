"""System retrieval profile used to initialize new knowledge bases."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from sqlalchemy import tuple_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.system_config import SystemConfig

KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY = "knowledge_base_retrieval_profile"


class RetrievalProfileHealth(TypedDict):
    """Safe health state for the shared retrieval default."""

    status: Literal["missing", "valid", "invalid"]
    fallback_reason: (
        Literal[
            "retriever_unavailable",
            "embedding_model_unavailable",
            "profile_incomplete",
        ]
        | None
    )


def profile_health(
    db: Session, retrieval_config: dict[str, Any] | None
) -> RetrievalProfileHealth:
    """Validate public resource references without exposing their configuration."""
    if not retrieval_config:
        return {"status": "missing", "fallback_reason": None}

    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = retrieval_config.get("retriever_namespace", "default")
    embedding_config = retrieval_config.get("embedding_config") or {}
    embedding_name = embedding_config.get("model_name")
    embedding_namespace = embedding_config.get("model_namespace", "default")
    if not retriever_name or not embedding_name:
        return {"status": "invalid", "fallback_reason": "profile_incomplete"}
    resources = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.is_active.is_(True),
            tuple_(Kind.kind, Kind.name, Kind.namespace).in_(
                [
                    ("Retriever", retriever_name, retriever_namespace),
                    ("Model", embedding_name, embedding_namespace),
                ]
            ),
        )
        .all()
    )
    resources_by_reference = {
        (resource.kind, resource.name, resource.namespace): resource
        for resource in resources
    }
    retriever = resources_by_reference.get(
        ("Retriever", retriever_name, retriever_namespace)
    )
    if retriever is None:
        return {"status": "invalid", "fallback_reason": "retriever_unavailable"}

    embedding_model = resources_by_reference.get(
        ("Model", embedding_name, embedding_namespace)
    )
    model_spec = (embedding_model.json or {}).get("spec", {}) if embedding_model else {}
    if embedding_model is None or model_spec.get("modelType") != "embedding":
        return {
            "status": "invalid",
            "fallback_reason": "embedding_model_unavailable",
        }

    return {"status": "valid", "fallback_reason": None}


def get_profile(
    db: Session,
) -> tuple[dict[str, Any] | None, int, RetrievalProfileHealth]:
    """Return the stored profile and live reference health."""
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY)
        .first()
    )
    value = config.config_value if config else {}
    retrieval_config = value.get("retrieval_config")
    if not isinstance(retrieval_config, dict):
        retrieval_config = None
    return (
        retrieval_config,
        config.version if config else 0,
        profile_health(db, retrieval_config),
    )


def save_profile(
    db: Session,
    *,
    retrieval_config: dict[str, Any],
    updated_by: int,
) -> tuple[dict[str, Any], int, RetrievalProfileHealth]:
    """Create or replace the profile while retaining only safe references."""
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY)
        .first()
    )
    if config is None:
        config = SystemConfig(
            config_key=KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY,
            config_value={"retrieval_config": retrieval_config},
            version=1,
            updated_by=updated_by,
        )
        db.add(config)
    else:
        config.config_value = {"retrieval_config": retrieval_config}
        config.version += 1
        config.updated_by = updated_by
    db.commit()
    db.refresh(config)
    return retrieval_config, config.version, profile_health(db, retrieval_config)


def merge_profile_defaults(
    profile: dict[str, Any], explicit_config: dict[str, Any] | None
) -> dict[str, Any]:
    """Fill omitted retrieval fields from a healthy profile without overriding input."""
    resolved = dict(profile)
    explicit = dict(explicit_config or {})
    profile_embedding = dict(resolved.get("embedding_config") or {})
    explicit_embedding = explicit.pop("embedding_config", None)
    if isinstance(explicit_embedding, dict):
        profile_embedding.update(explicit_embedding)
    resolved["embedding_config"] = profile_embedding
    resolved.update(explicit)
    return resolved
