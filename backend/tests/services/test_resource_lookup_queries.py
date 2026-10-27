# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Large capability lookups retain exact request names and source filters."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.resource_lookup_queries import named_kind_rows


def test_large_lookup_batches_preserve_names_and_scope(test_db: Session) -> None:
    names = {f"model-{index}" for index in range(501)}
    test_db.add_all(
        Kind(user_id=1, kind="Model", namespace="default", name=name, json={})
        for name in names
    )
    test_db.add_all(
        [
            Kind(user_id=2, kind="Model", namespace="default", name="other", json={}),
            Kind(
                user_id=1,
                kind="Model",
                namespace="default",
                name="inactive",
                is_active=False,
                json={},
            ),
        ]
    )
    test_db.flush()

    matches = named_kind_rows(
        test_db,
        names | {"other", "inactive", "missing"},
        [Kind.user_id == 1, Kind.kind == "Model", Kind.namespace == "default"],
    )

    assert len(matches) == len(names)
    assert {requested for requested, _ in matches} == names
    assert all(requested == row.name and row.user_id == 1 for requested, row in matches)
