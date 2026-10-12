# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve caller-visible Model and Retriever references to their source Kind."""

from sqlalchemy import Boolean, Integer, String, column, select, table
from sqlalchemy.orm import Session

from shared.models.db import Kind

_namespace = table(
    "namespace",
    column("id", Integer),
    column("name", String),
    column("is_active", Boolean),
)
_resource_members = table(
    "resource_members",
    column("resource_type", String),
    column("resource_id", Integer),
    column("entity_type", String),
    column("entity_id", String),
    column("status", String),
)


def resolve_model_kind(
    db: Session,
    *,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve a direct Model first, then its caller-visible reference."""
    direct_query = db.query(Kind).filter(
        Kind.kind == "Model",
        Kind.name == name,
        Kind.namespace == namespace,
        Kind.is_active.is_(True),
    )
    if namespace == "default":
        direct_query = direct_query.filter(
            (Kind.user_id == user_id) | (Kind.user_id == 0)
        ).order_by(Kind.user_id.desc(), Kind.id.asc())
    else:
        # Group resources are owned by their namespace rather than the caller.
        # Use the oldest record to keep legacy duplicate names deterministic.
        direct_query = direct_query.order_by(Kind.id.asc())
    direct = direct_query.first()
    return direct or resolve_referenced_model_kind(
        db,
        name=name,
        namespace=namespace,
        user_id=user_id,
    )


def resolve_referenced_model_kind(
    db: Session,
    *,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve the smallest-id approved Model in a caller-visible scope."""
    return _resolve_referenced_kind(
        db,
        resource_type="Model",
        name=name,
        namespace=namespace,
        user_id=user_id,
    )


def resolve_referenced_retriever_kind(
    db: Session,
    *,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve the smallest-id approved Retriever in a caller-visible scope."""
    return _resolve_referenced_kind(
        db,
        resource_type="Retriever",
        name=name,
        namespace=namespace,
        user_id=user_id,
    )


def _resolve_referenced_kind(
    db: Session,
    *,
    resource_type: str,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve the smallest-id approved referenced Kind in a caller-visible scope."""
    scope = _reference_scope(db, namespace=namespace, user_id=user_id)
    if scope is None:
        return None
    entity_type, entity_id = scope

    referenced_ids = select(_resource_members.c.resource_id).where(
        _resource_members.c.resource_type == resource_type,
        _resource_members.c.entity_type == entity_type,
        _resource_members.c.entity_id == entity_id,
        _resource_members.c.status == "approved",
    )
    return (
        db.query(Kind)
        .filter(
            Kind.id.in_(referenced_ids),
            Kind.kind == resource_type,
            Kind.name == name,
            Kind.user_id != 0,
            Kind.is_active.is_(True),
        )
        .order_by(Kind.id.asc())
        .first()
    )


def resolve_retriever_kind(
    db: Session,
    *,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve the Retriever Backend authorizes and the runtime loads.

    In ``default`` the caller's own Retriever precedes a same-name public
    Retriever, which precedes an approved shared reference. Other namespaces
    resolve their own Retriever first, then an approved reference, then the
    public fallback. Backend authorization and knowledge_runtime execution both
    use this rule; group permission stays in Backend, and this function only
    resolves visible records.
    """
    direct = _resolve_direct_retriever(
        db, name=name, namespace=namespace, user_id=user_id
    )
    if direct is not None:
        return direct

    referenced = resolve_referenced_retriever_kind(
        db, name=name, namespace=namespace, user_id=user_id
    )
    if referenced is not None:
        return referenced

    return _resolve_public_retriever(db, name=name)


def _resolve_public_retriever(
    db: Session,
    *,
    name: str,
) -> Kind | None:
    """Resolve the smallest-id public Retriever fallback."""
    return (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Retriever",
            Kind.name == name,
            Kind.namespace == "default",
            Kind.is_active.is_(True),
        )
        .order_by(Kind.id.asc())
        .first()
    )


def _resolve_direct_retriever(
    db: Session,
    *,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve a named Retriever that already lives in the requested namespace."""
    query = db.query(Kind).filter(
        Kind.kind == "Retriever",
        Kind.name == name,
        Kind.namespace == namespace,
        Kind.is_active.is_(True),
    )
    if namespace == "default":
        # The caller's own Retriever precedes the public Retriever, which
        # precedes an approved reference resolved by resolve_retriever_kind.
        query = query.filter((Kind.user_id == user_id) | (Kind.user_id == 0)).order_by(
            Kind.user_id.desc(), Kind.id.asc()
        )
    else:
        # Group resources are owned by their namespace rather than the caller.
        query = query.order_by(Kind.id.asc())
    return query.first()


def _reference_scope(
    db: Session,
    *,
    namespace: str,
    user_id: int,
) -> tuple[str, str] | None:
    """Return the ResourceMember entity a caller-visible namespace maps to."""
    if namespace == "default":
        return "user", str(user_id)

    namespace_id = db.execute(
        select(_namespace.c.id).where(
            _namespace.c.name == namespace,
            _namespace.c.is_active.is_(True),
        )
    ).scalar_one_or_none()
    if namespace_id is None:
        return None
    return "namespace", str(namespace_id)
