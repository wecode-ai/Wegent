# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared HTTP client for communicating with knowledge_runtime.

Both RemoteRagGateway and RemoteKbStatGateway use this to avoid
duplicating connection pool management, auth header construction,
and error parsing logic.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from pydantic import ValidationError

from app.core.config import settings
from shared.models import RemoteRagError

logger = logging.getLogger(__name__)


class RemoteRuntimeError(RuntimeError):
    """Raised when knowledge_runtime returns an error response."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "remote_request_failed",
        retryable: bool = False,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.status_code = status_code
        self.details = details


class RuntimeHttpClient:
    """Shared HTTP client for communicating with knowledge_runtime."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        timeout: float = 30.0,
        auth_token: str | None = None,
    ) -> None:
        self._base_url = (base_url or settings.KNOWLEDGE_RUNTIME_URL).rstrip("/")
        self._auth_token = auth_token or settings.INTERNAL_SERVICE_TOKEN
        headers = {}
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=timeout,
            headers=headers,
        )

    async def post(
        self,
        path: str,
        payload: Any,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST a Pydantic model to the runtime and return JSON response."""
        try:
            response = await self._client.post(
                path,
                json=payload.model_dump(mode="json", exclude_none=True),
                timeout=timeout,
            )
        except httpx.RequestError as exc:
            raise RemoteRuntimeError(
                f"knowledge_runtime transport error: {exc}",
                code="remote_transport_error",
                retryable=True,
                details={"path": path},
            ) from exc

        if response.is_error:
            self._raise_error(response)
        return response.json()

    async def get(
        self,
        path: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """GET from the runtime and return JSON response."""
        try:
            response = await self._client.get(path, timeout=timeout)
        except httpx.RequestError as exc:
            raise RemoteRuntimeError(
                f"knowledge_runtime transport error: {exc}",
                code="remote_transport_error",
                retryable=True,
                details={"path": path},
            ) from exc

        if response.is_error:
            self._raise_error(response)
        return response.json()

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _raise_error(response: httpx.Response) -> None:
        payload: dict[str, Any] | None = None
        try:
            raw_payload = response.json()
            if isinstance(raw_payload, dict):
                payload = raw_payload
        except ValueError:
            payload = None

        if payload is not None:
            try:
                remote_error = RemoteRagError.model_validate(payload)
            except ValidationError:
                remote_error = None
            else:
                raise RemoteRuntimeError(
                    remote_error.message,
                    code=remote_error.code,
                    retryable=remote_error.retryable,
                    status_code=response.status_code,
                    details=remote_error.details,
                )

        raise RemoteRuntimeError(
            response.text
            or f"knowledge_runtime request failed: {response.status_code}",
            status_code=response.status_code,
        )
