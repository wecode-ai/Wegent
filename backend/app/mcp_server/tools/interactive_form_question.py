# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP tool for interactive user input collection.

This tool allows AI agents to ask users questions and collect structured responses
through an interactive form UI. It supports:
- Single choice (radio buttons)
- Multiple choice (checkboxes)
- Free text input
- Multi-question forms (multiple questions in one call, each with independent type)

Async-first design:
- The tool notifies the frontend via WebSocket and returns immediately with a
  __silent_exit__ marker (task ends silently).
- The user fills in the form and submits their answer as a new conversation message.
- This avoids blocking the task and allows users to take as long as needed.

WebSocket notification design:
- The MCP tool directly sends a WebSocket event to the frontend to render the
  interactive form card.
- This avoids the need for a TOOL_INPUT event in the dispatcher/emitter pipeline.
- The tool_use_id (block_id) is passed via TaskTokenInfo so the frontend can
  associate the form with the correct tool block.
"""

import logging
from typing import Any, Dict, List, Optional

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool

logger = logging.getLogger(__name__)


def _generate_ask_id(subtask_id: int) -> str:
    """Generate a unique ID for the interactive_form_question request.

    The ask_id is deterministically derived from subtask_id so the frontend
    can directly locate the pending question using only the subtask_id,
    without complex multi-step lookups.

    Format: ask_{subtask_id}
    """
    return f"ask_{subtask_id}"


async def _notify_frontend(
    task_id: int,
    subtask_id: int,
    question_data: Dict[str, Any],
) -> None:
    """Send WebSocket notification to frontend to render the interactive_form_question form card.

    Finds the interactive_form_question tool block in session_manager, updates its tool_input,
    and emits a chat:block_updated event so the frontend can render the form.

    Args:
        task_id: Task ID for WebSocket room targeting
        subtask_id: Subtask ID for block lookup
        question_data: The question data to send to frontend
    """
    try:
        from app.services.chat.storage.session import session_manager
        from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter
        from shared.models.blocks import BlockStatus

        # Find the interactive_form_question tool block in session_manager blocks.
        # The tool_name may be "interactive_form_question" (Chat Shell path) or
        # "mcp__ask-user_wegent-ask-user__ask_user" (ClaudeCode executor path),
        # so match by checking if the name contains "interactive_form_question".
        blocks = await session_manager.get_blocks(subtask_id)
        tool_use_id = None
        for block in reversed(blocks):
            tool_name = block.get("tool_name", "")
            if block.get("type") == "tool" and "interactive_form_question" in tool_name:
                tool_use_id = block.get("tool_use_id")
                break

        if not tool_use_id:
            logger.warning(
                f"[InteractiveForm] No interactive_form_question tool block found in session for subtask {subtask_id}, "
                "cannot notify frontend"
            )
            return

        # Update tool block in session_manager with question_data as tool_input
        await session_manager.update_tool_block_status(
            subtask_id=subtask_id,
            tool_use_id=tool_use_id,
            tool_input=question_data,
        )

        # Emit chat:block_updated event to frontend
        ws_emitter = get_webpage_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[InteractiveForm] WebSocket emitter not available, cannot notify frontend"
            )
            return

        await ws_emitter.emit_block_updated(
            task_id=task_id,
            subtask_id=subtask_id,
            block_id=tool_use_id,
            tool_input=question_data,
            status=BlockStatus.PENDING.value,
        )
        logger.info(
            f"[InteractiveForm] Notified frontend: task_id={task_id}, subtask_id={subtask_id}, "
            f"tool_use_id={tool_use_id}"
        )
    except Exception as e:
        logger.error(
            f"[InteractiveForm] Failed to notify frontend: task_id={task_id}, "
            f"subtask_id={subtask_id}, error={e}",
            exc_info=True,
        )


@mcp_tool(
    name="interactive_form_question",
    description=(
        "Ask the user one or more questions and display an interactive form. "
        "The tool returns immediately after showing the form - the user fills it in "
        "and submits their answer as a new conversation message. "
        "Use this tool when you need user input before proceeding with a task. "
        "Supports single choice, multiple choice, free text input, "
        "and multi-question forms (multiple questions in one call)."
    ),
    server="interactive_form_question",
    param_descriptions={
        "question": (
            "The question to ask (used in single-question mode). "
            "Ignored when 'questions' is provided."
        ),
        "description": "Optional additional context or explanation for the question",
        "options": (
            "List of options for choice questions (single-question mode). "
            "Each option should have 'label' (display text), 'value' (return value), "
            "and optionally 'recommended' (boolean to mark as recommended choice). "
            "Ignored when 'questions' is provided."
        ),
        "multi_select": (
            "Allow multiple selections in single-question mode (default: false). "
            "Ignored when 'questions' is provided."
        ),
        "input_type": (
            "Type of input in single-question mode: 'choice' (with options) or 'text' (free input). "
            "Ignored when 'questions' is provided."
        ),
        "placeholder": "Placeholder text for text input (single-question mode)",
        "required": "Whether an answer is required (default: true)",
        "default": "Default selected values (list of value strings, single-question mode)",
        "questions": (
            "List of questions for multi-question mode. "
            "Each question is an object with fields: "
            "'id' (unique identifier, e.g. 'q1'), "
            "'question' (question text), "
            "'description' (optional context), "
            "'input_type' ('choice' or 'text'), "
            "'options' (list of {label, value, recommended?} for choice type), "
            "'multi_select' (bool, default false), "
            "'required' (bool, default true), "
            "'default' (list of default value strings). "
            "When provided, the single-question fields (question, options, etc.) are ignored."
        ),
    },
)
async def interactive_form_question(
    token_info: TaskTokenInfo,
    question: str = "",
    description: Optional[str] = None,
    options: Optional[List[Dict[str, Any]]] = None,
    multi_select: bool = False,
    input_type: str = "choice",
    placeholder: Optional[str] = None,
    required: bool = True,
    default: Optional[List[str]] = None,
    questions: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Ask the user one or more questions via an interactive form.

    This tool displays an interactive form to the user and returns immediately
    with a __silent_exit__ marker. The current task ends silently, and the user
    fills in the form at their own pace. Their answer arrives as a new
    conversation message, which the AI can then process.

    Single-question mode (when 'questions' is not provided):
    - Single choice (radio buttons): options provided, multi_select=false
    - Multiple choice (checkboxes): options provided, multi_select=true
    - Free text input: input_type='text' or no options provided

    Multi-question mode (when 'questions' list is provided):
    - Each question can independently be single/multi choice or text

    Args:
        token_info: Task token information (auto-injected)
        question: The question to ask (single-question mode)
        description: Optional additional context (single-question mode)
        options: List of choice options (single-question mode)
        multi_select: Allow multiple selections (single-question mode)
        input_type: "choice" or "text" (single-question mode)
        placeholder: Placeholder for text input (single-question mode)
        required: Whether answer is required
        default: Default selected values (single-question mode)
        questions: List of question objects for multi-question mode

    Returns:
        Always returns {"__silent_exit__": True, "reason": "..."} to end the
        current task silently. The user's answer arrives as a new conversation.
    """
    ask_id = _generate_ask_id(token_info.subtask_id)

    if questions:
        # Multi-question mode: normalize each question's input_type
        normalized_questions = []
        for q in questions:
            q_options = q.get("options")
            q_input_type = q.get("input_type", "choice")
            if not q_options or len(q_options) == 0:
                q_input_type = "text"
            normalized_questions.append(
                {
                    "id": q.get("id", ""),
                    "question": q.get("question", ""),
                    "description": q.get("description"),
                    "input_type": q_input_type,
                    "options": q_options,
                    "multi_select": q.get("multi_select", False),
                    "required": q.get("required", True),
                    "default": q.get("default"),
                    "placeholder": q.get("placeholder"),
                }
            )

        question_data = {
            "type": "interactive_form_question",
            "ask_id": ask_id,
            "task_id": token_info.task_id,
            "subtask_id": token_info.subtask_id,
            # Multi-question mode marker
            "questions": normalized_questions,
            # Top-level question/description for the form header (optional)
            "question": question or "",
            "description": description,
            "required": required,
        }
        logger.info(
            f"[InteractiveForm] Multi-question tool called: ask_id={ask_id}, "
            f"task={token_info.task_id}, num_questions={len(normalized_questions)}"
        )
    else:
        # Single-question mode
        actual_input_type = input_type
        if not options or len(options) == 0:
            actual_input_type = "text"

        question_data = {
            "type": "interactive_form_question",
            "ask_id": ask_id,
            "task_id": token_info.task_id,
            "subtask_id": token_info.subtask_id,
            "question": question,
            "description": description,
            "options": options,
            "multi_select": multi_select,
            "input_type": actual_input_type,
            "placeholder": placeholder,
            "required": required,
            "default": default,
        }
        logger.info(
            f"[InteractiveForm] Single-question tool called: ask_id={ask_id}, "
            f"task={token_info.task_id}, question={question[:50]}..."
        )

    # Notify frontend directly via WebSocket to render the form card
    await _notify_frontend(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        question_data=question_data,
    )

    # Return immediately - the user will answer via a new conversation message.
    # The __silent_exit__ marker causes the current task to end silently.
    logger.info(
        f"[InteractiveForm] Returning silent exit: ask_id={ask_id}, "
        f"task={token_info.task_id}, subtask={token_info.subtask_id}"
    )
    return {
        "__silent_exit__": True,
        "reason": "interactive_form_question form displayed; waiting for user response via new conversation",
    }
