# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
send_form MCP tool implementation.

This tool allows AI agents to send interactive forms to users.
"""

import logging
import uuid
from datetime import datetime
from typing import List, Optional

from app.mcp.context import get_task_context
from app.mcp.schemas.form import FormField, SendFormResult

logger = logging.getLogger(__name__)


async def send_form(
    title: str,
    fields: List[FormField],
    description: Optional[str] = None,
    submit_button_text: str = "Submit",
) -> SendFormResult:
    """
    Send an interactive form to the user.

    This tool allows AI agents to send forms with various field types
    to collect structured input from users.

    Note: This tool is asynchronous notification mode. It returns immediately
    after sending the form. The user's submitted data will be sent as a new
    user message in the conversation.

    Args:
        title: Form title
        description: Optional form description
        fields: List of form field definitions
        submit_button_text: Text for the submit button

    Returns:
        SendFormResult containing success status and form_id
    """
    # Get task context
    ctx = get_task_context()
    if not ctx:
        logger.error("[MCP] send_form called without task context")
        return SendFormResult(
            success=False,
            form_id="",
            error="No task context available. This tool must be called within a task.",
        )

    task_id = ctx.task_id
    form_id = f"form_{uuid.uuid4().hex[:12]}"

    logger.info(
        f"[MCP] send_form: task_id={task_id}, title={title}, "
        f"fields_count={len(fields)}"
    )

    try:
        # Import WebSocket emitter
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.error("[MCP] WebSocket emitter not available")
            return SendFormResult(
                success=False,
                form_id=form_id,
                error="WebSocket emitter not available",
            )

        # Build form definition payload
        form_definition = {
            "title": title,
            "description": description,
            "fields": [field.model_dump() for field in fields],
            "submit_button_text": submit_button_text,
        }

        # Build payload for interactive message
        payload = {
            "request_id": form_id,
            "message_type": "form",
            "form": form_definition,
            "timestamp": datetime.now().isoformat(),
        }

        # Emit interactive:message event to task room
        await ws_emitter.emit_interactive_message(task_id=task_id, payload=payload)

        logger.info(f"[MCP] send_form successful: form_id={form_id}")
        return SendFormResult(success=True, form_id=form_id)

    except Exception as e:
        logger.exception(f"[MCP] send_form failed: {e}")
        return SendFormResult(success=False, form_id=form_id, error=str(e))
