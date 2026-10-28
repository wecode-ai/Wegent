# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Subscription preview ownership and consumption regressions."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import subscription
from app.schemas.subscription import SubscriptionCreate


@pytest.fixture
def preview_data() -> dict:
    """Provide an owned preview with a valid interval configuration."""
    return {
        "user_id": 1,
        "display_name": "Owned preview",
        "trigger_type": "interval",
        "trigger_config": {"value": 1, "unit": "hours"},
        "prompt_template": "Owner prompt",
        "team_id": 10,
        "team_namespace": "default",
    }


def _create() -> dict:
    """Call the tool with the authenticated owner and an existing preview."""
    return json.loads(
        subscription.create_subscription(
            token_info=TaskTokenInfo(
                task_id=11, subtask_id=12, user_id=1, user_name="owner"
            ),
            preview_id="preview_owner",
            display_name="Caller value",
            trigger_type="interval",
            prompt_template="Caller prompt",
        )
    )


@pytest.mark.parametrize("stored_owner", [2, None, "1"])
def test_rejects_foreign_or_missing_owner_before_creation(
    monkeypatch: pytest.MonkeyPatch, preview_data: dict, stored_owner: object
) -> None:
    """Reject another or absent owner before opening a session or consuming data."""
    if stored_owner is None:
        preview_data.pop("user_id")
    else:
        preview_data["user_id"] = stored_owner
    monkeypatch.setattr(subscription, "_get_preview_data", lambda _: preview_data)
    clear = MagicMock()
    session = MagicMock()
    monkeypatch.setattr(subscription, "_clear_preview_data", clear)
    monkeypatch.setattr(subscription, "SessionLocal", session)

    assert _create() == {
        "success": False,
        "error": "Not authorized to confirm this preview",
    }
    session.assert_not_called()
    clear.assert_not_called()


@pytest.mark.parametrize("creation_fails", [False, True])
def test_consumes_owned_preview_only_after_successful_creation(
    monkeypatch: pytest.MonkeyPatch, preview_data: dict, creation_fails: bool
) -> None:
    """Preserve failed previews and consume successful ones after persistence."""
    monkeypatch.setattr(subscription, "_get_preview_data", lambda _: preview_data)
    db = MagicMock()
    monkeypatch.setattr(subscription, "SessionLocal", lambda: db)
    events: list[str] = []

    def create(
        session: MagicMock, *, subscription_in: SubscriptionCreate, user_id: int
    ) -> SimpleNamespace:
        """Represent a committed subscription or a rejected service operation."""
        assert session is db
        assert user_id == preview_data["user_id"]
        assert subscription_in.prompt_template == "Owner prompt"
        assert subscription_in.team_id == preview_data["team_id"]
        events.append("create")
        if creation_fails:
            raise HTTPException(status_code=400, detail="Team unavailable")
        return SimpleNamespace(
            id=20,
            name="owned-preview",
            display_name="Owned preview",
            next_execution_time=None,
        )

    monkeypatch.setattr(
        subscription.subscription_service, "create_subscription", create
    )
    monkeypatch.setattr(
        subscription, "_clear_preview_data", lambda _: events.append("consume")
    )

    result = _create()

    assert result["success"] is not creation_fails
    assert events == (["create"] if creation_fails else ["create", "consume"])
    db.close.assert_called_once()
