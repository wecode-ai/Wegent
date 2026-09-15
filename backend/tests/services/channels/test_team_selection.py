# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.channels.team_selection import (
    TeamSelection,
    TeamSelectionManager,
    resolve_selected_team,
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
    clear_selection.assert_awaited_once_with(7)


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
