# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tools for controlling private IM session state."""

from __future__ import annotations

import asyncio
from typing import Any

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.im.control_service import im_control_service
from app.services.im.session_service import im_session_service


def _missing_im_context() -> dict[str, Any]:
    return {
        "status": "error",
        "message": "IM session context is required for this tool.",
        "state": None,
        "confirmation": None,
    }


async def _load_context(token_info: TaskTokenInfo) -> tuple[Any, str] | None:
    if not token_info.im_session_key:
        return None
    session = await im_session_service.get_session(token_info.im_session_key)
    if session is None or session.user_id != token_info.user_id:
        return None
    db = SessionLocal()
    try:
        bot_purpose = await im_session_service.get_session_bot_purpose(db, session)
    finally:
        db.close()
    return session, bot_purpose


def _run(coro):
    return asyncio.run(coro)


@mcp_tool(
    name="im_control_get_current_state",
    description="Get the current private IM session state and active target.",
    server="im_control",
    exclude_params=["token_info"],
)
def get_current_state(token_info: TaskTokenInfo) -> dict[str, Any]:
    """Get the current private IM session state."""

    async def _execute() -> dict[str, Any]:
        context = await _load_context(token_info)
        if context is None:
            return _missing_im_context()
        session, bot_purpose = context
        return await im_control_service.get_current_state(
            None,
            session=session,
            bot_purpose=bot_purpose,
        )

    return _run(_execute())


@mcp_tool(
    name="im_control_start_new_session",
    description="Start a new private IM session for the current bot mode.",
    server="im_control",
    exclude_params=["token_info"],
)
def start_new_session(token_info: TaskTokenInfo) -> dict[str, Any]:
    """Start a new private IM session."""

    async def _execute() -> dict[str, Any]:
        context = await _load_context(token_info)
        if context is None:
            return _missing_im_context()
        session, bot_purpose = context
        return await im_control_service.start_new_session(
            None,
            session=session,
            bot_purpose=bot_purpose,
        )

    return _run(_execute())


@mcp_tool(
    name="im_control_clear_current_session",
    description="Clear the current private IM session target, asking for confirmation when needed.",
    server="im_control",
    exclude_params=["token_info"],
)
def clear_current_session(token_info: TaskTokenInfo) -> dict[str, Any]:
    """Clear the current private IM session target."""

    async def _execute() -> dict[str, Any]:
        context = await _load_context(token_info)
        if context is None:
            return _missing_im_context()
        session, bot_purpose = context
        return await im_control_service.clear_current_session(
            None,
            session=session,
            bot_purpose=bot_purpose,
        )

    return _run(_execute())


@mcp_tool(
    name="im_control_confirm_pending_action",
    description="Confirm a pending private IM control action.",
    server="im_control",
    exclude_params=["token_info"],
    param_descriptions={
        "action_id": "Pending action ID returned by a previous tool call."
    },
)
def confirm_pending_action(
    token_info: TaskTokenInfo,
    action_id: str,
) -> dict[str, Any]:
    """Confirm a pending private IM control action."""

    async def _execute() -> dict[str, Any]:
        context = await _load_context(token_info)
        if context is None:
            return _missing_im_context()
        session, bot_purpose = context
        return await im_control_service.confirm_pending_action(
            None,
            session=session,
            bot_purpose=bot_purpose,
            action_id=action_id,
        )

    return _run(_execute())


@mcp_tool(
    name="im_control_cancel_pending_action",
    description="Cancel a pending private IM control action.",
    server="im_control",
    exclude_params=["token_info"],
    param_descriptions={"action_id": "Optional pending action ID to cancel."},
)
def cancel_pending_action(
    token_info: TaskTokenInfo,
    action_id: str | None = None,
) -> dict[str, Any]:
    """Cancel a pending private IM control action."""

    async def _execute() -> dict[str, Any]:
        context = await _load_context(token_info)
        if context is None:
            return _missing_im_context()
        session, bot_purpose = context
        return await im_control_service.cancel_pending_action(
            None,
            session=session,
            bot_purpose=bot_purpose,
            action_id=action_id,
        )

    return _run(_execute())
