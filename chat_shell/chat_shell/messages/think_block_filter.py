"""Filter and normalize provider-specific message content for cross-model history.

When users switch models mid-conversation (e.g. Claude → GPT → Gemini),
historical messages may contain think/reasoning blocks in formats that the
new model's API rejects.  This module provides a single public function,
:func:`strip_foreign_reasoning_blocks`, which removes or retains reasoning
blocks based on whether the message originated from the same provider as
the current request target.
"""

from __future__ import annotations

import copy
import re
from typing import Any

# Canonical block type used for all normalized reasoning content.
_REASONING_TYPE = "reasoning"

# Provider-specific block types found in legacy (pre-normalization) data.
_LEGACY_ANTHROPIC_TYPE = "thinking"


def _is_claude_model(model_id: str) -> bool:
    """Check if a model ID represents a real Anthropic Claude model.

    Non-Claude models (Minimax, GLM, Kimi) may use the Anthropic protocol
    but produce invalid signatures that the Claude API rejects.
    """
    return model_id.lower().startswith("claude")


def _infer_provider(msg: dict[str, Any]) -> str | None:
    """Heuristically infer the originating provider from a message dict.

    Used for legacy messages that lack a ``model_info`` field.

    Returns:
        Provider string (``"anthropic"``, ``"openai"``) or ``None`` if
        no think blocks are present and provider cannot be determined.
    """
    content = msg.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == _LEGACY_ANTHROPIC_TYPE:
                return "anthropic"
            if block_type == _REASONING_TYPE and "summary" in block:
                # OpenAI Responses API format (pre-normalization legacy)
                return "openai"
            if block_type == _REASONING_TYPE and isinstance(block.get("extras"), dict):
                extras = block["extras"]
                if extras.get("signature"):
                    # Canonical reasoning with Anthropic signature
                    return "anthropic"
                if extras.get("id") or extras.get("encrypted_content"):
                    # Canonical OpenAI Responses reasoning
                    return "openai"

    # DeepSeek/Kimi: reasoning_content in additional_kwargs
    additional_kwargs = msg.get("additional_kwargs")
    if isinstance(additional_kwargs, dict) and additional_kwargs.get(
        "reasoning_content"
    ):
        return "openai"

    return None


def _strip_reasoning_from_content(content: list) -> list:
    """Remove all reasoning blocks from a content block list.

    Returns:
        The filtered list, or a single empty text block if all were removed.
    """
    filtered = [
        block
        for block in content
        if not (
            isinstance(block, dict)
            and block.get("type") in (_REASONING_TYPE, _LEGACY_ANTHROPIC_TYPE)
        )
    ]
    if not filtered:
        return [{"type": "text", "text": ""}]
    return filtered


def _denormalize_for_anthropic(content: list) -> list:
    """Convert canonical reasoning blocks back to Anthropic native thinking format.

    Transforms ``{"type": "reasoning", "reasoning": "...", "extras": {"signature": "..."}}``
    back to ``{"type": "thinking", "thinking": "...", "signature": "..."}``.

    Reasoning blocks **without** a ``signature`` in ``extras`` are dropped
    because the Claude API requires ``signature`` on every thinking block.
    Such blocks originate from non-Claude providers (e.g. Kimi) that use
    the Anthropic protocol without producing signatures.

    Non-reasoning blocks are passed through unchanged.
    """
    result: list = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != _REASONING_TYPE:
            result.append(block)
            continue

        extras = block.get("extras")
        # Claude requires signature on every thinking block.  Drop blocks
        # from providers that don't produce one (e.g. Kimi).
        if not isinstance(extras, dict) or not extras.get("signature"):
            continue

        thinking_block: dict[str, Any] = {
            "type": "thinking",
            "thinking": block.get("reasoning", ""),
        }
        for k, v in extras.items():
            thinking_block[k] = v
        result.append(thinking_block)
    return result


def _denormalize_for_openai_responses(content: list) -> list:
    """Convert canonical reasoning blocks back to OpenAI Responses API format.

    Transforms exploded canonical blocks::

        {"type": "reasoning", "reasoning": "text",
         "extras": {"id": "rs_...", "encrypted_content": "gAAAA...", ...}}

    back to the original Responses API structure::

        {"type": "reasoning", "id": "rs_...",
         "summary": [{"type": "summary_text", "text": "text"}],
         "encrypted_content": "gAAAA..."}

    Blocks without ``extras.id`` or ``extras.encrypted_content`` (i.e. not
    originating from the Responses API) are passed through unchanged.

    When reasoning blocks lack ``extras`` (legacy corrupted data) but
    sibling text blocks carry an ``id`` (e.g. ``msg_...``), the text
    block ``id`` is stripped to prevent the API from expecting a
    reasoning item that no longer exists.
    """
    result: list = []
    has_reasoning_id = False

    for block in content:
        if not isinstance(block, dict) or block.get("type") != _REASONING_TYPE:
            result.append(block)
            continue

        extras = block.get("extras")
        if not isinstance(extras, dict) or (
            "id" not in extras and "encrypted_content" not in extras
        ):
            # Check for raw (pre-normalization) Responses API format where
            # ``id``, ``summary``, ``encrypted_content`` live at the top
            # level instead of inside ``extras``.  These blocks are already
            # in valid Responses API format and can be passed through, but
            # we must set ``has_reasoning_id`` so that sibling text-block
            # ids are preserved (the API needs them to pair the reasoning
            # item with its output message).
            if "summary" in block and ("id" in block or "encrypted_content" in block):
                has_reasoning_id = True
                result.append(block)
                continue

            # Not an exploded Responses API reasoning block — pass through
            result.append(block)
            continue

        has_reasoning_id = True

        # Reconstruct the original Responses API format
        rebuilt: dict[str, Any] = {"type": _REASONING_TYPE}
        if "id" in extras:
            rebuilt["id"] = extras["id"]

        reasoning_text = block.get("reasoning", "")
        rebuilt["summary"] = [{"type": "summary_text", "text": reasoning_text}]

        if "encrypted_content" in extras:
            rebuilt["encrypted_content"] = extras["encrypted_content"]

        result.append(rebuilt)

    # If no reasoning block had an id (corrupted/legacy data), strip ``id``
    # from text blocks to prevent orphaned message references that the
    # Responses API would reject.
    if not has_reasoning_id:
        result = [
            (
                {k: v for k, v in block.items() if k != "id"}
                if isinstance(block, dict)
                and block.get("type") in ("text", "output_text")
                and "id" in block
                else block
            )
            for block in result
        ]

    return result


# Claude API requires tool_call IDs to match ^[a-zA-Z0-9_-]+$.
# Other providers (e.g. Kimi) may produce IDs with dots, colons, etc.
_ANTHROPIC_TOOL_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_INVALID_TOOL_ID_CHAR_RE = re.compile(r"[^a-zA-Z0-9_-]")


def _sanitize_tool_ids_for_anthropic(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Replace tool call IDs that violate Anthropic's pattern constraint.

    Claude requires ``^[a-zA-Z0-9_-]+$`` for tool_use and tool_result IDs.
    IDs from other providers (e.g. Kimi's ``functions.load_skill:10``) are
    sanitized by replacing invalid characters with ``_``.

    A mapping is maintained so that the same original ID always produces the
    same replacement, preserving the tool_call ↔ tool_result linkage.
    """
    # First pass: collect all IDs that need sanitization
    id_map: dict[str, str] = {}

    def _sanitize(original: str) -> str:
        if not original or _ANTHROPIC_TOOL_ID_RE.match(original):
            return original
        if original not in id_map:
            id_map[original] = _INVALID_TOOL_ID_CHAR_RE.sub("_", original)
        return id_map[original]

    result: list[dict[str, Any]] = []
    for msg in messages:
        needs_copy = False

        # Check tool_calls on assistant messages
        tool_calls = msg.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                tcid = tc.get("id", "")
                if tcid and not _ANTHROPIC_TOOL_ID_RE.match(tcid):
                    needs_copy = True
                    break

        # Check tool_call_id on tool messages
        tcid = msg.get("tool_call_id", "")
        if tcid and not _ANTHROPIC_TOOL_ID_RE.match(tcid):
            needs_copy = True

        # Check function_call content blocks
        content = msg.get("content")
        if not needs_copy and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "function_call":
                    cid = block.get("call_id", "")
                    if cid and not _ANTHROPIC_TOOL_ID_RE.match(cid):
                        needs_copy = True
                        break

        if not needs_copy:
            result.append(msg)
            continue

        sanitized = copy.deepcopy(msg)

        if isinstance(sanitized.get("tool_calls"), list):
            for tc in sanitized["tool_calls"]:
                if "id" in tc:
                    tc["id"] = _sanitize(tc["id"])
                fn = tc.get("function", {})
                if isinstance(fn, dict) and "id" in fn:
                    fn["id"] = _sanitize(fn["id"])

        if sanitized.get("tool_call_id"):
            sanitized["tool_call_id"] = _sanitize(sanitized["tool_call_id"])

        if isinstance(sanitized.get("content"), list):
            for block in sanitized["content"]:
                if isinstance(block, dict) and block.get("type") == "function_call":
                    if "call_id" in block:
                        block["call_id"] = _sanitize(block["call_id"])

        result.append(sanitized)

    return result


def strip_foreign_reasoning_blocks(
    messages: list[dict[str, Any]],
    target_provider: str,
    target_model_id: str = "",
    target_api_format: str = "",
) -> list[dict[str, Any]]:
    """Remove reasoning blocks from messages produced by a different provider.

    For **same-provider** messages, reasoning blocks (including ``extras``
    like ``signature``) are preserved to maintain multi-turn reasoning
    continuity.

    For **cross-provider** messages, reasoning blocks are stripped because:

    1. Each provider's API rejects foreign think block types.
    2. Provider-specific data (``signature``, ``encrypted_content``) is
       meaningless cross-provider.
    3. DeepSeek/Kimi explicitly forbid sending ``reasoning_content`` back.

    For legacy messages without ``model_info``, the provider is inferred
    heuristically from the content block types.

    Args:
        messages: Conversation history as a list of message dicts.
        target_provider: The provider of the current request
            (e.g. ``"anthropic"``, ``"openai"``, ``"google"``).
        target_model_id: The model ID of the current request
            (e.g. ``"claude-sonnet-4-6"``, ``"moonshot-kimi-k2.5"``).
            Used for model-specific post-processing.
        target_api_format: The API format of the target model
            (e.g. ``"responses"`` for OpenAI Responses API).
            When empty, Chat Completions format is assumed for OpenAI.

    Returns:
        A new list of message dicts with foreign reasoning blocks removed.
        Original dicts are not mutated.
    """
    target_uses_responses = target_api_format == "responses"

    result: list[dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") != "assistant":
            result.append(msg)
            continue

        # Determine source provider
        model_info = msg.get("model_info")
        if isinstance(model_info, dict):
            source_provider = model_info.get("provider", "")
        else:
            source_provider = _infer_provider(msg) or ""

        content = msg.get("content")

        # Same provider: keep everything (denormalize to native format)
        if source_provider == target_provider:
            if target_provider == "anthropic" and isinstance(content, list):
                source_model = (
                    model_info.get("model", "") if isinstance(model_info, dict) else ""
                )
                # Non-Claude models using the Anthropic protocol (Minimax,
                # Kimi, GLM) may produce fake signatures that the Claude API
                # rejects.  When we know the source model, only denormalize
                # if it is actually Claude.  Legacy messages without
                # model_info are assumed to be real Claude (backward compat).
                has_model_info = isinstance(model_info, dict)
                is_real_claude = not has_model_info or _is_claude_model(source_model)
                if is_real_claude:
                    denormalized = copy.deepcopy(msg)
                    denormalized["content"] = _denormalize_for_anthropic(content)
                    denormalized["response_metadata"] = {"model_provider": "anthropic"}
                    result.append(denormalized)
                else:
                    # Non-Claude model — strip reasoning blocks
                    stripped = copy.deepcopy(msg)
                    stripped["content"] = _strip_reasoning_from_content(content)
                    result.append(stripped)
            elif (
                target_provider == "openai"
                and target_uses_responses
                and isinstance(content, list)
            ):
                # Only denormalize to Responses API format when the target
                # actually uses the Responses API.  Chat Completions reasoning
                # models (DeepSeek/Kimi) handle canonical blocks via
                # ChatOpenAIWithReasoning, so they need no denormalization.
                denormalized = copy.deepcopy(msg)
                denormalized["content"] = _denormalize_for_openai_responses(content)
                result.append(denormalized)
            else:
                result.append(msg)
            continue

        # Different provider (or unknown): strip reasoning blocks
        needs_strip = False

        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") in (
                    _REASONING_TYPE,
                    _LEGACY_ANTHROPIC_TYPE,
                ):
                    needs_strip = True
                    break

        # Also check legacy additional_kwargs.reasoning_content
        additional_kwargs = msg.get("additional_kwargs")
        has_legacy_reasoning = isinstance(additional_kwargs, dict) and bool(
            additional_kwargs.get("reasoning_content")
        )

        if not needs_strip and not has_legacy_reasoning:
            result.append(msg)
            continue

        # Create a deep copy and strip reasoning
        stripped = copy.deepcopy(msg)

        if isinstance(content, list) and needs_strip:
            stripped["content"] = _strip_reasoning_from_content(content)

        if has_legacy_reasoning:
            new_kwargs = dict(additional_kwargs)  # type: ignore[arg-type]
            del new_kwargs["reasoning_content"]
            if new_kwargs:
                stripped["additional_kwargs"] = new_kwargs
            else:
                stripped.pop("additional_kwargs", None)

        result.append(stripped)

    # Kimi rejects empty text content blocks (e.g. left over after stripping
    # reasoning-only messages).  Filter them out when targeting Kimi models.
    if "kimi" in target_model_id.lower():
        result = _filter_empty_text_blocks(result)

    # Claude requires tool_call IDs to match ^[a-zA-Z0-9_-]+$.
    # Sanitize IDs from other providers (e.g. Kimi's "functions.load_skill:10").
    if target_provider == "anthropic":
        result = _sanitize_tool_ids_for_anthropic(result)

    # Ensure every assistant message ending with a reasoning block has a
    # following output item.  The Responses API rejects orphaned reasoning
    # items, so we append a placeholder text block as a safety net.
    if target_uses_responses:
        result = _ensure_reasoning_has_output(result)

    return result


def _ensure_reasoning_has_output(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Ensure assistant messages don't end with an orphaned reasoning block.

    The OpenAI Responses API requires that every ``reasoning`` item is
    followed by its output (a ``message`` or ``function_call`` item).
    When the last content block of an assistant message is ``reasoning``
    (and the message has no ``tool_calls``), the API will reject it.

    This function appends a placeholder ``text`` block so that the
    reasoning block always has a valid following item.
    """
    result: list[dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") != "assistant":
            result.append(msg)
            continue

        content = msg.get("content")
        if not isinstance(content, list) or not content:
            result.append(msg)
            continue

        last_block = content[-1]
        has_tool_calls = bool(msg.get("tool_calls"))
        is_orphaned_reasoning = (
            isinstance(last_block, dict)
            and last_block.get("type") in (_REASONING_TYPE, _LEGACY_ANTHROPIC_TYPE)
            and not has_tool_calls
        )

        if is_orphaned_reasoning:
            patched = {**msg, "content": list(content) + [{"type": "text", "text": ""}]}
            result.append(patched)
        else:
            result.append(msg)

    return result


def _filter_empty_text_blocks(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove empty text blocks from assistant message content lists.

    Some models (e.g. Kimi) reject requests containing empty text blocks.
    These blocks typically appear after reasoning-only content is stripped.
    """
    filtered: list[dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") != "assistant":
            filtered.append(msg)
            continue

        content = msg.get("content")
        if not isinstance(content, list):
            filtered.append(msg)
            continue

        non_empty = [
            block
            for block in content
            if not (
                isinstance(block, dict)
                and block.get("type") == "text"
                and not block.get("text")
            )
        ]
        if non_empty != content:
            msg = {**msg, "content": non_empty}
        filtered.append(msg)
    return filtered
