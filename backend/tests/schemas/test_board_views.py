# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.board_views import BoardViews


@pytest.mark.parametrize(
    "config",
    [
        {"schema_version": 2, "views": []},
        {"schema_version": 1, "views": [], "default_view_id": "missing"},
        {"schema_version": 1, "views": [], "default_view_id": None},
        {
            "schema_version": 1,
            "views": [{"id": "default", "name": "Reserved", "columns": []}],
        },
        {
            "schema_version": 1,
            "views": [
                {
                    "id": "one",
                    "name": "Duplicate",
                    "columns": [
                        {"id": "a", "type": "tag", "value": "same"},
                        {"id": "b", "type": "tag", "value": "same"},
                    ],
                }
            ],
        },
        {
            "schema_version": 1,
            "views": [
                {
                    "id": "one",
                    "name": "Invalid sort",
                    "columns": [
                        {"id": "a", "type": "tag", "value": "tag"},
                    ],
                    "sorts": {"a": ["created-asc", "created-desc"]},
                }
            ],
        },
    ],
)
def test_rejects_unsupported_or_ambiguous_views(config: dict) -> None:
    with pytest.raises(ValidationError):
        BoardViews.model_validate(config)


def test_accepts_historical_and_explicit_defaults() -> None:
    assert BoardViews.model_validate({"views": []}).default_view_id == "default"
    config = {
        "default_view_id": "mixed",
        "views": [
            {
                "id": "mixed",
                "name": "Mixed",
                "columns": [{"id": "a", "type": "tag", "value": "bug"}],
            }
        ],
    }
    assert BoardViews.model_validate(config).default_view_id == "mixed"
