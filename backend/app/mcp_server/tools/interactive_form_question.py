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
  interactive form card when the real tool block is already available.
- The execution event pipeline remains authoritative: it attaches the
  render_payload to the real tool_use_id block on TOOL_RESULT for both Chat
  Shell and Claude Code.
"""

import json
import logging
import re
from typing import Any, Dict, List, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool

logger = logging.getLogger(__name__)

FORM_RENDERED_REASON = (
    "interactive_form_question form displayed; STOP here and waiting for user "
    "response via new conversation"
)

TEXT_INPUT_TYPE_ALIASES = {
    "text",
    "text_input",
    "textarea",
    "long_text",
    "short_text",
    "string",
    "input",
    "free_text",
}
SINGLE_CHOICE_INPUT_TYPE_ALIASES = {
    "choice",
    "single_choice",
    "single_select",
    "select",
    "dropdown",
    "radio",
    "radio_group",
    "enum",
    "option",
}
QUESTION_TEXT_KEYS = ("question", "title", "prompt", "label", "text")
INPUT_TYPE_KEYS = ("input_type", "inputType", "question_type", "questionType")
MULTI_SELECT_KEYS = ("multi_select", "multiSelect", "multiple", "multi")
EMBEDDED_QUESTION_PATTERN = re.compile(
    r"(?P<input_type>[a-zA-Z0-9_\-\s]+)\s*\(\s*question\s*\(",
    re.IGNORECASE,
)
MULTI_CHOICE_INPUT_TYPE_ALIASES = {
    "multi_select",
    "multiple_select",
    "multiselect",
    "multi_choice",
    "multiple_choice",
    "checkbox",
    "checkboxes",
    "checkbox_group",
}


class InteractiveFormOption(BaseModel):
    """A single selectable option in an interactive form question."""

    label: str
    value: str
    recommended: bool = False

    @field_validator("label", "value")
    @classmethod
    def validate_non_empty_string(cls, value: str) -> str:
        """Reject empty option labels and values before rendering."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("option label and value must not be empty")
        return normalized


class InteractiveFormQuestionItem(BaseModel):
    """A model-provided question payload accepted by the MCP tool."""

    id: str
    question: str
    input_type: str = "choice"
    options: List[InteractiveFormOption] | None = None
    multi_select: bool = False
    required: bool = True
    default: List[str] | str | None = None
    placeholder: str | None = None

    @field_validator("id", "question")
    @classmethod
    def validate_non_empty_string(cls, value: str) -> str:
        """Reject empty IDs and question labels before normalization."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("question id and question text must not be empty")
        return normalized

    @field_validator("input_type")
    @classmethod
    def validate_input_type_alias(cls, value: str) -> str:
        """Reject empty input type aliases before normalization."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("input_type must not be empty")
        return normalized


class RenderedInteractiveFormQuestion(BaseModel):
    """Strict frontend-renderable question schema emitted in render_payload."""

    id: str
    question: str
    input_type: Literal["choice", "text"]
    options: List[InteractiveFormOption] | None = None
    multi_select: bool = False
    required: bool = True
    default: List[str] | None = None
    placeholder: str | None = None

    @field_validator("id", "question")
    @classmethod
    def validate_non_empty_string(cls, value: str) -> str:
        """Rendered questions must have stable IDs and visible labels."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("rendered question id and question text must not be empty")
        return normalized

    @model_validator(mode="after")
    def validate_renderable_shape(self) -> "RenderedInteractiveFormQuestion":
        """Ensure every emitted question can produce a visible frontend control."""
        if self.input_type == "choice":
            if not self.options:
                raise ValueError("choice questions must include at least one option")
            return self

        if self.options:
            raise ValueError("text questions must not include choice options")
        if self.multi_select:
            raise ValueError("text questions must not enable multi_select")
        return self


class RenderedInteractiveForm(BaseModel):
    """Strict frontend-renderable form schema emitted in render_payload."""

    type: Literal["interactive_form_question"]
    task_id: int
    subtask_id: int
    questions: List[RenderedInteractiveFormQuestion] = Field(min_length=1)


def _normalize_input_type(
    input_type: str,
    has_options: bool,
    explicit_multi_select: bool,
) -> tuple[str, bool]:
    """Normalize common model-provided input type aliases to frontend types."""
    normalized = input_type.strip().lower().replace("-", "_").replace(" ", "_")

    if normalized in TEXT_INPUT_TYPE_ALIASES:
        return "text", False
    if normalized in MULTI_CHOICE_INPUT_TYPE_ALIASES:
        return ("choice", True) if has_options else ("text", False)
    if normalized in SINGLE_CHOICE_INPUT_TYPE_ALIASES:
        return ("choice", explicit_multi_select) if has_options else ("text", False)

    if explicit_multi_select and has_options:
        return "choice", True
    if has_options:
        return "choice", False
    return "text", False


def _normalize_default(default: List[str] | str | None) -> List[str] | None:
    """Normalize model-provided default values to the frontend list shape."""
    if default is None:
        return None
    if isinstance(default, list):
        return default
    return [default]


def _extract_input_type_and_embedded_question(
    input_type: str,
) -> tuple[str, str | None]:
    """Recover question text from malformed values like choice(question(...))."""
    match = EMBEDDED_QUESTION_PATTERN.search(input_type)
    if not match:
        return input_type, None

    embedded_question = input_type[match.end() :].strip()
    wrapper_closers = 2
    while wrapper_closers > 0 and embedded_question.endswith(")"):
        embedded_question = embedded_question[:-1].strip()
        wrapper_closers -= 1

    return match.group("input_type").strip(), embedded_question or None


def _normalize_option_payload(option: Any) -> Any:
    """Normalize common option shorthand into the strict option schema."""
    if isinstance(option, str):
        normalized = option.strip()
        return {"label": normalized, "value": normalized}

    if not isinstance(option, dict):
        return option

    normalized_option = dict(option)
    if "label" not in normalized_option:
        for key in ("name", "text", "title"):
            value = normalized_option.get(key)
            if isinstance(value, str) and value.strip():
                normalized_option["label"] = value
                break

    if "value" not in normalized_option:
        value = normalized_option.get("label")
        if isinstance(value, str) and value.strip():
            normalized_option["value"] = value

    return normalized_option


def _normalize_question_payload(raw_question: Any) -> Any:
    """Normalize tolerant model-provided fields before Pydantic validation."""
    if isinstance(raw_question, InteractiveFormQuestionItem):
        return raw_question
    if not isinstance(raw_question, dict):
        return raw_question

    normalized = dict(raw_question)

    if not normalized.get("question"):
        for key in QUESTION_TEXT_KEYS:
            value = normalized.get(key)
            if isinstance(value, str) and value.strip():
                normalized["question"] = value
                break

    if not normalized.get("input_type"):
        for key in INPUT_TYPE_KEYS:
            value = normalized.get(key)
            if isinstance(value, str) and value.strip():
                normalized["input_type"] = value
                break

    input_type = normalized.get("input_type")
    if isinstance(input_type, str):
        clean_input_type, embedded_question = _extract_input_type_and_embedded_question(
            input_type
        )
        normalized["input_type"] = clean_input_type
        if embedded_question and not normalized.get("question"):
            normalized["question"] = embedded_question

    if "multi_select" not in normalized:
        for key in MULTI_SELECT_KEYS:
            value = normalized.get(key)
            if value is not None:
                normalized["multi_select"] = value
                break

    options = normalized.get("options")
    if isinstance(options, list):
        normalized["options"] = [
            _normalize_option_payload(option) for option in options
        ]

    return normalized


def _parse_record(value: Any) -> Dict[str, Any] | None:
    """Parse a dict-like value from raw tool output shapes."""
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None

    return parsed if isinstance(parsed, dict) else None


def _build_form_render_payload(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Build the UI-only render payload consumed by the frontend renderer."""
    return RenderedInteractiveForm.model_validate(form_data).model_dump()


def build_render_payload_from_tool_input(
    *,
    task_id: int,
    subtask_id: int,
    tool_input: Dict[str, Any] | None,
) -> Dict[str, Any] | None:
    """Build a frontend render payload from raw tool call arguments."""
    if not isinstance(tool_input, dict):
        return None

    questions = tool_input.get("questions")
    if not isinstance(questions, list) or not questions:
        return None

    normalized_questions = []
    for raw_question in questions:
        parsed_question = (
            raw_question
            if isinstance(raw_question, InteractiveFormQuestionItem)
            else InteractiveFormQuestionItem.model_validate(
                _normalize_question_payload(raw_question)
            )
        )
        has_options = bool(parsed_question.options)
        input_type, multi_select = _normalize_input_type(
            parsed_question.input_type,
            has_options,
            parsed_question.multi_select,
        )
        normalized_questions.append(
            {
                "id": parsed_question.id,
                "question": parsed_question.question,
                "input_type": input_type if has_options else "text",
                "options": (
                    [option.model_dump() for option in parsed_question.options]
                    if parsed_question.options
                    else None
                ),
                "multi_select": multi_select if has_options else False,
                "required": parsed_question.required,
                "default": _normalize_default(parsed_question.default),
                "placeholder": parsed_question.placeholder,
            }
        )

    return _build_form_render_payload(
        {
            "type": "interactive_form_question",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "questions": normalized_questions,
        }
    )


def _build_deferred_tool_result() -> Dict[str, Any]:
    """Build the minimal model-visible tool result for deferred user input."""
    return {
        "__silent_exit__": True,
        "__deferred_user_input__": True,
        "reason": FORM_RENDERED_REASON,
        "success": True,
        "status": "waiting_for_user_response",
    }


def _is_interactive_form_tool_block(block: Dict[str, Any]) -> bool:
    """Return whether a block is an interactive_form_question tool block."""
    tool_name = block.get("tool_name", "")
    return block.get("type") == "tool" and "interactive_form_question" in tool_name


def _has_interactive_form_payload(block: Dict[str, Any]) -> bool:
    """Return whether a tool block already carries a normalized form payload."""
    if not _is_interactive_form_tool_block(block):
        return False

    render_payload = _parse_record(block.get("render_payload"))
    if not render_payload:
        return False

    try:
        RenderedInteractiveForm.model_validate(render_payload)
    except ValueError:
        return False
    return True


async def _has_existing_interactive_form(subtask_id: int) -> bool:
    """Check whether this subtask has already displayed an interactive form."""
    try:
        from app.services.chat.storage.session import session_manager

        blocks = await session_manager.get_blocks(subtask_id)
    except Exception as e:
        logger.warning(
            "[InteractiveForm] Failed to check existing forms for subtask %s: %s",
            subtask_id,
            e,
        )
        return False

    form_blocks = [block for block in blocks if _is_interactive_form_tool_block(block)]
    return any(_has_interactive_form_payload(block) for block in form_blocks)


async def _notify_frontend(
    task_id: int,
    subtask_id: int,
    question_data: Dict[str, Any],
) -> None:
    """Send WebSocket notification to frontend to render the interactive_form_question form card.

    Finds the interactive_form_question tool block in session_manager, updates its render_payload,
    and emits a chat:block_updated event so the frontend can render the form.

    Args:
        task_id: Task ID for WebSocket room targeting
        subtask_id: Subtask ID for block lookup
        question_data: The question data to send to frontend
    """
    render_payload = _build_form_render_payload(question_data)
    tool_result = _build_deferred_tool_result()

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
                f"[InteractiveForm] No interactive_form_question tool block found in session for subtask {subtask_id}. "
                "Skipping direct WebSocket form update; the execution event pipeline "
                "will attach the render payload to the real tool_use_id block."
            )
            return

        # Update tool block in session_manager with the UI-only render payload.
        await session_manager.update_tool_block_status(
            subtask_id=subtask_id,
            tool_use_id=tool_use_id,
            tool_output=tool_result,
            render_payload=render_payload,
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
            tool_output=tool_result,
            render_payload=render_payload,
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
        "IMPORTANT: Calling this tool only renders the form UI - it does NOT collect "
        "the answer. After calling this tool you MUST immediately end the current "
        "conversation turn and wait for the user to submit their answer as a new "
        "message. Do NOT continue processing or call any other tools after this one."
    ),
    server="interactive_form_question",
    param_descriptions={
        "questions": (
            "List of questions to render in the form. "
            "Use a single item for a single-question form. "
            "Each question is an object with fields: "
            "'id', 'question', 'input_type', 'options', 'multi_select', "
            "'required', 'default', and 'placeholder'. "
            "'input_type' accepts text aliases (text, textarea, long_text, short_text, "
            "string, input, free_text), single-choice aliases (choice, single_select, "
            "select, dropdown, radio, radio_group, enum, option), and multi-choice "
            "aliases (multi_select, multiple_select, multiselect, multi_choice, "
            "multiple_choice, checkbox, checkboxes, checkbox_group). "
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

    IMPORTANT: Calling this tool only renders the form UI to the user.
    After calling this tool, you MUST immediately end the current conversation
    turn - do NOT continue processing, do NOT call any other tools, and do NOT
    generate any further output. The current task ends silently. The user fills
    in the form at their own pace, and their answer arrives as a new
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

    if await _has_existing_interactive_form(token_info.subtask_id):
        logger.warning(
            "[InteractiveForm] Reject duplicate form: task_id=%s, subtask_id=%s",
            token_info.task_id,
            token_info.subtask_id,
        )
        raise RuntimeError(
            f"interactive_form_question already displayed for subtask {token_info.subtask_id}"
        )

    question_data = build_render_payload_from_tool_input(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        tool_input={"questions": questions},
    )
    if not question_data:
        raise ValueError("questions must contain at least one item")

    # Notify frontend directly via WebSocket to render the form card
    await _notify_frontend(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        question_data=question_data,
    )

    return _build_deferred_tool_result()
