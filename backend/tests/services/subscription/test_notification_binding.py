# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for subscription notification binding workflow."""

from __future__ import annotations

import json
from fnmatch import fnmatch

from app.models.kind import Kind
from app.services.subscription.notification_service import (
    subscription_notification_service,
)


class _FakeRedis:
    def __init__(self):
        self._store: dict[str, str] = {}

    def setex(self, key: str, ttl: int, value: str) -> bool:
        self._store[key] = value
        return True

    def get(self, key: str):
        return self._store.get(key)

    def delete(self, key: str) -> int:
        existed = key in self._store
        self._store.pop(key, None)
        return 1 if existed else 0

    def scan_iter(self, pattern: str):
        for key in list(self._store.keys()):
            if fnmatch(key, pattern):
                yield key

    def close(self):
        return None


def _create_subscription_kind(
    test_db, owner_user_id: int, subscription_id: int = 9001
) -> Kind:
    subscription = Kind(
        id=subscription_id,
        kind="Subscription",
        user_id=owner_user_id,
        name=f"sub-{subscription_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Subscription",
            "metadata": {"name": f"sub-{subscription_id}", "namespace": "default"},
            "spec": {"displayName": "Sub", "taskType": "collection"},
            "_internal": {},
        },
        is_active=True,
    )
    test_db.add(subscription)
    test_db.commit()
    test_db.refresh(subscription)
    return subscription


def test_start_and_cancel_binding_session(test_db, test_user, mocker):
    fake_redis = _FakeRedis()
    mocker.patch(
        "app.services.subscription.notification_service.redis.from_url",
        return_value=fake_redis,
    )

    _create_subscription_kind(test_db, owner_user_id=test_user.id, subscription_id=1001)

    started = subscription_notification_service.start_developer_binding_session(
        test_db,
        subscription_id=1001,
        user_id=test_user.id,
        channel_id=123,
        bind_private=True,
        bind_group=True,
    )
    assert started["status"] == "waiting"
    assert started["bind_private"] is True
    assert started["bind_group"] is True

    # New Redis key format without subscription_id
    pending_key = f"subscription:binding:pending:{test_user.id}:123"
    assert fake_redis.get(pending_key) is not None

    cancelled = subscription_notification_service.cancel_developer_binding_session(
        test_db,
        subscription_id=1001,
        user_id=test_user.id,
        channel_id=123,
    )
    assert cancelled["status"] == "cancelled"
    assert fake_redis.get(pending_key) is None


def test_group_message_emits_group_info_event(test_db, test_user, mocker):
    """Test that group binding emits WebSocket event instead of auto-updating subscription."""
    fake_redis = _FakeRedis()
    mocker.patch(
        "app.services.subscription.notification_service.redis.from_url",
        return_value=fake_redis,
    )
    emit_binding_mock = mocker.patch(
        "app.services.subscription.notification_service.emit_subscription_binding_update"
    )
    emit_group_info_mock = mocker.patch(
        "app.services.subscription.notification_service.emit_subscription_group_info"
    )

    # Create subscription without pre-existing binding config
    _create_subscription_kind(test_db, owner_user_id=test_user.id, subscription_id=1002)

    subscription_notification_service.start_developer_binding_session(
        test_db,
        subscription_id=1002,
        user_id=test_user.id,
        channel_id=123,
        bind_private=False,
        bind_group=True,
    )

    result = subscription_notification_service.handle_dingtalk_binding_from_message(
        test_db,
        user_id=test_user.id,
        channel_id=123,
        conversation_type="group",
        conversation_id="new-group-id",
        sender_id="ding-user-1",
        sender_staff_id="staff-1",
        group_name="Test Group",
    )

    assert result["matched"] is True
    assert result["completed"] is True
    assert result["group_bound"] is True
    assert result["private_bound"] is False

    # WebSocket events should be emitted
    emit_binding_mock.assert_called_once()
    emit_group_info_mock.assert_called_once_with(
        user_id=test_user.id,
        channel_id=123,
        group_name="Test Group",
        group_conversation_id="new-group-id",
    )


def test_group_message_can_also_complete_private_binding(test_db, test_user, mocker):
    fake_redis = _FakeRedis()
    mocker.patch(
        "app.services.subscription.notification_service.redis.from_url",
        return_value=fake_redis,
    )
    mocker.patch(
        "app.services.subscription.notification_service.emit_subscription_binding_update"
    )

    _create_subscription_kind(test_db, owner_user_id=test_user.id, subscription_id=1003)

    subscription_notification_service.start_developer_binding_session(
        test_db,
        subscription_id=1003,
        user_id=test_user.id,
        channel_id=123,
        bind_private=True,
        bind_group=False,
    )

    subscription_notification_service.handle_dingtalk_binding_from_message(
        test_db,
        user_id=test_user.id,
        channel_id=123,
        conversation_type="group",
        conversation_id="group-xyz",
        sender_id="ding-user-2",
        sender_staff_id="staff-2",
    )

    user_bindings = subscription_notification_service.get_user_im_bindings(
        test_db, user_id=test_user.id
    )
    channel_binding = user_bindings.get("123")
    assert channel_binding is not None
    assert channel_binding.sender_id == "ding-user-2"
    assert channel_binding.sender_staff_id == "staff-2"
