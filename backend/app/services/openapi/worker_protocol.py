# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wire contract for worker-owned OpenAPI Responses execution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

OPENAPI_STREAM_FRAME_SSE = b"S"
OPENAPI_STREAM_FRAME_HEARTBEAT = b"H"
OPENAPI_STREAM_FRAME_COMPLETE = b"C"
OPENAPI_STREAM_FRAME_ERROR = b"E"

# One projected OpenAPI event can contain the accumulated final answer. Keep the
# bound aligned with the existing local execution frame limit while preventing a
# single peer frame from causing unbounded allocation.
OPENAPI_STREAM_MAX_FRAME_BYTES = 32 * 1024 * 1024
OPENAPI_STREAM_MAX_TOTAL_BYTES = 128 * 1024 * 1024
OPENAPI_STREAM_MAX_DURATION_SECONDS = 30 * 60.0
OPENAPI_STREAM_EVENT_QUEUE_CAPACITY = 64


@dataclass(frozen=True)
class OpenAPIStreamSpec:
    """Immutable response metadata prepared by Web and consumed by the worker."""

    response_id: str
    model_string: str
    created_at: int
    previous_response_id: str | None = None
    task_context: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "response_id": self.response_id,
            "model_string": self.model_string,
            "created_at": self.created_at,
            "previous_response_id": self.previous_response_id,
            "task_context": self.task_context,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "OpenAPIStreamSpec":
        response_id = value.get("response_id")
        model_string = value.get("model_string")
        created_at = value.get("created_at")
        previous_response_id = value.get("previous_response_id")
        task_context = value.get("task_context")
        if (
            not isinstance(response_id, str)
            or not response_id
            or not isinstance(model_string, str)
            or not model_string
            or not isinstance(created_at, int)
            or created_at <= 0
            or (
                previous_response_id is not None
                and not isinstance(previous_response_id, str)
            )
            or (task_context is not None and not isinstance(task_context, dict))
        ):
            raise ValueError("Invalid OpenAPI stream specification")
        return cls(
            response_id=response_id,
            model_string=model_string,
            created_at=created_at,
            previous_response_id=previous_response_id,
            task_context=task_context,
        )


@dataclass(frozen=True)
class OpenAPIExecutionOutcome:
    """Small control result returned after worker-owned non-stream execution."""

    status: str
    terminal_type: str | None = None
    error: str | None = None
    error_code: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "terminal_type": self.terminal_type,
            "error": self.error,
            "error_code": self.error_code,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "OpenAPIExecutionOutcome":
        status = value.get("status")
        terminal_type = value.get("terminal_type")
        error = value.get("error")
        error_code = value.get("error_code")
        if (
            status not in {"completed", "in_progress", "queued", "failed"}
            or (terminal_type is not None and not isinstance(terminal_type, str))
            or (error is not None and not isinstance(error, str))
            or (error_code is not None and not isinstance(error_code, str))
        ):
            raise ValueError("Invalid OpenAPI execution outcome")
        return cls(
            status=status,
            terminal_type=terminal_type,
            error=error,
            error_code=error_code,
        )
