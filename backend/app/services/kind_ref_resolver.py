# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Batch resolution helpers for Kind namespace/name references."""

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
    """Batch load refs with the standard personal-to-public fallback."""
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
                    Kind.is_active == True,
                )
                .all()
            )
            result.update(
                {
                    (row.namespace, row.name): row
                    for row in personal_rows
                    if (row.namespace, row.name) in default_refs
                }
            )

        missing_default_refs = default_refs - set(result)
        if missing_default_refs:
            public_rows = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == kind_type.value,
                    Kind.namespace == "default",
                    Kind.name.in_([name for _, name in missing_default_refs]),
                    Kind.is_active == True,
                )
                .all()
            )
            result.update(
                {
                    (row.namespace, row.name): row
                    for row in public_rows
                    if (row.namespace, row.name) in missing_default_refs
                }
            )

    if group_refs:
        group_rows = (
            db.query(Kind)
            .filter(
                Kind.kind == kind_type.value,
                Kind.namespace.in_([namespace for namespace, _ in group_refs]),
                Kind.name.in_([name for _, name in group_refs]),
                Kind.is_active == True,
            )
            .all()
        )
        for row in group_rows:
            key = (row.namespace, row.name)
            if key in group_refs and key not in result:
                result[key] = row

    return result
