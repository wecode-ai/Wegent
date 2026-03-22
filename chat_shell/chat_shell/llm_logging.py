# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for LLM request/response logging."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

REDACTED_PLACEHOLDER = "<REDACTED>"
SENSITIVE_KEYS = {
    "attachment",
    "attachments",
    "blob",
    "body",
    "bytes",
    "chunks",
    "extracted_text",
    "file_data",
    "image_base64",
    "injected_content",
    "results",
    "source_material",
}


def env_bool(name: str, default: bool = False) -> bool:
    """Read a boolean value from environment variables."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def truncate_str(text: str, max_len: int) -> str:
    """Truncate a string for safe logging."""
    if max_len <= 0:
        return ""
    if len(text) <= max_len:
        return text
    return text[:max_len] + f"...<truncated:{len(text) - max_len}>"


def to_jsonable(obj: Any, *, max_str_len: int = 200000) -> Any:
    """Convert LangChain/LangGraph payloads into JSON-serializable data."""
    try:
        if obj is None or isinstance(obj, (bool, int, float)):
            return obj
        if isinstance(obj, str):
            return truncate_str(obj, max_str_len)

        if isinstance(obj, (bytes, bytearray, memoryview)):
            b = bytes(obj)
            prefix = b[:64]
            return {
                "__type__": type(obj).__name__,
                "len": len(b),
                "prefix_base64": __import__("base64").b64encode(prefix).decode("ascii"),
            }

        if isinstance(obj, dict):
            return {
                str(k): to_jsonable(v, max_str_len=max_str_len) for k, v in obj.items()
            }
        if isinstance(obj, (list, tuple)):
            return [to_jsonable(v, max_str_len=max_str_len) for v in obj]

        try:
            from langchain_core.messages import BaseMessage  # type: ignore
        except Exception:
            BaseMessage = None  # type: ignore

        if BaseMessage is not None and isinstance(obj, BaseMessage):
            data: dict[str, Any] = {
                "type": getattr(obj, "type", type(obj).__name__),
                "content": to_jsonable(
                    getattr(obj, "content", None), max_str_len=max_str_len
                ),
            }
            additional = getattr(obj, "additional_kwargs", None)
            if additional:
                data["additional_kwargs"] = to_jsonable(
                    additional, max_str_len=max_str_len
                )
            response_meta = getattr(obj, "response_metadata", None)
            if response_meta:
                data["response_metadata"] = to_jsonable(
                    response_meta, max_str_len=max_str_len
                )
            name = getattr(obj, "name", None)
            if name:
                data["name"] = name
            msg_id = getattr(obj, "id", None)
            if msg_id:
                data["id"] = msg_id
            tool_calls = getattr(obj, "tool_calls", None)
            if tool_calls:
                data["tool_calls"] = to_jsonable(tool_calls, max_str_len=max_str_len)
            return data

        if hasattr(obj, "model_dump") and callable(getattr(obj, "model_dump")):
            return to_jsonable(obj.model_dump(), max_str_len=max_str_len)

        return {
            "__type__": type(obj).__name__,
            "repr": truncate_str(repr(obj), 20000),
        }
    except Exception as e:
        return {
            "__error__": "serialization_failed",
            "exception": type(e).__name__,
            "message": truncate_str(str(e), 2000),
            "obj_type": type(obj).__name__,
        }


def looks_like_data_url(text: str) -> bool:
    """Detect inline data URLs that should never be logged verbatim."""
    stripped = text.strip().lower()
    return stripped.startswith("data:") and ";base64," in stripped


def looks_like_base64_blob(text: str) -> bool:
    """Detect large base64-like strings."""
    stripped = "".join(text.split())
    if len(stripped) < 512:
        return False
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
    return all(ch in allowed for ch in stripped)


def maybe_redact_embedded_json(text: str) -> str | None:
    """Redact sensitive fields inside JSON strings when possible."""
    candidate = text.strip()
    if not candidate or candidate[0] not in "[{":
        return None

    try:
        parsed = json.loads(text)
    except Exception:
        return None

    sanitized = redact_sensitive_fields(parsed)
    return json.dumps(sanitized, ensure_ascii=False)


def redact_sensitive_fields(value: Any, *, parent_key: str | None = None) -> Any:
    """Redact known sensitive payload fields while preserving log structure."""
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            key_str = str(key)
            key_lower = key_str.lower()
            if key_lower in SENSITIVE_KEYS:
                sanitized[key_str] = REDACTED_PLACEHOLDER
                continue
            sanitized[key_str] = redact_sensitive_fields(item, parent_key=key_lower)
        return sanitized

    if isinstance(value, list):
        return [redact_sensitive_fields(item, parent_key=parent_key) for item in value]

    if isinstance(value, str):
        if looks_like_data_url(value) or looks_like_base64_blob(value):
            return REDACTED_PLACEHOLDER
        if (
            parent_key == "content"
            and "Protected KB source material for internal reasoning only" in value
        ):
            return REDACTED_PLACEHOLDER
        redacted_json = maybe_redact_embedded_json(value)
        if redacted_json is not None:
            return redacted_json
        return value

    return value


def log_llm_payload(log_type: str, payload: dict[str, Any]) -> None:
    """Log a structured LLM payload when logging is enabled."""
    if not env_bool("CHAT_SHELL_LOG_LLM_REQUESTS", default=False):
        return

    jsonable_payload = to_jsonable(payload)
    sanitized_payload = redact_sensitive_fields(jsonable_payload)
    json_payload = json.dumps(sanitized_payload, ensure_ascii=False, indent=2)
    logger.info("[%s] %s", log_type, json_payload)

    file_path = os.getenv("CHAT_SHELL_LOG_LLM_REQUESTS_FILE", "").strip()
    if not file_path:
        return

    try:
        p = Path(file_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(json_payload + "\n")
    except Exception:
        logger.exception("[%s] Failed to write request log file", log_type)


def log_llm_request_event(
    event: dict[str, Any], tool_names: list[str] | None = None
) -> None:
    """Log the JSON-like LLM request payload from callback events."""
    payload = {
        "event": event.get("event"),
        "name": event.get("name"),
        "run_id": event.get("run_id"),
        "tags": event.get("tags"),
        "metadata": event.get("metadata"),
        "tool_names": tool_names or [],
        "data": event.get("data") or {},
    }
    log_llm_payload("LLM_REQUEST", payload)


def log_direct_llm_request(
    *,
    messages: list[Any],
    tool_names: list[str] | None = None,
    request_name: str = "direct_llm_request",
    metadata: dict[str, Any] | None = None,
) -> None:
    """Log a direct LLM request that does not come through callback events."""
    synthetic_event = {
        "event": "direct_llm_request",
        "name": request_name,
        "run_id": None,
        "tags": ["direct"],
        "metadata": metadata or {},
        "tool_names": tool_names or [],
        "data": {
            "input": {
                "messages": messages,
            }
        },
    }
    log_llm_payload("LLM_REQUEST", synthetic_event)


def log_llm_response_event(
    event: dict[str, Any], tool_names: list[str] | None = None
) -> None:
    """Log the JSON-like LLM response payload from callback events."""
    data = event.get("data") or {}
    payload = {
        "event": event.get("event"),
        "name": event.get("name"),
        "run_id": event.get("run_id"),
        "tags": event.get("tags"),
        "metadata": event.get("metadata"),
        "tool_names": tool_names or [],
        "data": {
            "output": data.get("output"),
            "chunk": data.get("chunk"),
        },
    }
    log_llm_payload("LLM_RESPONSE", payload)


def log_direct_llm_response(
    *,
    response: Any,
    request_name: str = "direct_llm_request",
    tool_names: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Log a direct LLM response that does not come through callback events."""
    payload = {
        "event": "direct_llm_response",
        "name": request_name,
        "run_id": None,
        "tags": ["direct"],
        "metadata": metadata or {},
        "tool_names": tool_names or [],
        "data": {
            "output": response,
        },
    }
    log_llm_payload("LLM_RESPONSE", payload)
