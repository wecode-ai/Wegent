# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gateway for the external Sites project API."""

from typing import Any

import httpx
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.site import SiteListResponse, SiteResponse
from shared.telemetry.decorators import trace_async


class SitesNotAvailableError(RuntimeError):
    """Raised when the Sites integration is not fully configured."""


class SitesUpstreamUnavailableError(RuntimeError):
    """Raised when the configured Sites service cannot return a valid response."""


class SitesUpstreamAuthenticationError(RuntimeError):
    """Raised when the Sites service rejects Backend authentication."""


class SitesUpstreamResponseError(RuntimeError):
    """Raised when the Sites service returns an HTTP error response."""

    def __init__(self, status_code: int, detail: Any) -> None:
        super().__init__(f"Sites service returned HTTP {status_code}")
        self.status_code = status_code
        self.detail = detail


class SitesService:
    """Call Sites with server-controlled configuration and user identity."""

    def __init__(self, timeout_seconds: float = 10.0) -> None:
        self._timeout_seconds = timeout_seconds

    @staticmethod
    def _configuration() -> tuple[str, str]:
        base_url = settings.SITES_API_BASE_URL.strip().rstrip("/")
        token = settings.SITES_API_TOKEN.get_secret_value().strip()
        if not base_url or not token:
            raise SitesNotAvailableError("Sites is not configured")
        return base_url, token

    @trace_async(
        span_name="sites.upstream.request",
        tracer_name="backend.sites",
        extract_attributes=lambda _self, method, path, **_kwargs: {
            "method": method,
            "path": path,
        },
    )
    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        base_url, token = self._configuration()
        request_kwargs: dict[str, Any] = {
            "params": params,
            "headers": {"Authorization": f"Bearer {token}"},
        }
        if json_body is not None:
            request_kwargs["json"] = json_body

        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{base_url}{path}",
                    **request_kwargs,
                )
        except httpx.RequestError as exc:
            raise SitesUpstreamUnavailableError("Sites service is unavailable") from exc

        if response.status_code == httpx.codes.UNAUTHORIZED:
            raise SitesUpstreamAuthenticationError(
                "Sites service authentication failed"
            )
        if response.is_error:
            raise SitesUpstreamResponseError(
                response.status_code,
                self._response_detail(response),
            )
        if response.status_code == httpx.codes.NO_CONTENT:
            return None

        try:
            return response.json()
        except ValueError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid response"
            ) from exc

    @staticmethod
    def _response_detail(response: httpx.Response) -> Any:
        try:
            payload = response.json()
        except ValueError:
            return response.text or f"Sites request failed: HTTP {response.status_code}"

        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                return error
            if "detail" in payload:
                return payload["detail"]
        return payload if payload is not None else response.text

    async def list_sites(
        self,
        *,
        username: str,
        query: str | None,
        cursor: str | None,
        limit: int,
    ) -> SiteListResponse:
        params: dict[str, Any] = {
            "username": username,
            "sitename": query or "",
            "limit": limit,
        }
        if cursor:
            params["cursor"] = cursor
        payload = await self._request("GET", "/v1/projects/search", params=params)
        try:
            return SiteListResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid project list"
            ) from exc

    @staticmethod
    def _validate_site(payload: Any) -> SiteResponse:
        try:
            return SiteResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid project"
            ) from exc


sites_service = SitesService()
