# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Interactive form render payload helpers for execution events."""

import logging
from typing import Any, Dict, Optional

from app.services.execution.interactive_form_names import is_interactive_form_tool_name
from shared.models import ExecutionEvent

logger = logging.getLogger(__name__)


def build_interactive_form_render_payload(
    event: ExecutionEvent,
) -> Optional[Dict[str, Any]]:
    """Build render payload for an interactive form tool event."""
    if not is_interactive_form_tool_name(event.tool_name):
        return None

    try:
        from app.mcp_server.tools.interactive_form_question import (
            build_render_payload_from_tool_input,
        )

        return build_render_payload_from_tool_input(
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            tool_input=event.tool_input,
        )
    except Exception as exc:
        logger.warning(
            "[InteractiveFormRender] Failed to build render payload: "
            "task_id=%s subtask_id=%s tool_use_id=%s error=%s",
            event.task_id,
            event.subtask_id,
            event.tool_use_id,
            exc,
        )
        return None
