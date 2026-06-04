# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Starlette app factory for external knowledge MCP integrations."""

import logging
from contextlib import asynccontextmanager
from functools import partial
from typing import AsyncIterator

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.config import settings
from app.core.rate_limit import (
    ExternalMcpRateLimitStatus,
    check_external_mcp_dimension_rate_limit,
    check_external_mcp_rate_limit,
    hash_rate_limit_value,
)
from app.mcp_server.server import (
    EXTERNAL_KNOWLEDGE_MCP_MOUNT_PATH,
    EXTERNAL_KNOWLEDGE_MCP_TRANSPORT_PATH,
    EXTERNAL_KNOWLEDGE_PUBLIC_PATHS,
    MCP_TRANSPORT_METHODS,
    EmptyPathToSlashMiddleware,
    _ASGIPathAdapter,
    _external_knowledge_request_mount_path,
    _external_knowledge_request_user,
    _resolve_external_knowledge_user,
    ensure_external_knowledge_tools_registered,
    external_knowledge_mcp_server,
    extract_token_from_header,
)

logger = logging.getLogger(__name__)


def build_external_knowledge_mcp_app(
    mount_path: str = EXTERNAL_KNOWLEDGE_MCP_MOUNT_PATH,
) -> Starlette:
    """Create Starlette app for trusted external knowledge integrations."""
    ensure_external_knowledge_tools_registered()

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with external_knowledge_mcp_server.session_manager.run():
            yield

    routes = [
        Route("/health", _health_check, methods=["GET"]),
        Route("/", _root_metadata(mount_path), methods=["GET"]),
        Route("/documents/{document_id:int}/file", _document_file, methods=["GET"]),
        Route(
            EXTERNAL_KNOWLEDGE_MCP_TRANSPORT_PATH,
            endpoint=_ASGIPathAdapter(
                external_knowledge_mcp_server.streamable_http_app(),
                target_path="/",
            ),
            methods=MCP_TRANSPORT_METHODS,
        ),
    ]

    base_app = Starlette(debug=False, routes=routes, lifespan=lifespan)
    base_app.add_middleware(_ExternalKnowledgeRateLimitMiddleware)
    base_app.add_middleware(_ExternalKnowledgeAuthMiddleware, mount_path=mount_path)
    base_app.add_middleware(EmptyPathToSlashMiddleware)
    return base_app


async def _health_check(request: Request) -> JSONResponse:
    return JSONResponse(
        {"status": "healthy", "service": "wegent-knowledge-external-mcp"}
    )


def _root_metadata(mount_path: str):
    async def root_metadata(request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "service": "wegent-knowledge-external-mcp",
                "transport": "streamable-http",
                "endpoints": {
                    "mcp": f"{mount_path}{EXTERNAL_KNOWLEDGE_MCP_TRANSPORT_PATH}",
                    "health": f"{mount_path}/health",
                    "document_file": f"{mount_path}/documents/{{document_id}}/file",
                },
                "tools": [
                    "wegent_kb_list_knowledge_bases",
                    "wegent_kb_list_nodes",
                    "wegent_kb_get_document_content",
                    "wegent_kb_get_document_download",
                    "wegent_kb_search_content",
                ],
            }
        )

    return root_metadata


async def _document_file(request: Request) -> Response:
    from app.db.session import SessionLocal
    from app.services.knowledge.external_document_access import (
        DOWNLOAD_TOKEN_HEADER,
        ExternalDocumentAccessError,
        load_document_file_or_raise,
        verify_document_download_token,
    )

    document_id = _parse_document_id(request)
    if document_id is None:
        return JSONResponse(
            {"error": "Invalid document_id", "code": "bad_request"},
            status_code=400,
        )

    rate_limit_response = await _check_download_preauth_rate_limit(
        request,
        document_id,
    )
    if rate_limit_response is not None:
        return rate_limit_response

    token = request.headers.get(DOWNLOAD_TOKEN_HEADER, "")
    token_payload = verify_document_download_token(token)
    if token_payload is None or token_payload.document_id != document_id:
        return JSONResponse(
            {"error": "Invalid or expired download token", "code": "unauthorized"},
            status_code=401,
        )

    rate_limit_response = await _check_download_rate_limit(
        user_id=token_payload.user_id,
        document_id=document_id,
    )
    if rate_limit_response is not None:
        return rate_limit_response

    db = SessionLocal()
    try:
        document_file = await run_in_threadpool(
            load_document_file_or_raise,
            db,
            user_id=token_payload.user_id,
            document_id=document_id,
            disposition=token_payload.disposition,
        )
        return Response(
            content=document_file.content,
            media_type=document_file.media_type,
            headers={
                "Content-Disposition": document_file.content_disposition,
                "X-Content-Type-Options": "nosniff",
            },
        )
    except ExternalDocumentAccessError as exc:
        return JSONResponse(
            {"error": str(exc), "code": exc.code},
            status_code=_document_access_status_code(exc.code),
        )
    finally:
        db.close()


async def _check_download_preauth_rate_limit(
    request: Request,
    document_id: int,
) -> JSONResponse | None:
    if not settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED:
        return None

    client_ip = request.client.host if request.client else "unknown"
    ip_hash = hash_rate_limit_value(client_ip)
    ip_status = await run_in_threadpool(
        partial(
            check_external_mcp_dimension_rate_limit,
            dimensions=[f"ip:{ip_hash}"],
            namespace="download_preauth_ip",
            limit=settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_IP_RATE_LIMIT_REQUESTS,
            window_seconds=(
                settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_IP_RATE_LIMIT_WINDOW_SECONDS
            ),
        )
    )
    rate_limit_response = _download_rate_limit_response(ip_status)
    if rate_limit_response is not None:
        return rate_limit_response

    document_status = await run_in_threadpool(
        partial(
            check_external_mcp_dimension_rate_limit,
            dimensions=[f"ip:{ip_hash}:document:{document_id}"],
            namespace="download_preauth_document",
            limit=(
                settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_DOCUMENT_RATE_LIMIT_REQUESTS
            ),
            window_seconds=(
                settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_DOCUMENT_RATE_LIMIT_WINDOW_SECONDS
            ),
        )
    )
    return _download_rate_limit_response(document_status)


async def _check_download_rate_limit(
    *,
    user_id: int,
    document_id: int,
) -> JSONResponse | None:
    if not settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED:
        return None

    rate_limit_status = await run_in_threadpool(
        partial(
            check_external_mcp_dimension_rate_limit,
            dimensions=[f"user:{user_id}:document:{document_id}"],
            namespace="download",
            limit=settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_REQUESTS,
            window_seconds=(
                settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS
            ),
        )
    )
    return _download_rate_limit_response(rate_limit_status)


def _download_rate_limit_response(
    status: ExternalMcpRateLimitStatus,
) -> JSONResponse | None:
    if status == ExternalMcpRateLimitStatus.LIMITED:
        return JSONResponse(
            {"error": "Rate limit exceeded", "code": "rate_limited"},
            status_code=429,
        )
    if status == ExternalMcpRateLimitStatus.UNAVAILABLE:
        return JSONResponse(
            {
                "error": "Rate limit service unavailable",
                "code": "rate_limit_unavailable",
            },
            status_code=503,
        )
    return None


def _parse_document_id(request: Request) -> int | None:
    raw_document_id = request.path_params.get("document_id")
    try:
        return int(raw_document_id)
    except (TypeError, ValueError):
        return None


def _document_access_status_code(code: str) -> int:
    if code == "forbidden":
        return 403
    if code == "unsupported_media_type":
        return 415
    return 404


class _ExternalKnowledgeAuthMiddleware:
    def __init__(self, app: ASGIApp, mount_path: str) -> None:
        self.app = app
        self.mount_path = mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        if _is_public_or_document_file_path(scope):
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        token = extract_token_from_header(request.headers.get("authorization", ""))
        ctx_token = None
        mount_ctx_token = _external_knowledge_request_mount_path.set(self.mount_path)
        try:
            user = await _authenticate_external_user(
                token, request, scope, receive, send
            )
            if user is None:
                return

            ctx_token = _external_knowledge_request_user.set(user)
            await self.app(scope, receive, send)
        finally:
            if ctx_token is not None:
                _external_knowledge_request_user.reset(ctx_token)
            _external_knowledge_request_mount_path.reset(mount_ctx_token)


async def _authenticate_external_user(
    token: str | None,
    request: Request,
    scope: Scope,
    receive: Receive,
    send: Send,
):
    try:
        user = await _resolve_external_knowledge_user(token, request)
    except Exception as exc:
        logger.exception(
            "[MCP:KnowledgeExternal] External auth handler failed: %s", exc
        )
        await _send_json_error(
            scope,
            receive,
            send,
            error="Authentication failed",
            code="unauthorized",
            status_code=401,
        )
        return None

    if user is None:
        await _send_json_error(
            scope,
            receive,
            send,
            error="Authentication required",
            code="unauthorized",
            status_code=401,
        )
        return None
    return user


class _ExternalKnowledgeRateLimitMiddleware:
    """Redis-backed fixed-window rate limiter for external MCP transport."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope.get("type") != "http"
            or not settings.EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_ENABLED
        ):
            await self.app(scope, receive, send)
            return
        if _is_public_or_document_file_path(scope):
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        rate_limit_status = await run_in_threadpool(
            partial(
                check_external_mcp_rate_limit,
                request,
                namespace="transport",
                limit=settings.EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_REQUESTS,
                window_seconds=(
                    settings.EXTERNAL_KNOWLEDGE_MCP_RATE_LIMIT_WINDOW_SECONDS
                ),
            )
        )
        if rate_limit_status == ExternalMcpRateLimitStatus.LIMITED:
            await _send_json_error(
                scope,
                receive,
                send,
                error="Rate limit exceeded",
                code="rate_limited",
                status_code=429,
            )
            return
        if rate_limit_status == ExternalMcpRateLimitStatus.UNAVAILABLE:
            await _send_json_error(
                scope,
                receive,
                send,
                error="Rate limit service unavailable",
                code="rate_limit_unavailable",
                status_code=503,
            )
            return

        await self.app(scope, receive, send)


async def _send_json_error(
    scope: Scope,
    receive: Receive,
    send: Send,
    *,
    error: str,
    code: str,
    status_code: int,
) -> None:
    response = JSONResponse({"error": error, "code": code}, status_code=status_code)
    await response(scope, receive, send)


def _is_public_or_document_file_path(scope: Scope) -> bool:
    return _is_external_knowledge_public_path(scope) or _is_external_document_file_path(
        scope
    )


def _is_external_knowledge_public_path(scope: Scope) -> bool:
    path = _external_knowledge_subpath(scope)
    return path in EXTERNAL_KNOWLEDGE_PUBLIC_PATHS


def _external_knowledge_subpath(scope: Scope) -> str:
    path = str(scope.get("path") or "")
    root_path = str(scope.get("root_path") or "")
    if root_path and path.startswith(root_path):
        path = path[len(root_path) :]
    return path


def _is_external_document_file_path(scope: Scope) -> bool:
    path = _external_knowledge_subpath(scope)
    parts = [part for part in path.split("/") if part]
    return (
        len(parts) == 3
        and parts[0] == "documents"
        and parts[1].isdigit()
        and parts[2] == "file"
    )
