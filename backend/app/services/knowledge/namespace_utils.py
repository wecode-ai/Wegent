# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for namespace-scoped knowledge permissions."""

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.schemas.namespace import GroupLevel


def is_organization_namespace(db: Session, namespace_name: str) -> bool:
    """Return whether the namespace is an active organization namespace."""
    if namespace_name == "default":
        return False

    namespace = (
        db.query(Namespace.level)
        .filter(
            Namespace.name == namespace_name,
            Namespace.is_active == True,
        )
        .first()
    )
    return namespace is not None and namespace.level == GroupLevel.organization.value
