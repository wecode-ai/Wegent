# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Batched resource matching using the database's own string comparisons."""

from collections.abc import Iterator

from sqlalchemy import literal, select, union_all
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import Subquery

from app.models.kind import Kind


def lookup_batches(rows: list[dict[str, str | int]]) -> Iterator[Subquery]:
    """Keep bound-parameter and compound-select sizes within database limits."""
    for offset in range(0, len(rows), 128):
        yield union_all(
            *[
                select(*[literal(value).label(key) for key, value in row.items()])
                for row in rows[offset : offset + 128]
            ]
        ).subquery()


def named_kind_rows(
    db: Session, names: set[str], filters: list[ColumnElement[bool]]
) -> list[tuple[str, Kind]]:
    """Return requested names, preserving case and collation matching in SQL."""
    results: list[tuple[str, Kind]] = []
    for requested in lookup_batches([{"name": name} for name in sorted(names)]):
        results.extend(
            db.query(requested.c.name, Kind)
            .join(Kind, Kind.name == requested.c.name)
            .filter(Kind.is_active.is_(True), *filters)
            .order_by(Kind.id)
            .all()
        )
    return results
