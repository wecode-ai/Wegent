# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.services.subscription.execution import background_execution_manager


def test_create_execution_appends_group_notification_instruction(
    test_db, test_user
) -> None:
    subscription = Kind(
        user_id=test_user.id,
        kind="Subscription",
        name="daily-alert",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Subscription",
            "metadata": {"name": "daily-alert", "namespace": "default"},
            "spec": {
                "displayName": "Daily alert",
                "trigger": {
                    "type": "interval",
                    "interval": {"value": 1, "unit": "hours"},
                },
                "teamRef": {"name": "alert-team", "namespace": "default"},
                "promptTemplate": "Check the service.",
            },
            "_internal": {
                "notification_channel_bindings": {
                    "9": {
                        "bind_group": True,
                        "group_conversation_id": "conversation-1",
                    }
                }
            },
        },
        is_active=True,
    )
    test_db.add(subscription)
    test_db.commit()
    test_db.refresh(subscription)

    execution = background_execution_manager.create_execution(
        test_db,
        subscription=subscription,
        user_id=test_user.id,
        trigger_type="manual",
        trigger_reason="manual test",
    )

    assert execution.prompt.startswith("Check the service.")
    assert "【静默】" in execution.prompt
    assert "【@列表:1234,1235】" in execution.prompt
