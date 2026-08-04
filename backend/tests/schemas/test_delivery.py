# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for delivery API schema normalization."""

from datetime import datetime

from app.models.delivery import (
    adapt_loop_node_values_for_dialect,
    loop_datetime_unset_value_for_dialect,
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
    assert response.due_at is None
    assert response.current_delivery_id is None
    assert response.completed_at is None


def test_loop_node_adaptation_uses_mysql_sentinels() -> None:
    values = {
        "cloud_project_id": None,
        "parent_id": None,
        "loop_item_id": None,
        "delivery_id": None,
        "public_id": None,
        "project_key": None,
        "storage_prefix": None,
        "next_item_number": None,
        "local_project_id": None,
        "backend_task_id": None,
        "due_at": None,
        "completed_at": None,
    }

    mysql_values = adapt_loop_node_values_for_dialect(values, "mysql")
    sqlite_values = adapt_loop_node_values_for_dialect(values, "sqlite")

    assert mysql_values == {
        "cloud_project_id": "",
        "parent_id": "",
        "loop_item_id": "",
        "delivery_id": "",
        "public_id": "",
        "project_key": "",
        "storage_prefix": "",
        "next_item_number": 1,
        "local_project_id": 0,
        "backend_task_id": 0,
        "due_at": datetime(1970, 1, 1, 0, 0, 1),
        "completed_at": datetime(1970, 1, 1, 0, 0, 1),
    }
    assert sqlite_values == values


def test_loop_datetime_unset_value_matches_dialect_schema() -> None:
    assert loop_datetime_unset_value_for_dialect("mysql") == datetime(
        1970, 1, 1, 0, 0, 1
    )
    assert loop_datetime_unset_value_for_dialect("sqlite") is None
