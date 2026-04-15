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
from typing import Any, Dict, List, Literal

from pydantic import BaseModel

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool

logger = logging.getLogger(__name__)


class InteractiveFormOption(BaseModel):
    """A single selectable option in an interactive form question."""

    label: str
    value: str
    recommended: bool = False


class InteractiveFormQuestionItem(BaseModel):
    """A normalized question payload for the interactive form."""

    id: str
    question: str
    input_type: Literal["choice", "text"] = "choice"
    options: List[InteractiveFormOption] | None = None
    multi_select: bool = False
    required: bool = True
    default: List[str] | None = None
    placeholder: str | None = None


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
            synthetic_tool_use_id = question_data.get("ask_id") or (
                f"interactive_form_question_{subtask_id}"
            )
            logger.warning(
                f"[InteractiveForm] No interactive_form_question tool block found in session for subtask {subtask_id}. "
                f"Creating synthetic tool block with tool_use_id={synthetic_tool_use_id}"
            )

            await session_manager.add_tool_block(
                subtask_id=subtask_id,
                tool_use_id=synthetic_tool_use_id,
                tool_name="interactive_form_question",
                tool_input=question_data,
                display_name="interactive_form_question",
            )

            ws_emitter = get_webpage_ws_emitter()
            if not ws_emitter:
                logger.warning(
                    "[InteractiveForm] WebSocket emitter not available after synthetic block creation"
                )
                return

            synthetic_block = {
                "id": synthetic_tool_use_id,
                "type": "tool",
                "tool_use_id": synthetic_tool_use_id,
                "tool_name": "interactive_form_question",
                "tool_input": question_data,
                "display_name": "interactive_form_question",
                "status": BlockStatus.PENDING.value,
            }
            await ws_emitter.emit_block_created(
                task_id=task_id,
                subtask_id=subtask_id,
                block=synthetic_block,
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
        "Pass all questions via the 'questions' array. "
        "A single-question form is represented by one item in that array. "
        "The tool returns immediately after showing the form and waits for the user's "
        "answer in a new conversation message."
    ),
    server="interactive_form_question",
    param_descriptions={
        "questions": (
            "List of questions to render in the form. "
            "Use a single item for a single-question form. "
            "Each question is an object with fields: "
            "'id', 'question', 'input_type', 'options', 'multi_select', "
            "'required', 'default', and 'placeholder'. "
            "For choice questions, 'options' should be a list of "
            "{label, value, recommended?} objects."
        ),
    },
)
async def interactive_form_question(
    token_info: TaskTokenInfo,
    questions: List[InteractiveFormQuestionItem],
) -> Dict[str, Any]:
    """Ask the user one or more questions via an interactive form.

    This tool displays an interactive form to the user and returns immediately
    with a __silent_exit__ marker. The current task ends silently, and the user
    fills in the form at their own pace. Their answer arrives as a new
    conversation message, which the AI can then process.

    Args:
        token_info: Task token information (auto-injected)
        questions: List of normalized question objects. Use a single-item list
            for a single-question form.

    Returns:
        Always returns {"__silent_exit__": True, "reason": "..."} to end the
        current task silently. The user's answer arrives as a new conversation.
    """
    if not questions:
        logger.error(
            "[InteractiveForm] Invalid input: task_id=%s, subtask_id=%s, questions is empty",
            token_info.task_id,
            token_info.subtask_id,
        )
        raise ValueError("questions must contain at least one item")

    ask_id = _generate_ask_id(token_info.subtask_id)
    normalized_questions = []
    for raw_question in questions:
        parsed_question = (
            raw_question
            if isinstance(raw_question, InteractiveFormQuestionItem)
            else InteractiveFormQuestionItem.model_validate(raw_question)
        )
        has_options = bool(parsed_question.options)
        normalized_questions.append(
            {
                "id": parsed_question.id,
                "question": parsed_question.question,
                "input_type": parsed_question.input_type if has_options else "text",
                "options": (
                    [option.model_dump() for option in parsed_question.options]
                    if parsed_question.options
                    else None
                ),
                "multi_select": parsed_question.multi_select,
                "required": parsed_question.required,
                "default": parsed_question.default,
                "placeholder": parsed_question.placeholder,
            }
        )

    question_data = {
        "type": "interactive_form_question",
        "ask_id": ask_id,
        "task_id": token_info.task_id,
        "subtask_id": token_info.subtask_id,
        "questions": normalized_questions,
    }

    # Notify frontend directly via WebSocket to render the form card
    await _notify_frontend(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        question_data=question_data,
    )

    # Return immediately - the user will answer via a new conversation message.
    # The __silent_exit__ marker causes the current task to end silently.
    return {
        "__silent_exit__": True,
        "reason": "interactive_form_question form displayed; waiting for user response via new conversation",
    }
