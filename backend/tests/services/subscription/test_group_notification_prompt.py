# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.services.subscription.execution import background_execution_manager


def test_create_execution_appends_group_notification_instruction(
    test_db, test_user
) -> None:
    """Bound-group executions qualify legacy delivery without suppressing controls."""
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
    assert "【通知路由控制规则】" in execution.prompt
    assert "本规则仅控制群聊通知路由，不改变私聊通知" in execution.prompt
    assert "群聊静默不得影响私聊，不要调用 silent_exit" in execution.prompt
    assert (
        "对已启用群聊通知且支持群聊投递的已绑定群聊，默认必须发送群聊通知"
        in execution.prompt
    )
    assert "不支持群聊投递的绑定不会发送群聊通知，不影响私聊通知" in execution.prompt
    assert "否则对支持群聊投递的绑定一律正常发送" in execution.prompt
    assert "只要启用了群聊通知，默认必须向已绑定群聊发送通知" not in execution.prompt
    assert "card_template_id" not in execution.prompt
    assert "除非任务或用户明确要求本次不通知群聊" in execution.prompt
    assert "不得根据消息是否例行、是否测试、是否成功、是否有异常" in execution.prompt
    assert "【静默】或【silent】" in execution.prompt
    assert "需要 @ 用户时，在最终回答最后单独一行输出" in execution.prompt
    assert "只能使用明确指定或可确定的实际 staffId" in execution.prompt
    assert "不输出任何控制标记" in execution.prompt
    assert "不得写进正文或做解释" in execution.prompt
    assert "控制说明必须放在" not in execution.prompt
    assert "本次结果明确不需要打扰群成员" not in execution.prompt
