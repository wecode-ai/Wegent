# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MR fix-card template helpers."""

from __future__ import annotations

from app.models.delivery import CloudProject
from app.services.gitlab.mr_templates import resolve_status_id


def _project(statuses: list[dict[str, str]] | None) -> CloudProject:
    metadata = {} if statuses is None else {"board_config": {"statuses": statuses}}
    return CloudProject(metadata_json=metadata)


def test_resolve_status_id_inbox_without_board_config() -> None:
    assert resolve_status_id(_project(None), "inbox") == "inbox"


def test_resolve_status_id_inbox_matches_exact_id() -> None:
    statuses = [{"id": "inbox", "name": "收集箱"}]
    assert resolve_status_id(_project(statuses), "inbox") == "inbox"


def test_resolve_status_id_inbox_matches_keyword_name() -> None:
    statuses = [{"id": "backlog", "name": "收集箱"}]
    assert resolve_status_id(_project(statuses), "inbox") == "backlog"


def test_resolve_status_id_inbox_falls_back_to_first_column() -> None:
    statuses = [{"id": "todo", "name": "待办"}, {"id": "done", "name": "已完成"}]
    assert resolve_status_id(_project(statuses), "inbox") == "todo"
