# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for resolving Kind resources by CRD references."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind


def batch_load_kinds_by_refs(
    db: Session,
    *,
    user_id: int,
    kind_type: Any,
    refs: set[tuple[str, str]],
) -> dict[tuple[str, str], Kind]:
    """
    Batch load kinds by namespace/name refs with fallback behavior.

    Behavior aligns with kindReader.get_by_name_and_namespace for BOT/GHOST:
    - default namespace: personal (user_id) first, fallback to public (user_id=0)
    - non-default namespace: group resource lookup
    """
    if not refs:
        return {}

    result: dict[tuple[str, str], Kind] = {}
    default_refs = {ref for ref in refs if ref[0] == "default"}
    group_refs = refs - default_refs

    if default_refs:
        default_names = [name for _, name in default_refs]
        if user_id != 0:
            personal_rows = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == kind_type.value,
                    Kind.namespace == "default",
                    Kind.name.in_(default_names),
                    Kind.is_active.is_(True),
                )
                .all()
            )
            for row in personal_rows:
                key = (row.namespace, row.name)
                if key in default_refs:
                    result[key] = row

        missing_default_refs = default_refs - set(result.keys())
        if missing_default_refs:
            missing_names = [name for _, name in missing_default_refs]
            public_rows = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == kind_type.value,
                    Kind.namespace == "default",
                    Kind.name.in_(missing_names),
                    Kind.is_active.is_(True),
                )
                .all()
            )
            for row in public_rows:
                key = (row.namespace, row.name)
                if key in missing_default_refs:
                    result[key] = row

    if group_refs:
        group_names = [name for _, name in group_refs]
        group_namespaces = [namespace for namespace, _ in group_refs]
        group_rows = (
            db.query(Kind)
            .filter(
                Kind.kind == kind_type.value,
                Kind.namespace.in_(group_namespaces),
                Kind.name.in_(group_names),
                Kind.is_active.is_(True),
            )
            .all()
        )
        for row in group_rows:
            key = (row.namespace, row.name)
            if key in group_refs and key not in result:
                result[key] = row

    return result
