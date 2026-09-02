# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""ASGI request-body limits applied before JSON decoding."""

from __future__ import annotations

import re
import threading
from collections.abc import Mapping, Sequence
from typing import Pattern

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.payload_codec import run_payload_codec

CALLBACK_EVENT_BODY_MAX_BYTES = 1024 * 1024
CALLBACK_BATCH_BODY_MAX_BYTES = 4 * 1024 * 1024
PROMPT_DRAFT_BODY_MAX_BYTES = 512 * 1024
DEEP_RESEARCH_BODY_MAX_BYTES = 512 * 1024
WIZARD_BODY_MAX_BYTES = 1024 * 1024
MODEL_RUNTIME_BODY_MAX_BYTES = 16 * 1024 * 1024
LLM_PROXY_BODY_MAX_BYTES = 16 * 1024 * 1024
OPENAPI_RESPONSES_BODY_MAX_BYTES = 16 * 1024 * 1024
DEFAULT_REQUEST_BODY_MAX_BYTES = 16 * 1024 * 1024
DEFAULT_MULTIPART_BODY_MAX_BYTES = DEFAULT_REQUEST_BODY_MAX_BYTES
MULTIPART_FORM_OVERHEAD_MAX_BYTES = 1024 * 1024
TEAM_ICON_FILE_MAX_BYTES = 2 * 1024 * 1024
REQUEST_BODY_ADMISSION_MAX_BYTES = 64 * 1024 * 1024
REQUEST_BODY_ADMISSION_MAX_REQUESTS = 128
REQUEST_BODY_ADMISSION_MAX_MULTIPART_REQUESTS = 4

_REQUEST_BODY_ADMISSION_SCOPE_KEY = "wegent_request_body_admission"
_REQUEST_BODY_BUFFER_SCOPE_KEY = "wegent_request_body_buffer"


class RequestBodyTooLargeError(HTTPException):
    """Raised while a streamed request exceeds its process-level hard limit."""

    def __init__(self, limit: int) -> None:
        super().__init__(status_code=413, detail=_limit_message(limit))


class _RequestBodyAdmissionLease:
    """One idempotently releasable process-local body admission."""

    def __init__(
        self,
        admission: "_RequestBodyAdmission",
        reserved_bytes: int,
    ) -> None:
        self._admission = admission
        self._reserved_bytes = reserved_bytes
        self._released = False

    def release(self) -> None:
        self._admission.release(self)


class _RequestBodyAdmission:
    """Bound buffered request bodies before they reach endpoint decoding."""

    def __init__(self, *, max_requests: int, max_bytes: int) -> None:
        if max_requests <= 0:
            raise ValueError("max_requests must be positive")
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self._max_requests = max_requests
        self._max_bytes = max_bytes
        self._active_requests = 0
        self._reserved_bytes = 0
        self._lock = threading.Lock()

    def try_acquire(self, reserved_bytes: int) -> _RequestBodyAdmissionLease | None:
        if reserved_bytes < 0:
            raise ValueError("reserved_bytes must not be negative")
        with self._lock:
            if (
                self._active_requests >= self._max_requests
                or self._reserved_bytes + reserved_bytes > self._max_bytes
            ):
                return None
            self._active_requests += 1
            self._reserved_bytes += reserved_bytes
            return _RequestBodyAdmissionLease(self, reserved_bytes)

    def release(self, lease: _RequestBodyAdmissionLease) -> None:
        with self._lock:
            if lease._released:
                return
            lease._released = True
            self._active_requests -= 1
            self._reserved_bytes -= lease._reserved_bytes


def release_request_body_admission(scope: Scope) -> None:
    """Release body admission after JSON/Pydantic decoding has completed."""
    state = scope.get("state")
    if not isinstance(state, dict):
        return
    lease = state.get(_REQUEST_BODY_ADMISSION_SCOPE_KEY)
    if isinstance(lease, _RequestBodyAdmissionLease):
        lease.release()


def get_buffered_request_body(scope: Scope) -> bytes | None:
    """Return the globally bounded body without reading the ASGI stream again."""
    state = scope.get("state")
    if not isinstance(state, dict):
        return None
    body = state.get(_REQUEST_BODY_BUFFER_SCOPE_KEY)
    return body if isinstance(body, bytes) else None


def callback_request_body_limits(api_prefix: str) -> dict[str, int]:
    """Return exact callback paths and their raw request-body limits."""
    base_path = f"{api_prefix.rstrip('/')}/internal/callback"
    return {
        base_path: CALLBACK_EVENT_BODY_MAX_BYTES,
        f"{base_path}/": CALLBACK_EVENT_BODY_MAX_BYTES,
        f"{base_path}/batch": CALLBACK_BATCH_BODY_MAX_BYTES,
        f"{base_path}/batch/": CALLBACK_BATCH_BODY_MAX_BYTES,
    }


def streaming_request_body_limits(api_prefix: str) -> dict[str, int]:
    """Return exact streaming POST paths and their raw body limits."""
    prefix = api_prefix.rstrip("/")
    return {
        **callback_request_body_limits(prefix),
        f"{prefix}/model-runtime/responses": MODEL_RUNTIME_BODY_MAX_BYTES,
        f"{prefix}/model-runtime/responses/": MODEL_RUNTIME_BODY_MAX_BYTES,
        f"{prefix}/runtime-work/llm-responses-proxy/responses": (
            LLM_PROXY_BODY_MAX_BYTES
        ),
        f"{prefix}/runtime-work/llm-responses-proxy/responses/": (
            LLM_PROXY_BODY_MAX_BYTES
        ),
        f"{prefix}/v1/responses": OPENAPI_RESPONSES_BODY_MAX_BYTES,
        f"{prefix}/v1/responses/": OPENAPI_RESPONSES_BODY_MAX_BYTES,
        f"{prefix}/v1/deep-research": DEEP_RESEARCH_BODY_MAX_BYTES,
        f"{prefix}/v1/deep-research/": DEEP_RESEARCH_BODY_MAX_BYTES,
        **{
            path: WIZARD_BODY_MAX_BYTES
            for route in (
                "generate-followup",
                "recommend-config",
                "generate-prompt",
                "test-prompt",
                "test-prompt/stream",
                "iterate-prompt",
            )
            for path in (
                f"{prefix}/wizard/{route}",
                f"{prefix}/wizard/{route}/",
            )
        },
    }


def multipart_request_body_limits(
    api_prefix: str,
    *,
    max_attachment_file_bytes: int,
    max_feedback_bundle_bytes: int | None = None,
    max_plugin_package_bytes: int | None = None,
    max_skill_package_bytes: int | None = None,
    max_team_icon_bytes: int | None = None,
) -> dict[str, int]:
    """Return raw multipart limits for exact upload endpoints."""
    if max_attachment_file_bytes <= 0:
        raise ValueError("max_attachment_file_bytes must be positive")
    prefix = api_prefix.rstrip("/")
    limits: dict[str, int] = {}

    def add(path: str, file_limit: int | None) -> None:
        if file_limit is None:
            return
        if file_limit <= 0:
            raise ValueError("multipart file limits must be positive")
        body_limit = file_limit + MULTIPART_FORM_OVERHEAD_MAX_BYTES
        limits[path] = body_limit
        limits[f"{path}/"] = body_limit

    add(f"{prefix}/attachments/upload", max_attachment_file_bytes)
    add(f"{prefix}/v1/attachments/upload", max_attachment_file_bytes)
    add(f"{prefix}/v1/feedback", max_feedback_bundle_bytes)
    add(f"{prefix}/plugins/upload", max_plugin_package_bytes)
    add(f"{prefix}/v1/kinds/skills/upload", max_skill_package_bytes)
    add(f"{prefix}/v1/kinds/skills/public/upload", max_skill_package_bytes)
    add(f"{prefix}/admin/public-teams/icon-assets", max_team_icon_bytes)
    return limits


def multipart_request_body_limit_patterns(
    api_prefix: str,
    *,
    max_cloud_file_bytes: int,
    max_delivery_asset_bytes: int,
    max_skill_package_bytes: int,
    max_work_queue_file_bytes: int,
) -> tuple[tuple[Pattern[str], int], ...]:
    """Return raw multipart limits for dynamic upload endpoints."""
    configured_limits = {
        "max_cloud_file_bytes": max_cloud_file_bytes,
        "max_delivery_asset_bytes": max_delivery_asset_bytes,
        "max_skill_package_bytes": max_skill_package_bytes,
        "max_work_queue_file_bytes": max_work_queue_file_bytes,
    }
    invalid = [name for name, value in configured_limits.items() if value <= 0]
    if invalid:
        raise ValueError(
            f"multipart file limits must be positive: {', '.join(invalid)}"
        )

    prefix = re.escape(api_prefix.rstrip("/"))

    def raw_limit(file_limit: int) -> int:
        return file_limit + MULTIPART_FORM_OVERHEAD_MAX_BYTES

    delivery_limit = raw_limit(max_delivery_asset_bytes)
    skill_limit = raw_limit(max_skill_package_bytes)
    return (
        (
            re.compile(rf"^{prefix}/v1/cloud-projects/[^/]+/files/?$"),
            raw_limit(max_cloud_file_bytes),
        ),
        (
            re.compile(rf"^{prefix}/v1/loop-items/[^/]+/attachments/?$"),
            delivery_limit,
        ),
        (
            re.compile(rf"^{prefix}/v1/deliveries/[^/]+/assets/?$"),
            delivery_limit,
        ),
        (
            re.compile(rf"^{prefix}/work-queues/by-name/[^/]+/messages/ingest/?$"),
            raw_limit(max_work_queue_file_bytes),
        ),
        (
            re.compile(rf"^{prefix}/v1/kinds/skills/public/\d+/upload/?$"),
            skill_limit,
        ),
        (
            re.compile(rf"^{prefix}/v1/kinds/skills/\d+/?$"),
            skill_limit,
        ),
    )


def streaming_request_body_limit_patterns(
    api_prefix: str,
) -> tuple[tuple[Pattern[str], int], ...]:
    """Return dynamic streaming POST paths and their raw body limits."""
    prefix = re.escape(api_prefix.rstrip("/"))
    return (
        (
            re.compile(rf"^{prefix}/tasks/\d+/prompt-drafts/generate/stream/?$"),
            PROMPT_DRAFT_BODY_MAX_BYTES,
        ),
        (
            re.compile(rf"^{prefix}/v1/deep-research/[^/]+/(?:status|stream)/?$"),
            DEEP_RESEARCH_BODY_MAX_BYTES,
        ),
    )


class RequestBodyLimitMiddleware:
    """Bound every HTTP body and pre-buffer selected CPU-sensitive paths."""

    def __init__(
        self,
        app: ASGIApp,
        path_limits: Mapping[str, int],
        path_patterns: Sequence[tuple[Pattern[str], int]] = (),
        multipart_path_limits: Mapping[str, int] | None = None,
        multipart_path_patterns: Sequence[tuple[Pattern[str], int]] = (),
        default_body_limit: int = DEFAULT_REQUEST_BODY_MAX_BYTES,
        multipart_body_limit: int = DEFAULT_MULTIPART_BODY_MAX_BYTES,
        max_in_flight_requests: int = REQUEST_BODY_ADMISSION_MAX_REQUESTS,
        max_in_flight_bytes: int = REQUEST_BODY_ADMISSION_MAX_BYTES,
        max_in_flight_multipart_requests: int = (
            REQUEST_BODY_ADMISSION_MAX_MULTIPART_REQUESTS
        ),
    ) -> None:
        if default_body_limit <= 0:
            raise ValueError("default_body_limit must be positive")
        if multipart_body_limit <= 0:
            raise ValueError("multipart_body_limit must be positive")
        self._app = app
        self._path_limits = dict(path_limits)
        self._path_patterns = tuple(path_patterns)
        self._multipart_path_limits = dict(multipart_path_limits or {})
        self._multipart_path_patterns = tuple(multipart_path_patterns)
        self._default_body_limit = default_body_limit
        self._multipart_body_limit = multipart_body_limit
        configured_limits = [
            *self._path_limits.values(),
            *(limit for _, limit in self._path_patterns),
        ]
        if configured_limits and max(configured_limits) > max_in_flight_bytes:
            raise ValueError(
                "max_in_flight_bytes must cover the largest request body limit"
            )
        self._admission = _RequestBodyAdmission(
            max_requests=max_in_flight_requests,
            max_bytes=max_in_flight_bytes,
        )
        self._multipart_admission = _RequestBodyAdmission(
            max_requests=max_in_flight_multipart_requests,
            max_bytes=1,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        path = scope.get("path", "")
        path_limit = self._resolve_limit(path)
        if path_limit is None and self._can_skip_body(scope):
            await self._app(scope, receive, send)
            return
        is_multipart = self._is_multipart(scope)
        multipart_path_limit = (
            self._resolve_multipart_limit(path) if is_multipart else None
        )
        streaming_body = is_multipart and (
            multipart_path_limit is not None or path_limit is None
        )
        if multipart_path_limit is not None:
            limit = multipart_path_limit
        elif streaming_body:
            limit = self._multipart_body_limit
        else:
            limit = path_limit or self._default_body_limit

        try:
            content_length = self._content_length(scope)
        except ValueError as exc:
            await self._reject(scope, receive, send, 400, str(exc))
            return
        if content_length is not None and content_length > limit:
            await self._reject(
                scope,
                receive,
                send,
                413,
                self._limit_message(limit),
            )
            return

        reserved_bytes = (
            0
            if streaming_body
            else content_length if content_length is not None else limit
        )
        lease = self._admission.try_acquire(reserved_bytes)
        if lease is None:
            await self._reject(
                scope,
                receive,
                send,
                503,
                "Request body admission capacity exhausted",
                headers={"Retry-After": "1"},
            )
            return

        multipart_lease = None
        if streaming_body:
            multipart_lease = self._multipart_admission.try_acquire(0)
            if multipart_lease is None:
                lease.release()
                await self._reject(
                    scope,
                    receive,
                    send,
                    503,
                    "Multipart request admission capacity exhausted",
                    headers={"Retry-After": "1"},
                )
                return

        state = scope.setdefault("state", {})
        state[_REQUEST_BODY_ADMISSION_SCOPE_KEY] = lease
        try:
            if streaming_body:
                await self._app(
                    scope,
                    self._stream_limited(receive, limit),
                    send,
                )
                return
            messages, exceeded = await self._receive_limited(receive, limit)
            if exceeded:
                await self._reject(
                    scope,
                    receive,
                    send,
                    413,
                    self._limit_message(limit),
                )
                return
            messages = await run_payload_codec(
                self._collapse_request_messages,
                messages,
                payload_hint=messages,
                force_offload=True,
            )
            state[_REQUEST_BODY_BUFFER_SCOPE_KEY] = self._collapsed_body(messages)
            await self._app(scope, self._replay(messages, receive), send)
        finally:
            if multipart_lease is not None:
                multipart_lease.release()
            lease.release()
            if state.get(_REQUEST_BODY_ADMISSION_SCOPE_KEY) is lease:
                state.pop(_REQUEST_BODY_ADMISSION_SCOPE_KEY)
            state.pop(_REQUEST_BODY_BUFFER_SCOPE_KEY, None)

    def _resolve_limit(self, path: str) -> int | None:
        exact_limit = self._path_limits.get(path)
        if exact_limit is not None:
            return exact_limit
        return next(
            (
                limit
                for pattern, limit in self._path_patterns
                if pattern.fullmatch(path)
            ),
            None,
        )

    def _resolve_multipart_limit(self, path: str) -> int | None:
        exact_limit = self._multipart_path_limits.get(path)
        if exact_limit is not None:
            return exact_limit
        return next(
            (
                limit
                for pattern, limit in self._multipart_path_patterns
                if pattern.fullmatch(path)
            ),
            None,
        )

    @classmethod
    def _can_skip_body(cls, scope: Scope) -> bool:
        if scope.get("method", "").upper() not in {"GET", "HEAD", "OPTIONS"}:
            return False
        header_names = {name.lower() for name, _ in scope.get("headers", [])}
        return b"content-length" not in header_names and b"transfer-encoding" not in (
            header_names
        )

    @staticmethod
    def _is_multipart(scope: Scope) -> bool:
        content_types = [
            value.lower()
            for name, value in scope.get("headers", [])
            if name.lower() == b"content-type"
        ]
        return (
            len(content_types) == 1
            and content_types[0].split(b";", 1)[0].strip() == b"multipart/form-data"
        )

    @staticmethod
    def _content_length(scope: Scope) -> int | None:
        values = [
            value
            for name, value in scope.get("headers", [])
            if name.lower() == b"content-length"
        ]
        if not values:
            return None
        if len(set(values)) != 1:
            raise ValueError("Conflicting Content-Length headers")
        try:
            content_length = int(values[0])
        except ValueError as exc:
            raise ValueError("Invalid Content-Length header") from exc
        if content_length < 0:
            raise ValueError("Invalid Content-Length header")
        return content_length

    @staticmethod
    async def _receive_limited(
        receive: Receive,
        limit: int,
    ) -> tuple[list[Message], bool]:
        messages: list[Message] = []
        received = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.disconnect":
                return messages, False
            if message["type"] != "http.request":
                continue
            received += len(message.get("body", b""))
            if received > limit:
                return messages, True
            if not message.get("more_body", False):
                return messages, False

    @staticmethod
    def _stream_limited(receive: Receive, limit: int) -> Receive:
        received = 0

        async def receive_limited() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] != "http.request":
                return message
            received += len(message.get("body", b""))
            if received > limit:
                raise RequestBodyTooLargeError(limit)
            return message

        return receive_limited

    @staticmethod
    def _replay(messages: list[Message], receive: Receive) -> Receive:
        index = 0

        async def replay() -> Message:
            nonlocal index
            if index < len(messages):
                message = messages[index]
                messages[index] = {"type": message["type"]}
                index += 1
                return message
            return await receive()

        return replay

    @staticmethod
    def _collapse_request_messages(messages: list[Message]) -> list[Message]:
        if any(message["type"] == "http.disconnect" for message in messages):
            return messages
        body = b"".join(
            message.get("body", b"")
            for message in messages
            if message["type"] == "http.request"
        )
        return [{"type": "http.request", "body": body, "more_body": False}]

    @staticmethod
    def _collapsed_body(messages: list[Message]) -> bytes | None:
        if len(messages) != 1 or messages[0]["type"] != "http.request":
            return None
        body = messages[0].get("body", b"")
        return body if isinstance(body, bytes) else None

    @staticmethod
    async def _reject(
        scope: Scope,
        receive: Receive,
        send: Send,
        status_code: int,
        detail: str,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        response = JSONResponse(
            status_code=status_code,
            content={"detail": detail},
            headers=headers,
        )
        await response(scope, receive, send)

    @staticmethod
    def _limit_message(limit: int) -> str:
        return _limit_message(limit)


def _limit_message(limit: int) -> str:
    return f"Request body exceeds {limit} bytes"
