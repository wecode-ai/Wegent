# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Error classification utility for chat errors.

Classifies raw LLM SDK exceptions and error strings into structured
error codes that the frontend can use to display user-friendly messages
and actionable solutions.
"""

import json
import re
from enum import Enum
from typing import Optional, Union

from shared.telemetry.decorators import trace_sync


class ChatErrorCode(str, Enum):
    """Structured error codes for chat errors."""

    CONTEXT_LENGTH_EXCEEDED = "context_length_exceeded"
    QUOTA_EXCEEDED = "quota_exceeded"
    RATE_LIMIT = "rate_limit"
    MODEL_UNAVAILABLE = "model_unavailable"
    CONTAINER_OOM = "container_oom"
    CONTAINER_ERROR = "container_error"
    NETWORK_ERROR = "network_error"
    TIMEOUT_ERROR = "timeout_error"
    LLM_UNSUPPORTED = "llm_unsupported"
    FORBIDDEN = "forbidden"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    INVALID_PARAMETER = "invalid_parameter"
    CONTENT_FILTER = "content_filter"
    PROVIDER_ERROR = "provider_error"
    IMAGE_TOO_LARGE = "image_too_large"
    MODEL_PROTOCOL_ERROR = "model_protocol_error"
    INVALID_ROLE = "invalid_role"
    PERMISSION_DENIED = "permission_denied"
    GENERIC_ERROR = "generic_error"


# Keyword patterns for string-based classification.
# Order matters: more specific patterns are checked first.
_CLASSIFICATION_RULES: list[tuple[ChatErrorCode, list[str]]] = [
    # Context length exceeded
    (
        ChatErrorCode.CONTEXT_LENGTH_EXCEEDED,
        [
            "prompt is too long",
            "context_length_exceeded",
            "context length exceeded",
            "maximum context length",
            "max_tokens",
            "token limit exceeded",
            "tokens exceeds the model",
            "input is too long",
            "request too large",
            "maximum number of tokens",
        ],
    ),
    # Content filter / safety moderation (check before generic 400)
    (
        ChatErrorCode.CONTENT_FILTER,
        [
            "data_inspection_failed",
            "inappropriate content",
            "content filter",
            "content management",
            "content_policy",
            "contentfilter",
            "risky content",
            "content_filtering_policy",
            "responsibleaipolicy",
            "resp_safety_modify_answer",
        ],
    ),
    # Image too large (check before generic payload errors)
    (
        ChatErrorCode.IMAGE_TOO_LARGE,
        [
            "image exceeds",
            "image too large",
            "image size exceeds",
        ],
    ),
    # Invalid role in messages (model protocol mismatch)
    (
        ChatErrorCode.INVALID_ROLE,
        [
            "invalid role",
        ],
    ),
    # Model protocol error (model ID not supported by provider)
    (
        ChatErrorCode.MODEL_PROTOCOL_ERROR,
        [
            "invalid model id",
            "only claude",
            "only thudm",
            "only moonshot",
        ],
    ),
    # Container OOM
    (
        ChatErrorCode.CONTAINER_OOM,
        [
            "out of memory",
            "oom killed",
            "memory allocation",
        ],
    ),
    # Container errors (includes Claude Code shell disconnections)
    (
        ChatErrorCode.CONTAINER_ERROR,
        [
            "container",
            "executor",
            "docker",
            "disappeared unexpectedly",
            "no ports mapped",
            "crashed unexpectedly",
            "exit code",
            "device disconnected",
            "not logged in",
        ],
    ),
    # Quota exceeded (check before rate_limit and permission — more specific)
    (
        ChatErrorCode.QUOTA_EXCEEDED,
        [
            "quota exceeded",
            "insufficient_quota",
            "billing",
            "credit balance",
            "payment required",
            "account balance",
            "insufficient funds",
            "exceeded your current quota",
        ],
    ),
    # Rate limit (temporary throttling)
    (
        ChatErrorCode.RATE_LIMIT,
        [
            "rate limit",
            "rate_limit",
            "too many requests",
            "throttl",
        ],
    ),
    # Permission denied (model access restrictions)
    (
        ChatErrorCode.PERMISSION_DENIED,
        [
            "permission_denied",
            "permission denied",
            "permission_error",
        ],
    ),
    # Forbidden / auth errors
    (
        ChatErrorCode.FORBIDDEN,
        [
            "forbidden",
            "not allowed",
            "unauthorized",
            "403",
        ],
    ),
    # Provider error (model provider service wrapping)
    (
        ChatErrorCode.PROVIDER_ERROR,
        [
            "error from provider",
            "upstream error",
        ],
    ),
    # Model unsupported (multi-modal, incompatible request)
    (
        ChatErrorCode.LLM_UNSUPPORTED,
        [
            "multi-modal",
            "multimodal",
            "do not support",
            "does not support",
            "not support image",
        ],
    ),
    # Model unavailable
    (
        ChatErrorCode.MODEL_UNAVAILABLE,
        [
            "model not found",
            "model unavailable",
            "model_not_found",
            "model error",
            "overloaded",
            "llm request failed",
            "llm api error",
            "llm call failed",
            "llm service error",
        ],
    ),
    # Invalid parameter
    (
        ChatErrorCode.INVALID_PARAMETER,
        [
            "invalid parameter",
            "invalid_parameter",
        ],
    ),
    # Payload too large
    (
        ChatErrorCode.PAYLOAD_TOO_LARGE,
        [
            "413",
            "payload too large",
        ],
    ),
    # Timeout errors (includes gateway timeouts)
    (
        ChatErrorCode.TIMEOUT_ERROR,
        [
            "timeout",
            "timed out",
            "504 gateway",
            "502 bad gateway",
            "超时",
        ],
    ),
    # Network errors (includes upstream connection issues)
    (
        ChatErrorCode.NETWORK_ERROR,
        [
            "network",
            "connection refused",
            "connection reset",
            "connection error",
            "not connected",
            "peer closed connection",
            "upstream connection interrupted",
        ],
    ),
]

# Map known SDK exception class names to error codes.
# Uses class name strings to avoid hard dependencies on SDK packages.
# OpenAI, Anthropic, and Google SDKs share some class names (e.g. RateLimitError,
# AuthenticationError); since they all map to the same codes, a single entry suffices.
_EXCEPTION_CLASS_MAP: dict[str, ChatErrorCode] = {
    # Shared across OpenAI / Anthropic SDKs
    "RateLimitError": ChatErrorCode.RATE_LIMIT,
    "AuthenticationError": ChatErrorCode.FORBIDDEN,
    "PermissionDeniedError": ChatErrorCode.FORBIDDEN,
    "NotFoundError": ChatErrorCode.MODEL_UNAVAILABLE,
    "InternalServerError": ChatErrorCode.MODEL_UNAVAILABLE,
    "OverloadedError": ChatErrorCode.MODEL_UNAVAILABLE,
    # BadRequestError: refined further by message content in _classify_by_exception_type
    "BadRequestError": ChatErrorCode.GENERIC_ERROR,
    # Google SDK
    "ResourceExhausted": ChatErrorCode.RATE_LIMIT,
    "PermissionDenied": ChatErrorCode.FORBIDDEN,
    "NotFound": ChatErrorCode.MODEL_UNAVAILABLE,
}


def _classify_by_exception_type(error: Exception) -> ChatErrorCode | None:
    """Classify error by exception class hierarchy."""
    class_name = type(error).__name__
    code = _EXCEPTION_CLASS_MAP.get(class_name)
    if code is not None:
        # For BadRequestError, refine based on message content
        if class_name == "BadRequestError":
            return _classify_by_message(str(error))
        return code
    return None


def _classify_by_message(message: str) -> ChatErrorCode:
    """Classify error by keyword matching on the message string."""
    lower = message.lower()
    for code, patterns in _CLASSIFICATION_RULES:
        for pattern in patterns:
            if pattern in lower:
                return code
    return ChatErrorCode.GENERIC_ERROR


@trace_sync("classify_error", "shared")
def classify_error(error: Union[Exception, str]) -> str:
    """Classify an error into a structured error code.

    Checks exception class hierarchy first (for typed SDK exceptions),
    then falls back to keyword-based string matching.

    Args:
        error: Exception instance or error message string.

    Returns:
        Error code string (ChatErrorCode value).
    """
    if isinstance(error, Exception):
        # Try exception class-based classification first
        code = _classify_by_exception_type(error)
        if code is not None:
            return code.value
        # Fall back to message-based classification
        return _classify_by_message(str(error)).value

    # String input — keyword matching only
    return _classify_by_message(error).value


_HTTP_STATUS_PATTERN = re.compile(r"Error code:\s*(\d{3})")


@trace_sync("extract_http_status_code", "shared")
def extract_http_status_code(error: Union[Exception, str]) -> Optional[int]:
    """Extract HTTP status code from an error.

    Checks the exception's ``status_code`` attribute first (SDK exceptions),
    then falls back to parsing "Error code: NNN" from the message string.

    Args:
        error: Exception instance or error message string.

    Returns:
        HTTP status code as int, or None if not available.
    """
    if isinstance(error, Exception):
        status = getattr(error, "status_code", None)
        if isinstance(status, int):
            return status
        error = str(error)

    match = _HTTP_STATUS_PATTERN.search(error)
    return int(match.group(1)) if match else None


@trace_sync("format_error_message", "shared")
def format_error_message(error: Exception) -> str:
    """Format an exception into an error message string.

    LLM SDK exceptions (Anthropic, OpenAI) store the HTTP response body
    as a parsed Python dict in ``error.body``.  Their ``__str__`` embeds
    that dict with ``f"Error code: {status} - {body}"``, producing Python
    repr (single quotes) instead of valid JSON.

    This function reconstructs the message with ``json.dumps`` so the
    stored error retains the original JSON form.

    For non-SDK exceptions or exceptions without a ``body`` attribute,
    falls back to ``str(error)``.
    """
    body = getattr(error, "body", None)
    if isinstance(body, (dict, list)):
        status_code = getattr(error, "status_code", None)
        if status_code is not None:
            return f"Error code: {status_code} - {json.dumps(body, ensure_ascii=False)}"
    return str(error)
