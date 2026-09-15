# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from app.services.channels.team_selection import (
    TeamSelection,
    TeamSelectionManager,
    resolve_selected_team,
    team_uses_only_shell_type,
)
from app.services.share.team_share_service import team_share_service


@pytest.mark.asyncio
async def test_set_selection_reports_cache_failure(monkeypatch):
    manager = TeamSelectionManager()
    monkeypatch.setattr(
        "app.services.channels.team_selection.cache_manager.set",
        AsyncMock(return_value=False),
    )

    saved = await manager.set_selection(
        7,
        TeamSelection(team_id=22, team_name="agent"),
    )

    assert saved is False


@pytest.mark.asyncio
async def test_resolve_selected_team_clears_revoked_selection(monkeypatch):
    selection = TeamSelection(
        team_id=22,
        team_name="agent",
        team_namespace="default",
    )
    get_selection = AsyncMock(return_value=selection)
    clear_selection = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.team_selection.team_selection_manager.get_selection",
        get_selection,
    )
    monkeypatch.setattr(
        "app.services.channels.team_selection.team_selection_manager.clear_selection",
        clear_selection,
    )
    monkeypatch.setattr(
        team_share_service, "get_resource", MagicMock(return_value=None)
    )

    team = await resolve_selected_team(object(), 7)

    assert team is None
    clear_selection.assert_awaited_once_with(7, scope=None)


@pytest.mark.asyncio
async def test_resolve_selected_team_returns_accessible_matching_team(monkeypatch):
    selection = TeamSelection(
        team_id=22,
        team_name="agent",
        team_namespace="engineering",
    )
    accessible_team = SimpleNamespace(
        id=22,
        name="agent",
        namespace="engineering",
    )
    monkeypatch.setattr(
        "app.services.channels.team_selection.team_selection_manager.get_selection",
        AsyncMock(return_value=selection),
    )
    clear_selection = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.team_selection.team_selection_manager.clear_selection",
        clear_selection,
    )
    monkeypatch.setattr(
        team_share_service,
        "get_resource",
        MagicMock(return_value=accessible_team),
    )

    team = await resolve_selected_team(object(), 7)

    assert team is accessible_team
    clear_selection.assert_not_awaited()


def test_task_team_requires_every_bot_to_use_claudecode(monkeypatch):
    members = [
        SimpleNamespace(botRef=SimpleNamespace(namespace="default", name="one")),
        SimpleNamespace(botRef=SimpleNamespace(namespace="default", name="two")),
    ]
    team = SimpleNamespace(
        id=22,
        user_id=7,
        json={"kind": "Team"},
    )
    monkeypatch.setattr(
        "app.schemas.kind.Team.model_validate",
        MagicMock(return_value=SimpleNamespace(spec=SimpleNamespace(members=members))),
    )
    monkeypatch.setattr(
        "app.services.channels.team_selection.kindReader.get_by_name_and_namespace",
        MagicMock(side_effect=[SimpleNamespace(), SimpleNamespace()]),
    )
    shell_types = MagicMock(side_effect=["ClaudeCode", "Agno"])
    monkeypatch.setattr(
        "app.services.chat.config.shell_checker.get_shell_type",
        shell_types,
    )

    assert team_uses_only_shell_type(object(), team, "ClaudeCode") is False
    assert shell_types.call_count == 2


def test_task_team_rejects_invalid_bot_or_shell_crd(monkeypatch):
    members = [
        SimpleNamespace(botRef=SimpleNamespace(namespace="default", name="one")),
    ]
    team = SimpleNamespace(
        id=22,
        user_id=7,
        json={"kind": "Team"},
    )
    bot = SimpleNamespace(id=33)
    monkeypatch.setattr(
        "app.schemas.kind.Team.model_validate",
        MagicMock(return_value=SimpleNamespace(spec=SimpleNamespace(members=members))),
    )
    monkeypatch.setattr(
        "app.services.channels.team_selection.kindReader.get_by_name_and_namespace",
        MagicMock(return_value=bot),
    )
    monkeypatch.setattr(
        "app.services.chat.config.shell_checker.get_shell_type",
        MagicMock(side_effect=ValidationError.from_exception_data("Bot", [])),
    )

    assert team_uses_only_shell_type(object(), team, "ClaudeCode") is False
