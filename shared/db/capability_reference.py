# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve caller-visible Model references to their source Kind."""

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
    entity_type = "user"
    entity_id = str(user_id)
    if namespace != "default":
        namespace_id = db.execute(
            select(_namespace.c.id).where(
                _namespace.c.name == namespace,
                _namespace.c.is_active.is_(True),
            )
        ).scalar_one_or_none()
        if namespace_id is None:
            return None
        entity_type = "namespace"
        entity_id = str(namespace_id)

    referenced_ids = select(_resource_members.c.resource_id).where(
        _resource_members.c.resource_type == "Model",
        _resource_members.c.entity_type == entity_type,
        _resource_members.c.entity_id == entity_id,
        _resource_members.c.status == "approved",
    )
    return (
        db.query(Kind)
        .filter(
            Kind.id.in_(referenced_ids),
            Kind.kind == "Model",
            Kind.name == name,
            Kind.user_id != 0,
            Kind.is_active.is_(True),
        )
        .order_by(Kind.id.asc())
        .first()
    )
