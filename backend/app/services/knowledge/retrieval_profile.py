"""System retrieval profile used to initialize new knowledge bases."""

from __future__ import annotations

from typing import Any

from sqlalchemy import tuple_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.system_config import SystemConfig
from app.schemas.kind import resolve_model_category
from shared.knowledge_module import (
    MODEL_RESOURCE_KIND,
    RETRIEVER_RESOURCE_KIND,
    ProfileHealth,
    RetrievalProfileRecord,
    RetrievalResource,
    evaluate_profile,
)

KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY = "knowledge_base_retrieval_profile"


def build_profile_record(
    db: Session, retrieval_config: dict[str, Any] | None
) -> RetrievalProfileRecord:
    """Build the module record for a stored profile.

    The record carries the stored configuration together with the resolved
    resources this service has authorized. The module then decides whether the
    profile is usable; this function only reports what it found.
    """
    if not retrieval_config:
        return RetrievalProfileRecord()

    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = retrieval_config.get("retriever_namespace", "default")
    embedding_config = retrieval_config.get("embedding_config") or {}
    embedding_name = embedding_config.get("model_name")
    embedding_namespace = embedding_config.get("model_namespace", "default")
    if not retriever_name or not embedding_name:
        return RetrievalProfileRecord(configured=retrieval_config)

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
    embedding_model = resources_by_reference.get(
        ("Model", embedding_name, embedding_namespace)
    )
    embedding_spec = (
        (embedding_model.json or {}).get("spec", {}) if embedding_model else {}
    )

    return RetrievalProfileRecord(
        configured=retrieval_config,
        retriever=(
            RetrievalResource(
                name=retriever_name,
                namespace=retriever_namespace,
                kind=RETRIEVER_RESOURCE_KIND,
            )
            if retriever is not None
            else None
        ),
        embedding_model=(
            RetrievalResource(
                name=embedding_name,
                namespace=embedding_namespace,
                kind=MODEL_RESOURCE_KIND,
                category=resolve_model_category(embedding_spec),
            )
            if embedding_model is not None
            else None
        ),
    )


def profile_health(
    db: Session, retrieval_config: dict[str, Any] | None
) -> ProfileHealth:
    """Validate public resource references without exposing their configuration."""
    return evaluate_profile(build_profile_record(db, retrieval_config))


def load_profile(
    db: Session,
) -> tuple[dict[str, Any] | None, int, RetrievalProfileRecord]:
    """Read the stored profile once and return it with its resolved record.

    The record is what the knowledge module consumes; the module decides whether
    the profile is usable, so this only reports the configuration it found and
    the resources the local service authorized for it.
    """
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
        build_profile_record(db, retrieval_config),
    )


def get_profile(
    db: Session,
) -> tuple[dict[str, Any] | None, int, ProfileHealth]:
    """Return the stored profile and live reference health."""
    retrieval_config, version, record = load_profile(db)
    return retrieval_config, version, evaluate_profile(record)


def save_profile(
    db: Session,
    *,
    retrieval_config: dict[str, Any],
    updated_by: int,
) -> tuple[dict[str, Any], int, ProfileHealth]:
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
