# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
send_confirm MCP tool implementation.

This tool allows AI agents to send confirmation dialogs to users.
"""

import logging
import uuid
from datetime import datetime

from app.mcp.context import get_task_context
from app.mcp.schemas.form import SendConfirmResult

logger = logging.getLogger(__name__)


async def send_confirm(
    title: str,
    message: str,
    confirm_text: str = "Confirm",
    cancel_text: str = "Cancel",
) -> SendConfirmResult:
    """
    Send a confirmation dialog to the user.

    The user's choice will be sent as a new user message in the conversation,
    formatted as: "User selected: [Confirm/Cancel]"

    Args:
        title: Dialog title
        message: Confirmation message (supports Markdown)
        confirm_text: Text for the confirm button
        cancel_text: Text for the cancel button

    Returns:
        SendConfirmResult containing success status and confirm_id
    """
    # Get task context
    ctx = get_task_context()
    if not ctx:
        logger.error("[MCP] send_confirm called without task context")
        return SendConfirmResult(
            success=False,
            confirm_id="",
            error="No task context available. This tool must be called within a task.",
        )

    task_id = ctx.task_id
    confirm_id = f"confirm_{uuid.uuid4().hex[:12]}"

    logger.info(f"[MCP] send_confirm: task_id={task_id}, title={title}")

    try:
        # Import WebSocket emitter
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.error("[MCP] WebSocket emitter not available")
            return SendConfirmResult(
                success=False,
                confirm_id=confirm_id,
                error="WebSocket emitter not available",
            )

        # Build confirm definition payload
        confirm_definition = {
            "title": title,
            "message": message,
            "confirm_text": confirm_text,
            "cancel_text": cancel_text,
        }

        # Build payload for interactive message
        payload = {
            "request_id": confirm_id,
            "message_type": "confirm",
            "confirm": confirm_definition,
            "timestamp": datetime.now().isoformat(),
        }

        # Emit interactive:message event to task room
        await ws_emitter.emit_interactive_message(task_id=task_id, payload=payload)

        logger.info(f"[MCP] send_confirm successful: confirm_id={confirm_id}")
        return SendConfirmResult(success=True, confirm_id=confirm_id)

    except Exception as e:
        logger.exception(f"[MCP] send_confirm failed: {e}")
        return SendConfirmResult(success=False, confirm_id=confirm_id, error=str(e))
