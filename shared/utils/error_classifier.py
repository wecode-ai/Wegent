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
    SERVER_OVERLOADED = "server_overloaded"
    AUTHENTICATION_EXPIRED = "authentication_expired"
    SKILLS_UNMANAGED_ENTRIES = "skills_unmanaged_entries"
    SKILL_DEPLOY_FAILED = "skill_deploy_failed"
    EXECUTOR_START_FAILED = "executor_start_failed"
    WORKSPACE_UNAVAILABLE = "workspace_unavailable"
    TOOL_EXECUTION_FAILED = "tool_execution_failed"
    CONNECTOR_UNAVAILABLE = "connector_unavailable"
    PLUGIN_LOAD_FAILED = "plugin_load_failed"
    STREAM_PROTOCOL_ERROR = "stream_protocol_error"
    INTERNAL_ERROR = "internal_error"
    STORAGE_ERROR = "storage_error"
    DISPATCH_ERROR = "dispatch_error"
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
            "token limit exceeded",
            "tokens exceeds the model",
            "input is too long",
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
    # Skills protection is an actionable preparation failure, not an LLM error.
    (
        ChatErrorCode.SKILLS_UNMANAGED_ENTRIES,
        ["agent skills directory contains unmanaged entries"],
    ),
    (
        ChatErrorCode.SKILL_DEPLOY_FAILED,
        [
            "refusing to replace unmanaged agent skill",
            "required skills are missing from the deployment plan",
            "required skills cannot be deployed",
            "required skill deployment failed",
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
    # Quota exceeded (check before rate_limit and permission — more specific)
    (
        ChatErrorCode.QUOTA_EXCEEDED,
        [
            "商业付费模型额度已用完",
            "quota exceeded",
            "insufficient_quota",
            "billing limit",
            "billing quota",
            "billing_hard_limit_reached",
            "credit balance",
            "payment required",
            "account balance",
            "insufficient funds",
            "exceeded your current quota",
        ],
    ),
    (
        ChatErrorCode.AUTHENTICATION_EXPIRED,
        ["authentication expired", "credentials expired", "token expired"],
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
            "无权限调用此模型",
            "禁止使用外部模型",
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
            "403 forbidden",
            "403 client error",
            "not logged in",
        ],
    ),
    (
        ChatErrorCode.SERVER_OVERLOADED,
        ["server overloaded", "server_overloaded", "overloaded"],
    ),
    # Transport causes precede wrappers such as executor or upstream error.
    (
        ChatErrorCode.TIMEOUT_ERROR,
        ["timeout", "timed out", "504 gateway", "超时"],
    ),
    (
        ChatErrorCode.CONNECTOR_UNAVAILABLE,
        ["connector unavailable", "connector not connected"],
    ),
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
    # Provider error (model provider service wrapping)
    (
        ChatErrorCode.PROVIDER_ERROR,
        [
            "error from provider",
            "upstream error",
            "502 bad gateway",
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
            "413 request entity too large",
            "payload too large",
            "request too large",
        ],
    ),
    (
        ChatErrorCode.EXECUTOR_START_FAILED,
        ["executor failed to start", "failed to start executor"],
    ),
    (
        ChatErrorCode.WORKSPACE_UNAVAILABLE,
        ["workspace unavailable", "workspace not found"],
    ),
    (
        ChatErrorCode.PLUGIN_LOAD_FAILED,
        ["failed to load plugin", "plugin load failed"],
    ),
    (
        ChatErrorCode.STREAM_PROTOCOL_ERROR,
        ["invalid sse event", "malformed sse event", "stream protocol error"],
    ),
    (
        ChatErrorCode.TOOL_EXECUTION_FAILED,
        ["tool execution failed"],
    ),
    # Broad runtime wrappers are checked last to retain an informative cause.
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
    "OverloadedError": ChatErrorCode.SERVER_OVERLOADED,
    "APITimeoutError": ChatErrorCode.TIMEOUT_ERROR,
    "TimeoutError": ChatErrorCode.TIMEOUT_ERROR,
    "TimeoutException": ChatErrorCode.TIMEOUT_ERROR,
    "APIConnectionError": ChatErrorCode.NETWORK_ERROR,
    # BadRequestError: refined further by message content in _classify_by_exception_type
    "BadRequestError": ChatErrorCode.GENERIC_ERROR,
    # Google SDK
    "ResourceExhausted": ChatErrorCode.RATE_LIMIT,
    "PermissionDenied": ChatErrorCode.FORBIDDEN,
    "NotFound": ChatErrorCode.MODEL_UNAVAILABLE,
}

_PROVIDER_CODE_ALIASES: dict[str, ChatErrorCode] = {
    "EXECUTOR_DISPATCH_FAILED": ChatErrorCode.DISPATCH_ERROR,
    "task_queue_failure": ChatErrorCode.DISPATCH_ERROR,
    "task_queue_stalled": ChatErrorCode.DISPATCH_ERROR,
    "insufficient_quota": ChatErrorCode.QUOTA_EXCEEDED,
    "billing_hard_limit_reached": ChatErrorCode.QUOTA_EXCEEDED,
    "rate_limit_exceeded": ChatErrorCode.RATE_LIMIT,
    "server_overloaded_retryable": ChatErrorCode.SERVER_OVERLOADED,
    "authentication_error": ChatErrorCode.FORBIDDEN,
}


def _classify_by_provider_code(error: Exception) -> ChatErrorCode | None:
    """Prefer explicit provider business reasons over broad SDK exceptions."""
    candidates = [getattr(error, "code", None)]
    body = getattr(error, "body", None)
    if isinstance(body, dict):
        nested = body.get("error")
        if isinstance(nested, dict):
            candidates.extend((nested.get("code"), nested.get("type")))
        candidates.extend((body.get("code"), body.get("type")))
    has_legacy_llm_code = False
    for raw in candidates:
        if not isinstance(raw, str):
            continue
        if raw == "llm_error":
            has_legacy_llm_code = True
            continue
        code = _PROVIDER_CODE_ALIASES.get(raw)
        if code is None:
            try:
                code = ChatErrorCode(raw)
            except ValueError:
                continue
        if code != ChatErrorCode.GENERIC_ERROR:
            return code
    if has_legacy_llm_code:
        message_code = _classify_by_message(str(error))
        if message_code != ChatErrorCode.GENERIC_ERROR:
            return message_code
        return ChatErrorCode.MODEL_UNAVAILABLE
    return None


def _classify_by_http_status(status: Optional[int]) -> ChatErrorCode | None:
    """Classify only statuses whose request-failure meaning is unambiguous."""
    return {
        401: ChatErrorCode.FORBIDDEN,
        403: ChatErrorCode.FORBIDDEN,
        408: ChatErrorCode.TIMEOUT_ERROR,
        413: ChatErrorCode.PAYLOAD_TOO_LARGE,
        429: ChatErrorCode.RATE_LIMIT,
        500: ChatErrorCode.PROVIDER_ERROR,
        502: ChatErrorCode.PROVIDER_ERROR,
        503: ChatErrorCode.PROVIDER_ERROR,
        504: ChatErrorCode.TIMEOUT_ERROR,
    }.get(status)


def _classify_by_exception_type(error: Exception) -> ChatErrorCode | None:
    """Classify error by exception class hierarchy."""
    for exception_class in type(error).__mro__:
        code = _EXCEPTION_CLASS_MAP.get(exception_class.__name__)
        if code is None:
            continue
        message_code = _classify_by_message(str(error))
        if code == ChatErrorCode.GENERIC_ERROR:
            return message_code
        if (
            code == ChatErrorCode.RATE_LIMIT
            and message_code == ChatErrorCode.QUOTA_EXCEEDED
        ):
            return message_code
        if (
            code == ChatErrorCode.FORBIDDEN
            and message_code == ChatErrorCode.AUTHENTICATION_EXPIRED
        ):
            return message_code
        return code
    return None


def _classify_by_message(message: str) -> ChatErrorCode:
    """Classify error by keyword matching on the message string."""
    lower = message.lower()
    for code, patterns in _CLASSIFICATION_RULES[:-1]:
        for pattern in patterns:
            if pattern in lower:
                return code
    status_code = _classify_by_http_status(extract_http_status_code(message))
    if status_code is not None:
        return status_code
    code, patterns = _CLASSIFICATION_RULES[-1]
    if any(pattern in lower for pattern in patterns):
        return code
    return ChatErrorCode.GENERIC_ERROR


@trace_sync("classify_error", "shared")
def classify_error(error: Union[Exception, str]) -> str:
    """Classify an error into a structured error code.

    Prefers explicit provider reasons, then SDK exception types and HTTP
    metadata. Message classification retains specific causes before wrappers.

    Args:
        error: Exception instance or error message string.

    Returns:
        Error code string (ChatErrorCode value).
    """
    if isinstance(error, Exception):
        code = _classify_by_provider_code(error)
        if code is not None:
            return code.value
        # Try exception class-based classification first
        code = _classify_by_exception_type(error)
        if code is not None:
            return code.value
        message_code = _classify_by_message(str(error))
        if message_code in {ChatErrorCode.GENERIC_ERROR, ChatErrorCode.CONTAINER_ERROR}:
            code = _classify_by_http_status(extract_http_status_code(error))
            if code is not None:
                return code.value
        return message_code.value

    # String input — keyword matching only
    return _classify_by_message(error).value


_HTTP_STATUS_PATTERN = re.compile(r"Error code:\s*(\d{3})(?!\d)", re.IGNORECASE)


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
