# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.orm.attributes import flag_modified

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import subscription_read as subscription_tools
from app.mcp_server.tools.decorator import get_registered_mcp_tools
from app.models.kind import Kind
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionTaskType,
    SubscriptionTriggerType,
    SubscriptionVisibility,
)
from app.services.subscription import subscription_service

TOKEN_INFO = TaskTokenInfo(
    task_id=11,
    subtask_id=22,
    user_id=33,
    user_name="tester",
)


def _subscription(**overrides):
    """Build a complete subscription response object for serialization tests."""
    values = {
        "id": 42,
        "name": "sub-daily-report",
        "display_name": "Daily report",
        "description": "Real-time subscription state",
        "task_type": SubscriptionTaskType.COLLECTION,
        "visibility": SubscriptionVisibility.PRIVATE,
        "trigger_type": SubscriptionTriggerType.CRON,
        "trigger_config": {"expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
        "team_id": 7,
        "workspace_id": None,
        "git_repo": None,
        "git_domain": None,
        "branch_name": None,
        "model_ref": None,
        "prompt_template": "Write the daily report",
        "preserve_history": True,
        "history_message_count": 10,
        "retry_count": 1,
        "timeout_seconds": 600,
        "enabled": True,
        "is_rental": False,
        "next_execution_time": datetime(2026, 11, 6, 9, 0),
        "last_execution_time": datetime(2026, 11, 5, 9, 0),
        "last_execution_status": "COMPLETED",
        "last_execution_message": None,
        "execution_count": 3,
        "success_count": 2,
        "failure_count": 1,
        "bound_task_id": 0,
        "expires_at": None,
        "is_expired": False,
        "trigger_config_valid": True,
        "trigger_config_error": None,
        "created_at": datetime(2026, 11, 1, 8, 0),
        "updated_at": datetime(2026, 11, 5, 9, 1),
        "knowledge_base_refs": [],
        "skill_refs": [],
        "source_subscription_id": None,
        "source_subscription_name": None,
        "source_subscription_display_name": None,
        "source_owner_username": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_subscription_read_tools_are_registered() -> None:
    tools = get_registered_mcp_tools(server="subscription")

    assert set(tools) == {
        "preview_subscription",
        "create_subscription",
        "list_subscriptions",
        "get_subscription",
    }
    list_params = {
        param["name"]: param for param in tools["list_subscriptions"]["parameters"]
    }
    get_params = {
        param["name"]: param for param in tools["get_subscription"]["parameters"]
    }
    assert list_params["offset"]["default"] == 0
    assert list_params["limit"]["default"] == 20
    assert get_params["subscription_id"]["required"] is True


def test_list_subscriptions_uses_token_user_and_serializes_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = MagicMock()
    service = MagicMock(return_value=([_subscription()], 1, 0))
    monkeypatch.setattr(subscription_tools, "SessionLocal", MagicMock(return_value=db))
    monkeypatch.setattr(
        subscription_tools.subscription_service,
        "list_subscriptions",
        service,
    )

    result = json.loads(
        subscription_tools.list_subscriptions(
            token_info=TOKEN_INFO,
            enabled=True,
            trigger_type="cron",
            offset=5,
            limit=10,
        )
    )

    assert result["success"] is True
    assert result["total"] == 1
    assert result["returned"] == 1
    assert result["items"][0]["id"] == 42
    assert result["items"][0]["enabled"] is True
    assert result["items"][0]["is_active"] is True
    assert result["items"][0]["trigger_summary"] == (
        "Cron表达式: `0 9 * * *` (时区: Asia/Shanghai)"
    )
    assert result["items"][0]["next_execution_time"] == "2026-11-06T09:00:00"
    assert "prompt_template" not in result["items"][0]
    assert "webhook_token" not in result["items"][0]
    service.assert_called_once_with(
        db,
        user_id=TOKEN_INFO.user_id,
        skip=5,
        limit=10,
        enabled=True,
        trigger_type=SubscriptionTriggerType.CRON,
    )
    db.close.assert_called_once_with()


def test_get_subscription_reports_service_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return the tool error contract for non-404 service HTTP failures."""
    db = MagicMock()
    service = MagicMock(
        side_effect=HTTPException(status_code=500, detail="backend unavailable")
    )
    monkeypatch.setattr(subscription_tools, "SessionLocal", MagicMock(return_value=db))
    monkeypatch.setattr(
        subscription_tools.subscription_service,
        "get_subscription",
        service,
    )

    result = json.loads(
        subscription_tools.get_subscription(
            token_info=TOKEN_INFO,
            subscription_id=42,
        )
    )

    assert result["success"] is False
    assert "backend unavailable" in result["error"]
    db.close.assert_called_once_with()


def test_get_subscription_returns_details_for_current_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = MagicMock()
    service = MagicMock(return_value=_subscription())
    monkeypatch.setattr(subscription_tools, "SessionLocal", MagicMock(return_value=db))
    monkeypatch.setattr(
        subscription_tools.subscription_service,
        "get_subscription",
        service,
    )

    result = json.loads(
        subscription_tools.get_subscription(
            token_info=TOKEN_INFO,
            subscription_id=42,
        )
    )

    assert result["success"] is True
    assert result["subscription"]["id"] == 42
    assert result["subscription"]["prompt_template"] == "Write the daily report"
    assert result["subscription"]["execution_count"] == 3
    assert result["subscription"]["is_active"] is True
    service.assert_called_once_with(
        db,
        subscription_id=42,
        user_id=TOKEN_INFO.user_id,
    )
    db.close.assert_called_once_with()


def test_get_subscription_reports_deleted_or_inaccessible_subscription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = MagicMock()
    service = MagicMock(side_effect=HTTPException(status_code=404, detail="not found"))
    monkeypatch.setattr(subscription_tools, "SessionLocal", MagicMock(return_value=db))
    monkeypatch.setattr(
        subscription_tools.subscription_service,
        "get_subscription",
        service,
    )

    result = json.loads(
        subscription_tools.get_subscription(
            token_info=TOKEN_INFO,
            subscription_id=99,
        )
    )

    assert result["success"] is False
    assert "not found" in result["error"]
    db.close.assert_called_once_with()


@pytest.mark.parametrize(
    ("offset", "limit", "expected_error"),
    [
        (-1, 20, "offset"),
        (0, 0, "limit"),
        (0, 101, "limit"),
    ],
)
def test_list_subscriptions_validates_pagination(
    offset: int,
    limit: int,
    expected_error: str,
) -> None:
    result = json.loads(
        subscription_tools.list_subscriptions(
            token_info=TOKEN_INFO,
            offset=offset,
            limit=limit,
        )
    )

    assert result["success"] is False
    assert expected_error in result["error"]


def test_read_tools_return_real_subscription_state(
    mcp_test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    team = Kind(
        user_id=TOKEN_INFO.user_id,
        kind="Team",
        name="subscription-read-team",
        namespace="default",
        json={"spec": {}, "metadata": {"name": "subscription-read-team"}},
        is_active=True,
    )
    mcp_test_db.add(team)
    mcp_test_db.commit()
    mcp_test_db.refresh(team)

    created = subscription_service.create_subscription(
        mcp_test_db,
        subscription_in=SubscriptionCreate(
            name="subscription-read-state",
            namespace="default",
            display_name="Read state",
            team_id=team.id,
            trigger_type="cron",
            trigger_config={
                "expression": "0 9 * * *",
                "timezone": "Asia/Shanghai",
            },
            prompt_template="Report current state",
        ),
        user_id=TOKEN_INFO.user_id,
    )
    session_factory = sessionmaker(
        bind=mcp_test_db.get_bind(),
        expire_on_commit=False,
    )
    monkeypatch.setattr(subscription_tools, "SessionLocal", session_factory)

    listed = json.loads(subscription_tools.list_subscriptions(token_info=TOKEN_INFO))
    fetched = json.loads(
        subscription_tools.get_subscription(
            token_info=TOKEN_INFO,
            subscription_id=created.id,
        )
    )

    assert listed["total"] == 1
    assert listed["items"][0]["id"] == created.id
    assert listed["items"][0]["enabled"] is True
    assert fetched["subscription"]["id"] == created.id
    assert fetched["subscription"]["trigger_config"] == {
        "expression": "0 9 * * *",
        "timezone": "Asia/Shanghai",
    }

    subscription_service.toggle_subscription(
        mcp_test_db,
        subscription_id=created.id,
        user_id=TOKEN_INFO.user_id,
        enabled=False,
    )

    disabled = json.loads(
        subscription_tools.get_subscription(
            token_info=TOKEN_INFO,
            subscription_id=created.id,
        )
    )
    filtered = json.loads(
        subscription_tools.list_subscriptions(
            token_info=TOKEN_INFO,
            enabled=True,
        )
    )

    assert disabled["subscription"]["enabled"] is False
    assert disabled["subscription"]["next_execution_time"] is None
    assert filtered["total"] == 0


def test_list_subscriptions_filters_expired_state_after_disabling(
    mcp_test_db: Session,
) -> None:
    """Apply enabled filters after expired subscriptions are auto-disabled."""
    team = Kind(
        user_id=TOKEN_INFO.user_id,
        kind="Team",
        name="subscription-expired-team",
        namespace="default",
        json={"spec": {}, "metadata": {"name": "subscription-expired-team"}},
        is_active=True,
    )
    mcp_test_db.add(team)
    mcp_test_db.commit()
    mcp_test_db.refresh(team)

    created = subscription_service.create_subscription(
        mcp_test_db,
        subscription_in=SubscriptionCreate(
            name="subscription-expired-state",
            namespace="default",
            display_name="Expired state",
            team_id=team.id,
            trigger_type="cron",
            trigger_config={
                "expression": "0 9 * * *",
                "timezone": "Asia/Shanghai",
            },
            prompt_template="Report expired state",
        ),
        user_id=TOKEN_INFO.user_id,
    )
    subscription = mcp_test_db.get(Kind, created.id)
    assert subscription is not None
    internal = subscription.json["_internal"]
    internal["enabled"] = True
    internal["expires_at"] = (
        datetime.now(timezone.utc) - timedelta(days=1)
    ).isoformat()
    subscription.json["_internal"] = internal
    flag_modified(subscription, "json")
    mcp_test_db.commit()

    enabled, enabled_total, _ = subscription_service.list_subscriptions(
        mcp_test_db,
        user_id=TOKEN_INFO.user_id,
        skip=0,
        limit=1,
        enabled=True,
    )
    disabled, disabled_total, _ = subscription_service.list_subscriptions(
        mcp_test_db,
        user_id=TOKEN_INFO.user_id,
        skip=0,
        limit=1,
        enabled=False,
    )

    assert enabled == []
    assert enabled_total == 0
    assert [item.id for item in disabled] == [created.id]
    assert disabled_total == 1
