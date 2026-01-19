# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
send_message MCP tool implementation.

This tool allows AI agents to send text or markdown messages to users
with optional attachments.
"""

import logging
import uuid
from datetime import datetime
from typing import List, Literal, Optional

from app.mcp.context import get_task_context
from app.mcp.schemas.message import Attachment, SendMessageResult

logger = logging.getLogger(__name__)


async def send_message(
    content: str,
    message_type: Literal["text", "markdown"] = "markdown",
    attachments: Optional[List[Attachment]] = None,
) -> SendMessageResult:
    """
    Send a message to the user in the current task.

    This tool allows AI agents to proactively send messages to users,
    including text, markdown content, and attachments.

    Args:
        content: Message content (supports Markdown format)
        message_type: Message type - 'text' for plain text, 'markdown' for rich text
        attachments: Optional list of attachments, each containing name, url, mime_type

    Returns:
        SendMessageResult containing success status and message_id

    Note:
        The task_id is automatically obtained from the execution context.
        No need to explicitly pass it.
    """
    # Get task context
    ctx = get_task_context()
    if not ctx:
        logger.error("[MCP] send_message called without task context")
        return SendMessageResult(
            success=False,
            message_id="",
            error="No task context available. This tool must be called within a task.",
        )

    task_id = ctx.task_id
    message_id = f"msg_{uuid.uuid4().hex[:12]}"

    logger.info(
        f"[MCP] send_message: task_id={task_id}, message_type={message_type}, "
        f"content_length={len(content)}, attachments_count={len(attachments) if attachments else 0}"
    )

    try:
        # Import WebSocket emitter
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.error("[MCP] WebSocket emitter not available")
            return SendMessageResult(
                success=False,
                message_id=message_id,
                error="WebSocket emitter not available",
            )

        # Build payload for interactive message
        payload = {
            "request_id": message_id,
            "message_type": message_type,
            "content": content,
            "attachments": (
                [att.model_dump() for att in attachments] if attachments else []
            ),
            "timestamp": datetime.now().isoformat(),
        }

        # Emit interactive:message event to task room
        await ws_emitter.emit_interactive_message(task_id=task_id, payload=payload)

        logger.info(f"[MCP] send_message successful: message_id={message_id}")
        return SendMessageResult(success=True, message_id=message_id)

    except Exception as e:
        logger.exception(f"[MCP] send_message failed: {e}")
        return SendMessageResult(
            success=False, message_id=message_id, error=str(e)
        )
