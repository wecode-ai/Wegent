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


def resolve_referenced_model_kind(
    db: Session,
    *,
    name: str,
    namespace: str,
    user_id: int,
) -> Kind | None:
    """Resolve an approved Model reference in a caller-visible scope."""
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
        .first()
    )
