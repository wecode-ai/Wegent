"""Shared schemas and strict validation for collaboration tools."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from importlib.resources import files
from typing import Any

from fastapi import HTTPException
from jsonschema import Draft202012Validator, FormatChecker

from shared.telemetry.decorators import trace_sync

SCHEMA = files("shared").joinpath("protocol/wework_space_tools_v2.json")
TOOLS = {
    tool["name"]: tool
    for tool in json.loads(SCHEMA.read_text(encoding="utf-8"))["tools"]
}


def failure(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


def digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def parse_timestamp(value: str) -> datetime:
    """Parse RFC 3339 case variants and normalize source timestamps to UTC."""
    stamp = datetime.fromisoformat(value.upper().replace("Z", "+00:00"))
    return stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).astimezone(timezone.utc)


@trace_sync("board_tools.validate", tracer_name="backend")
def validate(name: str, arguments: dict[str, Any]) -> None:
    schema = TOOLS[name]["inputSchema"]
    errors = list(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(
            arguments
        )
    )
    if errors:
        raise failure("invalid_request", errors[0].message)
    entries = arguments.get("items", [])
    identifiers = [entry["request_id"] for entry in entries]
    if len(identifiers) != len(set(identifiers)):
        raise failure("invalid_request", "request_id must be unique within a batch")
    if "statuses" in arguments and "exclude_statuses" in arguments:
        raise failure("invalid_request", "Status inclusion and exclusion are exclusive")
    if "assignees" in arguments and arguments.get("unassigned"):
        raise failure("invalid_request", "Assignees and unassigned are exclusive")
    for field in ("created_at", "updated_at", "due_at"):
        interval = arguments.get(field, {})
        if interval.get("from") and interval.get("to"):
            start = parse_timestamp(interval["from"])
            end = parse_timestamp(interval["to"])
            if start >= end:
                raise failure("invalid_request", f"Invalid {field} interval")


def counts(results: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(results),
        **{
            state: sum(result["state"] == state for result in results)
            for state in ("succeeded", "failed", "not_executed", "unknown")
        },
    }


def error_result(entry: dict[str, Any], error: Exception) -> dict[str, Any]:
    detail = error.detail if isinstance(error, HTTPException) else {}
    code = detail.get("code") if isinstance(detail, dict) else None
    if isinstance(error, HTTPException) and error.status_code in (403, 404):
        code = "not_found"
        message = "Target is unavailable"
    elif isinstance(error, HTTPException) and error.status_code == 409:
        code = code or "version_conflict"
        message = "Target changed; read it again before submitting"
    elif isinstance(error, (ValueError, HTTPException)):
        message = (
            str(detail.get("message", "Invalid operation"))
            if isinstance(detail, dict)
            else "Invalid operation"
        )
    else:
        message = "Operation failed"
    return {
        "request_id": entry["request_id"],
        "target": entry.get("target"),
        "state": "failed",
        "committed": False,
        "error": {
            "code": code or "invalid_operation",
            "message": message,
            "retryable": False,
        },
    }
