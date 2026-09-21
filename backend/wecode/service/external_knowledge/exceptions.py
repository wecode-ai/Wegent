# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exceptions for external knowledge providers."""

from http import HTTPStatus


class ExternalKnowledgeError(RuntimeError):
    """Base external knowledge error with a stable provider code."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "internal_error",
        status_code: int = HTTPStatus.BAD_GATEWAY,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = int(status_code)


class ExternalKnowledgeNotConfiguredError(ExternalKnowledgeError):
    """Raised when a provider is missing required server-side config."""

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            code="not_configured",
            status_code=HTTPStatus.SERVICE_UNAVAILABLE,
        )


class ExternalKnowledgeEmployeeRequiredError(ExternalKnowledgeError):
    """Raised when the current user has no employee_id."""

    def __init__(self) -> None:
        super().__init__(
            "employee_id is required to use external knowledge",
            code="employee_id_required",
            status_code=HTTPStatus.FORBIDDEN,
        )


class ExternalKnowledgeEmployeeResolutionUnavailableError(ExternalKnowledgeError):
    """Raised when employee identity resolution is temporarily unavailable."""

    def __init__(self) -> None:
        super().__init__(
            "employee_id resolution is temporarily unavailable",
            code="employee_id_unavailable",
            status_code=HTTPStatus.SERVICE_UNAVAILABLE,
        )


def map_provider_error(code: str, message: str) -> ExternalKnowledgeError:
    """Map AP provider error codes to HTTP-facing errors."""
    status_by_code = {
        "unauthorized": HTTPStatus.UNAUTHORIZED,
        "forbidden": HTTPStatus.FORBIDDEN,
        "bad_request": HTTPStatus.BAD_REQUEST,
        "not_found": HTTPStatus.NOT_FOUND,
        "rate_limited": HTTPStatus.TOO_MANY_REQUESTS,
        "result_too_large": HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
        "internal_error": HTTPStatus.BAD_GATEWAY,
    }
    return ExternalKnowledgeError(
        message or code,
        code=code or "internal_error",
        status_code=status_by_code.get(code, HTTPStatus.BAD_GATEWAY),
    )
