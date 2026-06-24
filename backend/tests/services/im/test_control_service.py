# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.im_session import IMPrivateSession
from app.services.im.control_service import im_control_service


@pytest.fixture(autouse=True)
def use_fake_im_session_cache(fake_im_session_cache):
    return fake_im_session_cache


@pytest.mark.asyncio
async def test_get_current_state_reports_wework_target():
    session = IMPrivateSession(
        session_key="s1",
        user_id=1,
        channel_type="weibo",
        channel_id=7,
        conversation_id="conv",
        sender_id="sender",
        active_runtime_task={"localTaskId": "task-1", "title": "Fix login"},
    )

    state = await im_control_service.get_current_state(
        db=None,
        session=session,
        bot_purpose="wework_local",
    )

    assert state["status"] == "success"
    assert state["state"]["bot_purpose"] == "wework_local"
    assert state["state"]["current_target_label"] == "Fix login"


@pytest.mark.asyncio
async def test_clear_current_session_requires_confirmation_for_wework_task():
    session = IMPrivateSession(
        session_key="s1",
        user_id=1,
        channel_type="weibo",
        channel_id=7,
        conversation_id="conv",
        sender_id="sender",
        active_runtime_task={"localTaskId": "task-1", "title": "Fix login"},
    )

    result = await im_control_service.clear_current_session(
        db=None,
        session=session,
        bot_purpose="wework_local",
    )

    assert result["status"] == "needs_confirmation"
    assert result["confirmation"]["action_id"]
    assert session.pending_action_id == result["confirmation"]["action_id"]


@pytest.mark.asyncio
async def test_confirm_pending_clear_removes_wework_task_binding():
    session = IMPrivateSession(
        session_key="s1",
        user_id=1,
        channel_type="weibo",
        channel_id=7,
        conversation_id="conv",
        sender_id="sender",
        active_runtime_task={"localTaskId": "task-1", "title": "Fix login"},
    )
    pending = await im_control_service.clear_current_session(
        db=None,
        session=session,
        bot_purpose="wework_local",
    )

    result = await im_control_service.confirm_pending_action(
        db=None,
        session=session,
        bot_purpose="wework_local",
        action_id=pending["confirmation"]["action_id"],
    )

    assert result["status"] == "success"
    assert session.active_runtime_task is None
    assert session.pending_action_id is None
