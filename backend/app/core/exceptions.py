# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class NotFoundException(HTTPException):
    """Resource not found exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


class ConflictException(HTTPException):
    """Resource conflict exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_409_CONFLICT, detail=detail)


class ValidationException(HTTPException):
    """Validation exception"""

    def __init__(self, detail: str):
        super().__init__(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


class CustomHTTPException(HTTPException):
    """Custom HTTP exception"""

    def __init__(self, status_code: int, detail: str, error_code: int = None):
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
            "errors": exc.errors(),
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
