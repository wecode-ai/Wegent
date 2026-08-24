# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for delivery API schema normalization."""

from datetime import datetime

from sqlalchemy import event

from app.models.delivery import (
    LoopNode,
    _adapt_mysql_non_null_defaults,
    adapt_loop_node_values_for_dialect,
)
from app.schemas.delivery import LoopItemResponse


def test_loop_item_response_normalizes_mysql_sentinel_values() -> None:
    now = datetime(2026, 7, 24, 21, 30)

    response = LoopItemResponse.model_validate(
        {
            "id": "PRJ-1",
            "cloud_project_id": "8985366848495719062",
            "sequence_number": 1,
            "parent_id": "",
            "title": "Top-level task",
            "description": "",
            "status": "inbox",
            "assignee_user_id": 0,
            "assignee_team_id": 0,
            "priority": "none",
            "due_at": datetime(1970, 1, 1, 0, 0, 1),
            "sort_order": 0,
            "created_by_user_id": 52,
            "current_delivery_id": "",
            "version": 1,
            "created_at": now,
            "updated_at": now,
            "completed_at": datetime(1970, 1, 1, 0, 0, 1),
        }
    )

    assert response.parent_id is None
    assert response.assignee_user_id is None
    assert response.assignee_team_id is None
    assert response.due_at is None
    assert response.current_delivery_id is None
    assert response.completed_at is None


def test_loop_item_update_adapts_nulls_only_for_mysql() -> None:
    values = {
        "parent_id": None,
        "assignee_team_id": None,
        "due_at": None,
        "completed_at": None,
    }

    mysql_values = adapt_loop_node_values_for_dialect(values, "mysql")
    sqlite_values = adapt_loop_node_values_for_dialect(values, "sqlite")

    assert mysql_values == {
        "parent_id": "",
        "assignee_team_id": 0,
        "due_at": datetime(1970, 1, 1, 0, 0, 1),
        "completed_at": datetime(1970, 1, 1, 0, 0, 1),
    }
    assert sqlite_values == values


def test_loop_item_update_preserves_nullable_mysql_columns() -> None:
    values = {"parent_id": None, "due_at": None, "completed_at": None}

    adapted = adapt_loop_node_values_for_dialect(
        values,
        "mysql",
        frozenset({"completed_at"}),
    )

    assert adapted == {
        "parent_id": None,
        "due_at": None,
        "completed_at": datetime(1970, 1, 1, 0, 0, 1),
    }


def test_team_assignee_sentinel_does_not_change_real_team_ids() -> None:
    adapted = adapt_loop_node_values_for_dialect(
        {"assignee_team_id": 42},
        "mysql",
        frozenset({"assignee_team_id"}),
    )

    assert adapted == {"assignee_team_id": 42}


def test_loop_node_adapts_mysql_non_null_defaults_before_updates() -> None:
    assert event.contains(
        LoopNode,
        "before_update",
        _adapt_mysql_non_null_defaults,
    )
