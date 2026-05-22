# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


def _make_json_serializable(value):
    """Convert validation error details into JSON-serializable values."""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
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
        self, status_code: int, detail: str, error_code: int | str | None = None
    ):
        super().__init__(status_code=status_code, detail=detail)
        self.error_code = error_code


async def http_exception_handler(request, exc: HTTPException):
    """HTTP exception handler"""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error_code": getattr(exc, "error_code", exc.status_code),
            "detail": exc.detail,
        },
    )


async def validation_exception_handler(request, exc: RequestValidationError):
    """Request validation exception handler"""
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error_code": status.HTTP_422_UNPROCESSABLE_ENTITY,
            "detail": "Request parameter validation failed",
            "errors": _make_json_serializable(exc.errors()),
        },
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
