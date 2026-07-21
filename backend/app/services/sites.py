# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gateway for the external Sites project API."""

from typing import Any

import httpx
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.site import SiteListResponse, SiteNetwork, SiteResponse


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
        json: dict[str, Any] | None = None,
    ) -> Any:
        headers = {}
        if settings.SITES_API_TOKEN.strip():
            headers["Authorization"] = f"Bearer {settings.SITES_API_TOKEN.strip()}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self._base_url()}{path}",
                    params=params,
                    json=json,
                    headers=headers or None,
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
        return await self._list_platform_sites(
            username=username,
            query=query,
            offset=offset,
            limit=limit,
        )

    async def delete_site(self, siteid: str, *, username: str | None = None) -> None:
        if not username:
            raise SitesUpstreamUnavailableError("Sites username is required")
        await self._request(
            "POST",
            "/api/v1/projects/del",
            json={"username": username, "project_id": siteid},
        )

    async def update_site_network(
        self,
        siteid: str,
        *,
        username: str,
        network: SiteNetwork,
    ) -> SiteResponse:
        payload = await self._request(
            "POST",
            "/api/v1/projects/deploy/network",
            json={
                "username": username,
                "project_id": siteid,
                "network": network,
            },
        )
        return self._site_from_platform_project(payload, username=username)

    async def update_site_name(
        self,
        siteid: str,
        *,
        username: str,
        sitename: str,
    ) -> SiteResponse:
        payload = await self._request(
            "POST",
            "/api/v1/projects/update",
            json={
                "username": username,
                "project_id": siteid,
                "sitename": sitename,
            },
        )
        return self._site_from_platform_project(payload, username=username)

    async def _list_platform_sites(
        self,
        *,
        username: str,
        query: str | None,
        offset: int,
        limit: int,
    ) -> SiteListResponse:
        cursor: str | None = None
        skipped = 0
        items: list[SiteResponse] = []
        has_more = False
        query_value = query.lower() if query else None

        while len(items) < limit:
            params: dict[str, Any] = {"username": username, "limit": 100}
            if query:
                params["sitename"] = query
            if cursor:
                params["cursor"] = cursor
            payload = await self._request(
                "GET", "/api/v1/projects/search", params=params
            )
            page_items = payload.get("items", []) if isinstance(payload, dict) else []
            if not isinstance(page_items, list):
                raise SitesUpstreamUnavailableError(
                    "Sites service returned an invalid project list"
                )
            for project in page_items:
                if query_value and not self._project_matches_query(
                    project, query_value
                ):
                    continue
                if skipped < offset:
                    skipped += 1
                    continue
                if len(items) < limit:
                    items.append(
                        self._site_from_platform_project(project, username=username)
                    )
                else:
                    has_more = True
                    break
            cursor = payload.get("next_cursor") if isinstance(payload, dict) else None
            if has_more or not cursor:
                break

        return SiteListResponse(
            items=items,
            total=offset + len(items) + (1 if has_more or cursor else 0),
            offset=offset,
            limit=limit,
            next_cursor=cursor,
        )

    @staticmethod
    def _project_matches_query(payload: Any, query: str) -> bool:
        if not isinstance(payload, dict):
            return False
        title = payload.get("title")
        return isinstance(title, str) and query in title.lower()

    @staticmethod
    def _site_from_platform_project(payload: Any, *, username: str) -> SiteResponse:
        if not isinstance(payload, dict):
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid project"
            )
        url = payload.get("url")
        if not isinstance(url, str) or not url:
            raise SitesUpstreamUnavailableError(
                "Sites service returned a project without a URL"
            )
        network = payload.get("network")
        is_outer = network == "outer"
        siteid = payload.get("id")
        created_at = payload.get("created_at")
        snapshot = payload.get("snapshot")
        site = {
            "siteid": siteid,
            "taskid": siteid,
            "username": username,
            "name": payload.get("title"),
            "slug": siteid,
            "internal_url": url,
            "external_url": url if is_outer else None,
            "publish_status": "published" if is_outer else "unpublished",
            "last_publish_error": None,
            "thumbnail_url": (
                snapshot if isinstance(snapshot, str) and snapshot else None
            ),
            "created_at": created_at,
            "updated_at": created_at,
            "published_at": None,
        }
        return SitesService._validate_site(site)

    @staticmethod
    def _validate_site(payload: Any) -> SiteResponse:
        try:
            return SiteResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid site"
            ) from exc


sites_service = SitesService()
