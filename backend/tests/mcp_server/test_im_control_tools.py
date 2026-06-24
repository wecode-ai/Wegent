# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import get_registered_mcp_tools
from app.mcp_server.tools.im_control import get_current_state


def test_im_control_tools_are_registered():
    tools = get_registered_mcp_tools(server="im_control")

    assert "im_control_get_current_state" in tools
    assert "im_control_start_new_session" in tools
    assert "im_control_clear_current_session" in tools
    assert "im_control_confirm_pending_action" in tools
    assert "im_control_cancel_pending_action" in tools


def test_get_current_state_requires_im_session_context():
    token_info = TaskTokenInfo(
        task_id=1,
        subtask_id=1,
        user_id=1,
        user_name="alice",
    )

    result = get_current_state(token_info=token_info)

    assert result["status"] == "error"
    assert "IM session" in result["message"]
