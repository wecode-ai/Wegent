# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gateway for the external Sites service."""

from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.site import SiteListResponse, SiteResponse


class SitesNotAvailableError(RuntimeError):
    """Raised when the Sites integration is not configured."""


class SitesUpstreamUnavailableError(RuntimeError):
    """Raised when the configured Sites service cannot return a valid response."""


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
    def _base_url() -> str:
        base_url = settings.SITES_API_BASE_URL.strip().rstrip("/")
        if not base_url:
            raise SitesNotAvailableError("Sites is not configured")
        return base_url

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> Any:
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self._base_url()}{path}",
                    params=params,
                )
        except SitesNotAvailableError:
            raise
        except httpx.RequestError as exc:
            raise SitesUpstreamUnavailableError("Sites service is unavailable") from exc

        if response.is_error:
            raise SitesUpstreamResponseError(
                response.status_code,
                self._response_detail(response),
            )
        if response.status_code == 204:
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

        if isinstance(payload, dict) and "detail" in payload:
            return payload["detail"]
        return payload

    async def list_sites(
        self,
        *,
        username: str,
        query: str | None,
        offset: int,
        limit: int,
    ) -> SiteListResponse:
        params: dict[str, Any] = {
            "username": username,
            "offset": offset,
            "limit": limit,
        }
        if query:
            params["q"] = query
        payload = await self._request("GET", "/api/v1/sites", params=params)
        try:
            return SiteListResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid site list"
            ) from exc

    async def get_site(self, siteid: str) -> SiteResponse:
        encoded_siteid = quote(siteid, safe="")
        payload = await self._request("GET", f"/api/v1/sites/{encoded_siteid}")
        return self._validate_site(payload)

    async def publish_site(self, siteid: str) -> SiteResponse:
        encoded_siteid = quote(siteid, safe="")
        payload = await self._request(
            "POST",
            f"/api/v1/sites/{encoded_siteid}/publish",
        )
        return self._validate_site(payload)

    async def delete_site(self, siteid: str) -> None:
        encoded_siteid = quote(siteid, safe="")
        await self._request("DELETE", f"/api/v1/sites/{encoded_siteid}")

    @staticmethod
    def _validate_site(payload: Any) -> SiteResponse:
        try:
            return SiteResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid site"
            ) from exc


sites_service = SitesService()
