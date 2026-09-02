# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated, bounded LLM proxy gateway for Wework cloud models."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit
from urllib.request import getproxies

import httpx
from fastapi import HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.types import Receive, Scope, Send

from app.core.byte_admission import ByteLease
from app.core.payload_codec import run_payload_codec
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.services.chat.config.model_resolver import extract_and_process_model_config
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.stream_client import (
    StreamRelayByteAdmission,
    StreamWorkerExecutionError,
    web_stream_relay_byte_admission,
    web_stream_rpc_admission,
)
from app.services.group_permission import get_user_groups

logger = logging.getLogger(__name__)

MODEL_TYPE_HEADER = "x-wegent-model-type"
MODEL_NAMESPACE_HEADER = "x-wegent-model-namespace"
MODEL_USER_ID_HEADER = "x-wegent-model-user-id"
UPSTREAM_HEADER_PREFIX = "x-wegent-upstream-header-"
SUPPORTED_MODEL_TYPES = {"public", "user", "group"}
PROTECTED_UPSTREAM_HEADERS = {
    "accept",
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    MODEL_TYPE_HEADER,
    MODEL_NAMESPACE_HEADER,
    MODEL_USER_ID_HEADER,
}
PROTECTED_UPSTREAM_HEADER_MARKERS = (
    "api-key",
    "apikey",
    "credential",
    "secret",
    "token",
)
LLM_PROXY_STREAM_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

LLM_PROXY_MAX_CHUNK_BYTES = 64 * 1024
LLM_PROXY_MAX_RESPONSE_BYTES = 128 * 1024 * 1024
LLM_PROXY_FIRST_BYTE_TIMEOUT_SECONDS = 60.0
LLM_PROXY_IDLE_TIMEOUT_SECONDS = 60.0
LLM_PROXY_MAX_DURATION_SECONDS = 600.0
LLM_PROXY_CONNECT_TIMEOUT_SECONDS = 10.0
LLM_PROXY_WRITE_TIMEOUT_SECONDS = 30.0
LLM_PROXY_POOL_TIMEOUT_SECONDS = 10.0
LLM_PROXY_CLOSE_TIMEOUT_SECONDS = 1.0


class StreamAdmission(Protocol):
    """Synchronous fail-fast admission shared by all Web stream relays."""

    def acquire(self) -> None: ...

    def release(self) -> None: ...


@dataclass(frozen=True)
class LLMProxyRelayLimits:
    """Hard resource and time limits for one raw upstream relay."""

    max_chunk_bytes: int = LLM_PROXY_MAX_CHUNK_BYTES
    max_response_bytes: int = LLM_PROXY_MAX_RESPONSE_BYTES
    first_byte_timeout_seconds: float = LLM_PROXY_FIRST_BYTE_TIMEOUT_SECONDS
    idle_timeout_seconds: float = LLM_PROXY_IDLE_TIMEOUT_SECONDS
    max_duration_seconds: float = LLM_PROXY_MAX_DURATION_SECONDS

    def __post_init__(self) -> None:
        if self.max_chunk_bytes <= 0:
            raise ValueError("max_chunk_bytes must be positive")
        if self.max_response_bytes < self.max_chunk_bytes:
            raise ValueError("max_response_bytes must cover one chunk")
        if (
            min(
                self.first_byte_timeout_seconds,
                self.idle_timeout_seconds,
                self.max_duration_seconds,
            )
            <= 0
        ):
            raise ValueError("LLM proxy relay timeouts must be positive")


class LLMProxyRelayError(RuntimeError):
    """Raised after response headers when the bounded raw relay must stop."""

    def __init__(self, message: str, *, error_code: str) -> None:
        super().__init__(message)
        self.error_code = error_code


class LLMProxyRelayTimeout(LLMProxyRelayError):
    """Raised when a raw upstream relay crosses a hard time boundary."""


class BoundedRawProxyRelay:
    """Own one upstream response and relay fixed raw chunks with backpressure."""

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        response: httpx.Response,
        admission: StreamAdmission,
        byte_admission: StreamRelayByteAdmission,
        limits: LLMProxyRelayLimits,
        started_at: float,
        first_byte_deadline: float,
    ) -> None:
        self._client = client
        self._response = response
        self._admission = admission
        self._byte_admission = byte_admission
        self._limits = limits
        self._deadline = started_at + limits.max_duration_seconds
        self._first_byte_deadline = first_byte_deadline
        self._closed = False
        self._close_lock = asyncio.Lock()

    @property
    def response(self) -> httpx.Response:
        """Return response metadata after upstream headers have arrived."""
        return self._response

    @property
    def remaining_duration_seconds(self) -> float:
        """Return wall-clock time left for upstream reads and downstream sends."""
        return max(0.0, self._deadline - asyncio.get_running_loop().time())

    @classmethod
    async def open(
        cls,
        request: httpx.Request,
        *,
        admission: StreamAdmission | None = None,
        byte_admission: StreamRelayByteAdmission | None = None,
        limits: LLMProxyRelayLimits | None = None,
        client_factory: Callable[..., httpx.AsyncClient] | None = None,
    ) -> "BoundedRawProxyRelay":
        """Reserve global capacity and wait boundedly for upstream headers."""
        relay_limits = limits or LLMProxyRelayLimits()
        stream_admission = admission or web_stream_rpc_admission
        relay_byte_admission = byte_admission or web_stream_relay_byte_admission
        stream_admission.acquire()
        client: httpx.AsyncClient | None = None
        try:
            loop = asyncio.get_running_loop()
            started_at = loop.time()
            first_byte_deadline = min(
                started_at + relay_limits.first_byte_timeout_seconds,
                started_at + relay_limits.max_duration_seconds,
            )
            factory = client_factory or httpx.AsyncClient
            client = factory(
                timeout=httpx.Timeout(
                    connect=LLM_PROXY_CONNECT_TIMEOUT_SECONDS,
                    read=None,
                    write=LLM_PROXY_WRITE_TIMEOUT_SECONDS,
                    pool=LLM_PROXY_POOL_TIMEOUT_SECONDS,
                )
            )
            response = await cls._wait_for_upstream_headers(
                client,
                request,
                deadline=first_byte_deadline,
            )
            return cls(
                client=client,
                response=response,
                admission=stream_admission,
                byte_admission=relay_byte_admission,
                limits=relay_limits,
                started_at=started_at,
                first_byte_deadline=first_byte_deadline,
            )
        except BaseException:
            try:
                if client is not None:
                    try:
                        await asyncio.wait_for(
                            client.aclose(),
                            timeout=LLM_PROXY_CLOSE_TIMEOUT_SECONDS,
                        )
                    except Exception:
                        logger.warning("Failed to close LLM proxy upstream client")
            finally:
                stream_admission.release()
            raise

    @staticmethod
    async def _wait_for_upstream_headers(
        client: httpx.AsyncClient,
        request: httpx.Request,
        *,
        deadline: float,
    ) -> httpx.Response:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise LLMProxyRelayTimeout(
                "LLM proxy timed out before upstream response headers",
                error_code="llm_proxy_first_byte_timeout",
            )
        try:
            return await asyncio.wait_for(
                client.send(request, stream=True),
                timeout=remaining,
            )
        except TimeoutError as error:
            raise LLMProxyRelayTimeout(
                "LLM proxy timed out before upstream response headers",
                error_code="llm_proxy_first_byte_timeout",
            ) from error

    async def stream(self) -> AsyncIterator[bytes]:
        """Yield raw bytes while holding each byte lease across downstream send."""
        iterator = self._response.aiter_raw(chunk_size=self._limits.max_chunk_bytes)
        first_chunk = True
        total_bytes = 0
        try:
            while True:
                lease = await self._acquire_chunk_lease(first_chunk=first_chunk)
                try:
                    chunk = await self._next_chunk(iterator, first_chunk=first_chunk)
                except StopAsyncIteration:
                    await lease.release()
                    return
                except BaseException:
                    await lease.release()
                    raise

                if not chunk:
                    await lease.release()
                    continue
                if len(chunk) > self._limits.max_chunk_bytes:
                    await lease.release()
                    raise LLMProxyRelayError(
                        "LLM proxy upstream emitted an oversized raw chunk",
                        error_code="llm_proxy_chunk_too_large",
                    )
                first_chunk = False
                total_bytes += len(chunk)
                if total_bytes > self._limits.max_response_bytes:
                    await lease.release()
                    raise LLMProxyRelayError(
                        "LLM proxy response exceeded its total byte limit",
                        error_code="llm_proxy_response_too_large",
                    )
                try:
                    yield chunk
                finally:
                    await lease.release()
        finally:
            await self.aclose()

    async def _acquire_chunk_lease(self, *, first_chunk: bool) -> ByteLease:
        deadline = self._deadline
        if first_chunk:
            deadline = min(deadline, self._first_byte_deadline)
        remaining = self._remaining_duration(deadline, first_chunk=first_chunk)
        try:
            return await asyncio.wait_for(
                self._byte_admission.acquire(self._limits.max_chunk_bytes),
                timeout=remaining,
            )
        except TimeoutError as error:
            raise self._timeout_error(first_chunk=first_chunk) from error

    async def _next_chunk(
        self,
        iterator: AsyncIterator[bytes],
        *,
        first_chunk: bool,
    ) -> bytes:
        loop = asyncio.get_running_loop()
        deadline = (
            self._first_byte_deadline
            if first_chunk
            else min(self._deadline, loop.time() + self._limits.idle_timeout_seconds)
        )
        remaining = self._remaining_duration(deadline, first_chunk=first_chunk)
        try:
            return await asyncio.wait_for(anext(iterator), timeout=remaining)
        except TimeoutError as error:
            raise self._timeout_error(first_chunk=first_chunk) from error

    def _remaining_duration(self, deadline: float, *, first_chunk: bool) -> float:
        now = asyncio.get_running_loop().time()
        if now >= self._deadline:
            raise LLMProxyRelayTimeout(
                "LLM proxy exceeded its total duration",
                error_code="llm_proxy_duration_exceeded",
            )
        remaining = deadline - now
        if remaining <= 0:
            raise self._timeout_error(first_chunk=first_chunk)
        return remaining

    def _timeout_error(self, *, first_chunk: bool) -> LLMProxyRelayTimeout:
        if asyncio.get_running_loop().time() >= self._deadline:
            return LLMProxyRelayTimeout(
                "LLM proxy exceeded its total duration",
                error_code="llm_proxy_duration_exceeded",
            )
        if first_chunk:
            return LLMProxyRelayTimeout(
                "LLM proxy timed out waiting for its first upstream byte",
                error_code="llm_proxy_first_byte_timeout",
            )
        return LLMProxyRelayTimeout(
            "LLM proxy upstream stream became idle",
            error_code="llm_proxy_idle_timeout",
        )

    async def aclose(self) -> None:
        """Idempotently close upstream resources and return global capacity."""
        async with self._close_lock:
            if self._closed:
                return
            self._closed = True
            try:
                try:
                    await asyncio.wait_for(
                        self._response.aclose(),
                        timeout=LLM_PROXY_CLOSE_TIMEOUT_SECONDS,
                    )
                except Exception:
                    logger.warning("Failed to close LLM proxy upstream response")
            finally:
                try:
                    await asyncio.wait_for(
                        self._client.aclose(),
                        timeout=LLM_PROXY_CLOSE_TIMEOUT_SECONDS,
                    )
                except Exception:
                    logger.warning("Failed to close LLM proxy upstream client")
                finally:
                    self._admission.release()


class BoundedRawProxyResponse(StreamingResponse):
    """Apply the relay deadline to the complete ASGI response lifecycle."""

    def __init__(self, relay: BoundedRawProxyRelay, *, media_type: str) -> None:
        self._relay = relay
        super().__init__(
            relay.stream(),
            status_code=relay.response.status_code,
            media_type=media_type,
            headers=LLM_PROXY_STREAM_HEADERS,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            async with asyncio.timeout(self._relay.remaining_duration_seconds):
                await super().__call__(scope, receive, send)
        except TimeoutError as error:
            raise LLMProxyRelayTimeout(
                "LLM proxy exceeded its total duration",
                error_code="llm_proxy_duration_exceeded",
            ) from error
        finally:
            try:
                close_iterator = getattr(self.body_iterator, "aclose", None)
                if close_iterator is not None:
                    await close_iterator()
            finally:
                await self._relay.aclose()


@dataclass(frozen=True)
class ProxyRequestHeaders:
    """Validated request headers detached from the ASGI request."""

    model_type: str
    namespace: str
    resource_user_id: int
    content_type: str | None
    accept: str | None
    custom_headers: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class PreparedProxyRequest:
    """Provider request data prepared outside the event loop."""

    upstream_url: str
    headers: tuple[tuple[str, str], ...]
    body: bytes
    log_url: str
    safe_proxies: dict[str, str]


def _resolve_upstream_target(
    model_name: str,
    model_config: dict[str, Any],
) -> tuple[str, dict[str, str]]:
    """Choose the upstream endpoint path and auth headers from model config.

    Supports OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages.
    The model's DB configuration is the single source of truth; if it cannot be
    mapped to a known upstream API, an explicit error is returned so operators
    can fix the Model CRD instead of silently falling back to /responses.
    """
    api_format = str(model_config.get("api_format") or "").strip().lower()
    protocol = str(model_config.get("protocol") or "").strip().lower()
    wire_api = str(model_config.get("wire_api") or "").strip().lower()
    provider_api_key = str(model_config.get("api_key") or "").strip()

    is_anthropic = protocol in {"claude", "anthropic-messages"}
    is_chat_completions = (
        api_format == "chat/completions"
        or protocol in {"openai", "openai-chat-completions"}
        or wire_api == "chat/completions"
    )
    is_responses = (
        api_format == "responses"
        or protocol == "openai-responses"
        or wire_api == "responses"
    )

    if protocol == "openai-responses" and api_format == "chat/completions":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Model '{model_name}' has conflicting protocol/apiFormat: "
                f"protocol={protocol!r}, api_format={api_format!r}. "
                "Use protocol 'openai-responses' with apiFormat 'responses'."
            ),
        )
    if protocol in {"claude", "anthropic-messages"} and api_format == "responses":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Model '{model_name}' has conflicting protocol/apiFormat: "
                f"protocol={protocol!r}, api_format={api_format!r}. "
                "Anthropic Messages does not support apiFormat 'responses'."
            ),
        )

    if is_anthropic:
        auth_headers: dict[str, str] = {"anthropic-version": "2023-06-01"}
        if provider_api_key:
            auth_headers["x-api-key"] = provider_api_key
        return "/v1/messages", auth_headers

    if is_responses:
        auth_headers = {}
        if provider_api_key:
            auth_headers["Authorization"] = f"Bearer {provider_api_key}"
        return "/responses", auth_headers

    if is_chat_completions:
        auth_headers = {}
        if provider_api_key:
            auth_headers["Authorization"] = f"Bearer {provider_api_key}"
        return "/chat/completions", auth_headers

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Model '{model_name}' has an unsupported or ambiguous protocol/apiFormat "
            f"configuration: protocol={protocol!r}, api_format={api_format!r}, "
            f"wire_api={wire_api!r}. "
            "Please update the Model CRD: use protocol 'openai-responses' with "
            "apiFormat 'responses' for OpenAI Responses, protocol 'openai' with "
            "apiFormat 'chat/completions' for OpenAI Chat Completions, or protocol "
            "'claude'/'anthropic-messages' for Anthropic Messages."
        ),
    )


def _join_upstream_url(base_url: str, endpoint_path: str) -> str:
    """Append an endpoint path without duplicating existing path segments."""
    parsed = urlsplit(base_url.strip())
    base_segments = [segment for segment in parsed.path.split("/") if segment]
    endpoint_segments = [
        segment for segment in endpoint_path.strip().split("/") if segment
    ]

    max_overlap = min(len(base_segments), len(endpoint_segments))
    overlap = next(
        (
            size
            for size in range(max_overlap, 0, -1)
            if base_segments[-size:] == endpoint_segments[:size]
        ),
        0,
    )
    path_segments = [*base_segments, *endpoint_segments[overlap:]]
    path = f"/{'/'.join(path_segments)}" if path_segments else ""
    return urlunsplit(parsed._replace(path=path))


def _safe_proxy_config() -> dict[str, str]:
    """Return proxy routing without exposing credentials."""
    safe_proxies: dict[str, str] = {}
    for scheme, proxy_url in getproxies().items():
        parsed = urlsplit(str(proxy_url))
        hostname = parsed.hostname or ""
        port = f":{parsed.port}" if parsed.port else ""
        safe_proxies[str(scheme)] = urlunsplit(
            (parsed.scheme, f"{hostname}{port}", parsed.path, "", "")
        )
    return safe_proxies


def _is_protected_upstream_header(name: str) -> bool:
    normalized = name.strip().lower().replace("_", "-")
    parts = normalized.split("-")
    return (
        normalized in PROTECTED_UPSTREAM_HEADERS
        or "auth" in parts
        or "authentication" in parts
        or any(marker in normalized for marker in PROTECTED_UPSTREAM_HEADER_MARKERS)
    )


def _extract_custom_upstream_headers(
    headers: dict[str, str],
) -> dict[str, str]:
    custom_headers: dict[str, str] = {}
    for header_name, value in headers.items():
        if not header_name.lower().startswith(UPSTREAM_HEADER_PREFIX):
            continue
        target_name = header_name[len(UPSTREAM_HEADER_PREFIX) :].strip()
        if not target_name or target_name.startswith("-"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid custom upstream header name",
            )
        if _is_protected_upstream_header(target_name):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Custom upstream header is protected: {target_name}",
            )
        custom_headers[target_name] = value
    return custom_headers


def _merge_headers_case_insensitive(
    *header_sources: dict[str, str],
) -> dict[str, str]:
    merged: dict[str, str] = {}
    names_by_lowercase: dict[str, str] = {}
    for headers in header_sources:
        for name, value in headers.items():
            normalized = name.lower()
            previous_name = names_by_lowercase.get(normalized)
            if previous_name is not None:
                merged.pop(previous_name, None)
            merged[name] = value
            names_by_lowercase[normalized] = name
    return merged


def _required_header(headers: dict[str, str], name: str) -> str:
    value = (headers.get(name) or "").strip()
    if not value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Missing {name} header",
        )
    return value


def _resource_user_id(headers: dict[str, str]) -> int:
    raw_value = _required_header(headers, MODEL_USER_ID_HEADER)
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {MODEL_USER_ID_HEADER} header",
        ) from exc
    if value < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {MODEL_USER_ID_HEADER} header",
        )
    return value


def _validate_model_access(
    db: Session,
    user_id: int,
    model_type: str,
    namespace: str,
    resource_user_id: int,
) -> None:
    if model_type == "user":
        allowed = namespace == "default" and resource_user_id == user_id
    elif model_type == "public":
        allowed = namespace == "default" and resource_user_id == 0
    elif model_type == "group":
        allowed = namespace != "default" and namespace in get_user_groups(db, user_id)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported cloud model type: {model_type}",
        )

    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cloud model access denied",
        )


def resolve_llm_proxy_model_config_for_user(
    db: Session,
    *,
    user_id: int,
    user_name: str,
    model_name: str,
    model_type: str,
    namespace: str,
    resource_user_id: int,
) -> dict[str, Any]:
    """Resolve an authorized Model CRD using detached user identity fields."""
    if model_type not in SUPPORTED_MODEL_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported cloud model type: {model_type}",
        )
    _validate_model_access(
        db,
        user_id,
        model_type,
        namespace,
        resource_user_id,
    )

    kind = (
        db.query(Kind)
        .filter(
            Kind.user_id == resource_user_id,
            Kind.kind == "Model",
            Kind.namespace == namespace,
            Kind.name == model_name,
            Kind.is_active == True,
        )
        .first()
    )
    if not kind or not kind.json:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cloud model not found",
        )
    return extract_and_process_model_config(
        model_spec=kind.json.get("spec", {}),
        user_id=user_id,
        user_name=user_name,
    )


def _parse_request_body(body_bytes: bytes) -> tuple[dict[str, Any], str]:
    try:
        body = json.loads(body_bytes)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM proxy request body must be valid JSON",
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM proxy request body must be an object",
        )
    model_name = body.get("model")
    if not isinstance(model_name, str) or not model_name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM proxy request model is required",
        )
    return body, model_name.strip()


def _parse_proxy_request(
    body_bytes: bytes,
    raw_headers: tuple[tuple[str, str], ...],
) -> tuple[dict[str, Any], str, ProxyRequestHeaders]:
    body, model_name = _parse_request_body(body_bytes)
    headers = {name.lower(): value for name, value in raw_headers}
    model_type = _required_header(headers, MODEL_TYPE_HEADER)
    namespace = _required_header(headers, MODEL_NAMESPACE_HEADER)
    resource_user_id = _resource_user_id(headers)
    custom_headers = _extract_custom_upstream_headers(headers)
    return (
        body,
        model_name,
        ProxyRequestHeaders(
            model_type=model_type,
            namespace=namespace,
            resource_user_id=resource_user_id,
            content_type=headers.get("content-type"),
            accept=headers.get("accept"),
            custom_headers=tuple(custom_headers.items()),
        ),
    )


def _resolve_proxy_model_sync(
    user_id: int,
    user_name: str,
    model_name: str,
    headers: ProxyRequestHeaders,
) -> dict[str, Any]:
    with SessionLocal() as db:
        return resolve_llm_proxy_model_config_for_user(
            db,
            user_id=user_id,
            user_name=user_name,
            model_name=model_name,
            model_type=headers.model_type,
            namespace=headers.namespace,
            resource_user_id=headers.resource_user_id,
        )


def _prepare_upstream_request(
    body_json: dict[str, Any],
    model_name: str,
    model_config: dict[str, Any],
    request_headers: ProxyRequestHeaders,
) -> PreparedProxyRequest:
    provider_base_url = str(model_config.get("base_url") or "").strip()
    provider_model_id = str(model_config.get("model_id") or "").strip()
    if not provider_base_url or not provider_model_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model configuration incomplete",
        )

    upstream_body = {**body_json, "model": provider_model_id}
    body_bytes = json.dumps(upstream_body).encode("utf-8")
    upstream_path, auth_headers = _resolve_upstream_target(model_name, model_config)
    upstream_url = _join_upstream_url(provider_base_url, upstream_path)

    default_headers = model_config.get("default_headers") or {}
    configured_headers = (
        {str(key): str(value) for key, value in default_headers.items()}
        if isinstance(default_headers, dict)
        else {}
    )
    provider_headers = _merge_headers_case_insensitive(
        configured_headers,
        dict(request_headers.custom_headers),
    )
    protocol_headers: dict[str, str] = dict(auth_headers)
    if request_headers.content_type:
        protocol_headers["Content-Type"] = request_headers.content_type
    if request_headers.accept:
        protocol_headers["Accept"] = request_headers.accept
    provider_headers = _merge_headers_case_insensitive(
        provider_headers,
        protocol_headers,
    )
    log_url = urlunsplit(urlsplit(upstream_url)._replace(query="", fragment=""))
    return PreparedProxyRequest(
        upstream_url=upstream_url,
        headers=tuple(provider_headers.items()),
        body=body_bytes,
        log_url=log_url,
        safe_proxies=_safe_proxy_config(),
    )


async def proxy_llm_responses(
    request: Request,
    user_id: int,
    user_name: str,
) -> StreamingResponse:
    """Resolve a cloud model for the authenticated user and stream its response."""
    body_bytes = await request.body()
    raw_headers = tuple(request.headers.items())
    body_json, model_name, request_headers = await run_payload_codec(
        _parse_proxy_request,
        body_bytes,
        raw_headers,
        payload_hint=(body_bytes, raw_headers),
        force_offload=True,
    )
    model_config = await run_sync_in_executor(
        _resolve_proxy_model_sync,
        user_id,
        user_name,
        model_name,
        request_headers,
    )
    prepared = await run_payload_codec(
        _prepare_upstream_request,
        body_json,
        model_name,
        model_config,
        request_headers,
        payload_hint=(body_json, model_config, request_headers),
        force_offload=True,
    )

    logger.info(
        "LLM proxy transport configured user=%s upstream=%s proxies=%s",
        user_id,
        prepared.log_url,
        prepared.safe_proxies,
    )
    upstream_request = httpx.Request(
        "POST",
        prepared.upstream_url,
        headers=prepared.headers,
        content=prepared.body,
    )
    try:
        relay = await BoundedRawProxyRelay.open(upstream_request)
    except StreamWorkerExecutionError as exc:
        if exc.error_code == "web_stream_overloaded":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
                headers={"Retry-After": "1"},
            ) from exc
        raise
    except (LLMProxyRelayTimeout, httpx.TimeoutException) as exc:
        logger.error(
            "LLM proxy upstream timed out for user %s: %s",
            user_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Upstream request timed out",
        ) from exc
    except httpx.RequestError as exc:
        logger.error(
            "LLM proxy upstream request failed for user %s: %s",
            user_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Upstream request failed: {exc}",
        ) from exc

    content_type = relay.response.headers.get("content-type", "text/event-stream")
    return BoundedRawProxyResponse(relay, media_type=content_type)
