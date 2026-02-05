# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Silent exit tool for system MCP Server.

This tool allows AI agents to silently terminate execution when the result
doesn't require user attention (e.g., normal status, no anomalies).
"""

import json
import logging
from typing import Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo

logger = logging.getLogger(__name__)


def silent_exit(
    reason: str = "",
    token_info: Optional[TaskTokenInfo] = None,
) -> str:
    """Call this tool when execution result doesn't require user attention.

    For example: regular status checks with no anomalies, routine data collection
    with expected results, or monitoring tasks where everything is normal.
    This will end the execution immediately and hide it from the timeline by default.

    Args:
        reason: Optional reason for silent exit (for logging only, not shown to user)
        token_info: Task token info for context (optional)

    Returns:
        JSON string with silent exit marker
    """
    if token_info:
        logger.info(
            f"[MCP] Silent exit called for task={token_info.task_id}, "
            f"subtask={token_info.subtask_id}, user={token_info.user_name}, "
            f"reason={reason}"
        )
    else:
        logger.info(f"[MCP] Silent exit called with reason: {reason}")

    # Update subtask status to trigger COMPLETED_SILENT
    if token_info:
        try:
            _update_subtask_silent_exit(token_info.subtask_id, reason)
        except Exception as e:
            logger.error(f"[MCP] Failed to update subtask for silent exit: {e}")

    # Return special marker that clients can detect
    return json.dumps({"__silent_exit__": True, "reason": reason})


def _update_subtask_silent_exit(subtask_id: int, reason: str) -> None:
    """Update subtask to mark it as silent exit.

    Args:
        subtask_id: Subtask ID to update
        reason: Reason for silent exit
    """
    from datetime import datetime

    from sqlalchemy.orm.attributes import flag_modified

    from app.models.subtask import Subtask, SubtaskStatus

    db = SessionLocal()
    try:
        subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
        if subtask:
            # Update result to include silent_exit marker
            if subtask.result is None:
                subtask.result = {}
            subtask.result["silent_exit"] = True
            subtask.result["silent_exit_reason"] = reason
            subtask.status = SubtaskStatus.COMPLETED
            subtask.progress = 100
            subtask.updated_at = datetime.now()
            flag_modified(subtask, "result")
            db.commit()
            logger.info(f"[MCP] Marked subtask {subtask_id} as silent exit")
        else:
            logger.warning(f"[MCP] Subtask {subtask_id} not found for silent exit")
    except Exception as e:
        db.rollback()
        logger.error(f"[MCP] Error updating subtask {subtask_id}: {e}")
        raise
    finally:
        db.close()
