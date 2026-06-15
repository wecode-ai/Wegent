# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for namespace-scoped knowledge permissions."""

from typing import Iterable, Literal

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.schemas.namespace import GroupLevel

NamespaceLevel = Literal["personal", "group", "organization"]
PERSONAL_NAMESPACE = "default"


def classify_namespace_level(
    namespace_name: str,
    namespace: Namespace | None = None,
) -> NamespaceLevel:
    """Return the normalized level for a namespace record."""
    if namespace_name == PERSONAL_NAMESPACE:
        return "personal"
    if namespace and namespace.level == GroupLevel.organization.value:
        return "organization"
    return "group"


def load_active_namespace_map(
    db: Session,
    namespace_names: Iterable[str],
) -> dict[str, Namespace]:
    """Return active namespace records keyed by namespace name."""
    filtered_names = sorted(
        {
            namespace_name
            for namespace_name in namespace_names
            if namespace_name and namespace_name != PERSONAL_NAMESPACE
        }
    )
    if not filtered_names:
        return {}

    namespaces = (
        db.query(Namespace)
        .filter(
            Namespace.name.in_(filtered_names),
            Namespace.is_active.is_(True),
        )
        .all()
    )
    return {namespace.name: namespace for namespace in namespaces}


def get_namespace_level(db: Session, namespace_name: str) -> NamespaceLevel:
    """Return the normalized level for an active namespace."""
    namespace_map = load_active_namespace_map(db, [namespace_name])
    return classify_namespace_level(namespace_name, namespace_map.get(namespace_name))


def is_organization_namespace(db: Session, namespace_name: str) -> bool:
    """Return whether the namespace is an active organization namespace."""
    return get_namespace_level(db, namespace_name) == "organization"
