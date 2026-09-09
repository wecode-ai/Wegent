# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gateway for the external Sites project API."""

from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.site import (
    EnvironmentRevision,
    EnvironmentSnapshot,
    SiteAccessAudience,
    SiteAccessPolicy,
    SiteAppType,
    SiteCollaborator,
    SiteCollaboratorListResponse,
    SiteListItem,
    SiteListResponse,
    SiteNetwork,
    SiteResponse,
)
from app.services.site_application_types import (
    SITE_APPLICATION_HANDLER,
    ApplicationTypeHandler,
    InvalidApplicationProjectError,
    get_application_type_handler,
)


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
        headers: dict[str, str] | None = None,
    ) -> Any:
        request_headers = {}
        if settings.SITES_API_TOKEN.strip():
            request_headers["Authorization"] = (
                f"Bearer {settings.SITES_API_TOKEN.strip()}"
            )
        if headers:
            request_headers.update(headers)
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self._base_url()}{path}",
                    params=params,
                    json=json,
                    headers=request_headers or None,
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
        if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
            return payload["error"]
        return payload

    async def list_sites(
        self,
        *,
        username: str,
        app_type: SiteAppType,
        query: str | None,
        offset: int,
        limit: int,
    ) -> SiteListResponse:
        handler = get_application_type_handler(app_type)
        return await self._list_platform_sites(
            username=username,
            handler=handler,
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
            headers={"X-Wegent-Username": username},
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
            headers={"X-Wegent-Username": username},
        )
        return self._parse_site_project(payload, username=username)

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
            headers={"X-Wegent-Username": username},
        )
        return self._parse_site_project(payload, username=username)

    async def update_site_metadata(
        self,
        siteid: str,
        *,
        username: str,
        title: str | None = None,
        custom_domain_prefix: str | None = None,
        custom_domain_prefix_set: bool = False,
    ) -> SiteResponse:
        json_payload: dict[str, Any] = {}
        if title is not None:
            json_payload["title"] = title
        if custom_domain_prefix_set:
            json_payload["custom_domain_prefix"] = custom_domain_prefix
        payload = await self._request(
            "PATCH",
            f"/api/v1/projects/{siteid}",
            json=json_payload,
            headers={
                "Idempotency-Key": f"project-update-{uuid4().hex}",
                "X-Wegent-Username": username,
            },
        )
        return self._parse_site_project(payload, username=username)

    async def get_environment_variables(
        self,
        siteid: str,
        *,
        username: str,
    ) -> EnvironmentSnapshot:
        """Return the latest Project environment snapshot for management UI use."""
        payload = await self._request(
            "GET",
            f"/api/v1/projects/{quote(siteid, safe='')}/environment-variables",
            headers={"X-Wegent-Username": username},
        )
        return self._parse_environment_snapshot(payload)

    async def list_collaborators(
        self, siteid: str, *, username: str
    ) -> SiteCollaboratorListResponse:
        payload = await self._request(
            "GET",
            f"/api/v1/projects/{quote(siteid, safe='')}/collaborators",
            headers={"X-Wegent-Username": username},
        )
        try:
            return SiteCollaboratorListResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid collaborator list"
            ) from exc

    async def get_access_policy(
        self, siteid: str, *, username: str
    ) -> SiteAccessPolicy:
        payload = await self._request(
            "GET",
            f"/api/v1/projects/{quote(siteid, safe='')}/access",
            params={"target": "inner"},
            headers={"X-Wegent-Username": username},
        )
        return self._parse_access_policy(payload)

    async def update_access_policy(
        self,
        siteid: str,
        *,
        username: str,
        audience: SiteAccessAudience,
        subjects: list[str],
        idempotency_key: str,
        request_id: str,
    ) -> SiteAccessPolicy:
        body: dict[str, Any] = {
            "username": username,
            "target": "inner",
            "audience": audience,
        }
        if audience == "custom":
            body["subjects"] = ",".join(subjects)
        payload = await self._request(
            "PUT",
            f"/api/v1/projects/{quote(siteid, safe='')}/access",
            json=body,
            headers={
                "X-Wegent-Username": username,
                "Idempotency-Key": idempotency_key,
                "X-Request-ID": request_id,
            },
        )
        return self._parse_access_policy(payload)

    async def add_collaborator(
        self,
        siteid: str,
        *,
        username: str,
        subject: str,
        idempotency_key: str,
        request_id: str,
    ) -> SiteCollaborator:
        payload = await self._request(
            "POST",
            f"/api/v1/projects/{quote(siteid, safe='')}/collaborators",
            json={"subject": subject},
            headers={
                "X-Wegent-Username": username,
                "Idempotency-Key": idempotency_key,
                "X-Request-ID": request_id,
            },
        )
        try:
            return SiteCollaborator.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid collaborator"
            ) from exc

    async def remove_collaborator(
        self, siteid: str, subject: str, *, username: str, request_id: str
    ) -> None:
        await self._request(
            "DELETE",
            (
                f"/api/v1/projects/{quote(siteid, safe='')}/collaborators/"
                f"{quote(subject, safe='')}"
            ),
            headers={
                "X-Wegent-Username": username,
                "X-Request-ID": request_id,
            },
        )

    async def patch_environment_variables(
        self,
        siteid: str,
        *,
        username: str,
        body: dict[str, Any],
        idempotency_key: str,
        request_id: str,
    ) -> EnvironmentRevision:
        """Atomically update one Project environment configuration."""
        payload = await self._request(
            "PATCH",
            f"/api/v1/projects/{quote(siteid, safe='')}/environment-variables",
            json=body,
            headers=self._environment_write_headers(
                username, idempotency_key, request_id
            ),
        )
        return self._parse_environment_revision(payload)

    async def put_environment_variable(
        self,
        siteid: str,
        key: str,
        *,
        username: str,
        body: dict[str, Any],
        idempotency_key: str,
        request_id: str,
    ) -> EnvironmentRevision:
        """Create or replace one Project environment variable."""
        payload = await self._request(
            "PUT",
            (
                f"/api/v1/projects/{quote(siteid, safe='')}/"
                f"environment-variables/{quote(key, safe='')}"
            ),
            json=body,
            headers=self._environment_write_headers(
                username, idempotency_key, request_id
            ),
        )
        return self._parse_environment_revision(payload)

    async def delete_environment_variable(
        self,
        siteid: str,
        key: str,
        *,
        username: str,
        body: dict[str, Any],
        idempotency_key: str,
        request_id: str,
    ) -> EnvironmentRevision:
        """Delete one Project environment variable."""
        payload = await self._request(
            "DELETE",
            (
                f"/api/v1/projects/{quote(siteid, safe='')}/"
                f"environment-variables/{quote(key, safe='')}"
            ),
            json=body,
            headers=self._environment_write_headers(
                username, idempotency_key, request_id
            ),
        )
        return self._parse_environment_revision(payload)

    @staticmethod
    def _environment_write_headers(
        username: str,
        idempotency_key: str,
        request_id: str,
    ) -> dict[str, str]:
        return {
            "X-Wegent-Username": username,
            "Idempotency-Key": idempotency_key,
            "X-Request-ID": request_id,
        }

    async def _list_platform_sites(
        self,
        *,
        username: str,
        handler: ApplicationTypeHandler,
        query: str | None,
        offset: int,
        limit: int,
    ) -> SiteListResponse:
        cursor: str | None = None
        skipped = 0
        items: list[SiteListItem] = []
        has_more = False
        query_value = query.lower() if query else None
        seen_cursors: set[str] = set()

        while len(items) < limit:
            params: dict[str, Any] = {"username": username, "limit": 100}
            if handler.app_type != "web":
                params["app_type"] = handler.app_type
            if query:
                params["sitename"] = query
            if cursor:
                if cursor in seen_cursors:
                    raise SitesUpstreamUnavailableError(
                        "Sites service returned a repeated project list cursor"
                    )
                seen_cursors.add(cursor)
                params["cursor"] = cursor
            payload = await self._request(
                "GET",
                "/api/v1/projects/search",
                params=params,
                headers={"X-Wegent-Username": username},
            )
            page_items = payload.get("items", []) if isinstance(payload, dict) else []
            if not isinstance(page_items, list):
                raise SitesUpstreamUnavailableError(
                    "Sites service returned an invalid project list"
                )
            for project in page_items:
                if not handler.matches(project):
                    continue
                if query_value and not self._project_matches_query(
                    project, query_value
                ):
                    continue
                if skipped < offset:
                    skipped += 1
                    continue
                if len(items) < limit:
                    items.append(self._parse_project(handler, project, username))
                else:
                    has_more = True
                    break
            cursor = payload.get("next_cursor") if isinstance(payload, dict) else None
            if cursor is not None and not isinstance(cursor, str):
                raise SitesUpstreamUnavailableError(
                    "Sites service returned an invalid project list cursor"
                )
            if has_more or not cursor:
                break
        next_offset = offset + len(items) if has_more or cursor else None

        return SiteListResponse(
            items=items,
            total=offset + len(items) + (1 if has_more or cursor else 0),
            offset=offset,
            limit=limit,
            next_cursor=str(next_offset) if next_offset is not None else None,
        )

    @staticmethod
    def _project_matches_query(payload: Any, query: str) -> bool:
        if not isinstance(payload, dict):
            return False
        title = payload.get("title")
        return isinstance(title, str) and query in title.lower()

    @staticmethod
    def _parse_project(
        handler: ApplicationTypeHandler,
        payload: Any,
        username: str,
    ) -> SiteListItem:
        try:
            return handler.parse(payload, username=username)
        except InvalidApplicationProjectError as exc:
            raise SitesUpstreamUnavailableError(
                f"Sites service returned an invalid {handler.app_type} project"
            ) from exc

    @staticmethod
    def _parse_site_project(payload: Any, *, username: str) -> SiteResponse:
        try:
            return SITE_APPLICATION_HANDLER.parse(payload, username=username)
        except InvalidApplicationProjectError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid site"
            ) from exc

    @staticmethod
    def _parse_environment_snapshot(payload: Any) -> EnvironmentSnapshot:
        try:
            return EnvironmentSnapshot.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid environment snapshot"
            ) from exc

    @staticmethod
    def _parse_access_policy(payload: Any) -> SiteAccessPolicy:
        try:
            return SiteAccessPolicy.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid access policy"
            ) from exc

    @staticmethod
    def _parse_environment_revision(payload: Any) -> EnvironmentRevision:
        try:
            return EnvironmentRevision.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid environment revision"
            ) from exc


sites_service = SitesService()
