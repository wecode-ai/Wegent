# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
send_select MCP tool implementation.

This tool allows AI agents to send selection dialogs to users.
"""

import logging
import uuid
from datetime import datetime
from typing import List, Optional

from app.mcp.context import get_task_context
from app.mcp.schemas.form import SelectOption, SendSelectResult

logger = logging.getLogger(__name__)


async def send_select(
    title: str,
    options: List[SelectOption],
    multiple: bool = False,
    description: Optional[str] = None,
) -> SendSelectResult:
    """
    Send a selection dialog to the user.

    The user's selection will be sent as a new user message in the conversation.

    Args:
        title: Selection dialog title
        options: List of options, each containing value, label, and optional recommended flag
        multiple: Whether multiple selection is allowed
        description: Optional description text

    Returns:
        SendSelectResult containing success status and select_id
    """
    # Get task context
    ctx = get_task_context()
    if not ctx:
        logger.error("[MCP] send_select called without task context")
        return SendSelectResult(
            success=False,
            select_id="",
            error="No task context available. This tool must be called within a task.",
        )

    task_id = ctx.task_id
    select_id = f"select_{uuid.uuid4().hex[:12]}"

    logger.info(
        f"[MCP] send_select: task_id={task_id}, title={title}, "
        f"options_count={len(options)}, multiple={multiple}"
    )

    try:
        # Import WebSocket emitter
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.error("[MCP] WebSocket emitter not available")
            return SendSelectResult(
                success=False,
                select_id=select_id,
                error="WebSocket emitter not available",
            )

        # Build select definition payload
        select_definition = {
            "title": title,
            "options": [opt.model_dump() for opt in options],
            "multiple": multiple,
            "description": description,
        }

        # Build payload for interactive message
        payload = {
            "request_id": select_id,
            "message_type": "select",
            "select": select_definition,
            "timestamp": datetime.now().isoformat(),
        }

        # Emit interactive:message event to task room
        await ws_emitter.emit_interactive_message(task_id=task_id, payload=payload)

        logger.info(f"[MCP] send_select successful: select_id={select_id}")
        return SendSelectResult(success=True, select_id=select_id)

    except Exception as e:
        logger.exception(f"[MCP] send_select failed: {e}")
        return SendSelectResult(success=False, select_id=select_id, error=str(e))
