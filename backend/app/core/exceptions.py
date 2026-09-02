# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.bounded_executor import BoundedExecutorOverloaded
from app.core.payload_codec import run_payload_codec


def _make_json_serializable(value):
    """Convert validation error details into JSON-serializable values."""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, BaseException):
        return str(value)
    if isinstance(value, dict):
        return {key: _make_json_serializable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_make_json_serializable(item) for item in value]
    if isinstance(value, tuple):
        return [_make_json_serializable(item) for item in value]
    return value


class NotFoundException(HTTPException):
    """Resource not found exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


class ConflictException(HTTPException):
    """Resource conflict exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=detail)


class ForbiddenException(HTTPException):
    """Forbidden exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


class ValidationException(HTTPException):
    """Validation exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


class StructuredValidationException(HTTPException):
    """Validation exception with a stable frontend-localizable error code."""

    def __init__(self, error_code: str, payload: dict | None = None):
        detail = {"error_code": error_code, **(payload or {})}
        super().__init__(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)
        self.error_code = error_code
        self.payload = payload or {}


class CustomHTTPException(HTTPException):
    """Custom HTTP exception"""

    def __init__(
        self,
        status_code: int,
        detail: str | dict,
        error_code: int | str | None = None,
    ):
        super().__init__(status_code=status_code, detail=detail)
        self.error_code = error_code


def _build_json_response(
    status_code: int,
    content: dict,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=content,
        headers=headers,
    )


def _build_validation_response(exc: RequestValidationError) -> JSONResponse:
    return _build_json_response(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {
            "error_code": status.HTTP_422_UNPROCESSABLE_ENTITY,
            "detail": "Request parameter validation failed",
            "errors": _make_json_serializable(exc.errors()),
        },
    )


async def http_exception_handler(request, exc: HTTPException):
    """HTTP exception handler"""
    content = {
        "error_code": getattr(exc, "error_code", exc.status_code),
        "detail": exc.detail,
    }
    return await run_payload_codec(
        _build_json_response,
        exc.status_code,
        content,
        payload_hint=content,
        force_offload=True,
    )


async def framework_http_exception_handler(
    request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    """Preserve FastAPI's HTTP error envelope without loop-side encoding."""
    content = {"detail": exc.detail}
    return await run_payload_codec(
        _build_json_response,
        exc.status_code,
        content,
        exc.headers,
        payload_hint=content,
        force_offload=True,
    )


async def validation_exception_handler(request, exc: RequestValidationError):
    """Request validation exception handler"""
    return await run_payload_codec(
        _build_validation_response,
        exc,
        payload_hint=exc,
        force_offload=True,
    )


async def executor_overload_exception_handler(request, exc: BoundedExecutorOverloaded):
    """Reject overload instead of retaining unbounded Uvicorn waiters."""
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "error_code": status.HTTP_503_SERVICE_UNAVAILABLE,
            "detail": "Service is temporarily overloaded",
        },
        headers={"Retry-After": "1"},
    )


async def python_exception_handler(request, exc: Exception):
    """Python exception handler"""
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error_code": status.HTTP_500_INTERNAL_SERVER_ERROR,
            "detail": "Internal server error",
        },
    )
