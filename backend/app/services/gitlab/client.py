# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared project-scoped GitHub/GitLab HTTP client.

The Issue provider (external_provider) and the GitLab MR integration both call
provider APIs with the encrypted project-scoped token stored in
``CloudProject.metadata_json.provider_config``. Keeping the token resolution and
request plumbing here avoids duplicating it across the two consumers.
"""

import time
from typing import Any

import httpx
from fastapi import HTTPException, status

from app.core.provider_credentials import decrypt_provider_token
from app.models.cloud_project import CloudProject

# Transient provider failures worth retrying (idempotent GETs only): connection
# resets, timeouts, and 5xx server errors. POST/PUT/DELETE are never retried so
# a timed-out write cannot be applied twice.
_TRANSIENT_STATUS_CODES = {502, 503, 504}
_PROVIDER_MAX_RETRIES = 3
_PROVIDER_RETRY_DELAYS = (0.3, 1.0, 3.0)


def resolve_provider_config(project: CloudProject) -> tuple[dict[str, object], str]:
    """Return ``(provider_config, decrypted_token)`` for a cloud project.

    Raises HTTP 409 when the provider credential is missing or cannot be
    decrypted for the project's provider kind.
    """
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    config = metadata.get("provider_config")
    config = config if isinstance(config, dict) else {}
    try:
        token = decrypt_provider_token(project.task_provider, config)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if not token:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Provider credential is not configured"
        )
    return config, token


def resolve_repository(project: CloudProject) -> str:
    """Return the normalized repository path for a cloud project."""
    config, _ = resolve_provider_config(project)
    repository = str(config.get("repository") or "").strip().strip("/")
    if not repository:
        raise HTTPException(status.HTTP_409_CONFLICT, "Provider repository is required")
    return repository


def _project_request(
    project: CloudProject,
    method: str,
    path: str,
    *,
    json: object | None,
    params: dict[str, object] | None,
    files: dict[str, object] | None,
) -> httpx.Response:
    config, token = resolve_provider_config(project)
    domain = str(
        config.get("domain")
        or ("github.com" if project.task_provider == "github" else "gitlab.com")
    )
    api_base = str(
        config.get("api_base")
        or (
            "https://api.github.com"
            if project.task_provider == "github"
            else f"https://{domain}/api/v4"
        )
    ).rstrip("/")
    headers = (
        {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        }
        if project.task_provider == "github"
        else {"PRIVATE-TOKEN": token}
    )
    url = f"{api_base}{path}"
    for attempt in range(_PROVIDER_MAX_RETRIES):
        try:
            response = httpx.request(
                method,
                url,
                headers=headers,
                json=json,
                params=params,
                files=files,
                timeout=30,
            )
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            if method.upper() == "GET" and attempt < _PROVIDER_MAX_RETRIES - 1:
                time.sleep(_PROVIDER_RETRY_DELAYS[attempt])
                continue
            raise
        if (
            method.upper() == "GET"
            and response.status_code in _TRANSIENT_STATUS_CODES
            and attempt < _PROVIDER_MAX_RETRIES - 1
        ):
            time.sleep(_PROVIDER_RETRY_DELAYS[attempt])
            continue
        return response
    raise httpx.ConnectError("provider request retries exhausted")


def _raise_provider_error(
    response: httpx.Response, exc: httpx.HTTPStatusError, not_found_ok: bool
) -> None:
    if response.status_code == status.HTTP_404_NOT_FOUND:
        if not_found_ok:
            return
        raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found") from exc
    raise HTTPException(
        status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
    ) from exc


def request_project_api(
    project: CloudProject,
    method: str,
    path: str,
    *,
    json: object | None = None,
    params: dict[str, object] | None = None,
    files: dict[str, object] | None = None,
    not_found_ok: bool = False,
) -> Any:
    """Call the provider REST API for a project with its scoped token.

    ``not_found_ok`` turns a 404 into ``None`` instead of an HTTP 404 error, for
    lookups whose absence is an ordinary outcome (no pipeline, no jobs).
    """
    try:
        response = _project_request(
            project, method, path, json=json, params=params, files=files
        )
        response.raise_for_status()
        return response.json() if response.content else {}
    except httpx.HTTPStatusError as exc:
        _raise_provider_error(exc.response, exc, not_found_ok)
        return None
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
        ) from exc


def request_project_api_text(
    project: CloudProject,
    method: str,
    path: str,
    *,
    params: dict[str, object] | None = None,
    not_found_ok: bool = False,
) -> str | None:
    """Like :func:`request_project_api` but returns the raw response body text.

    Used for endpoints such as GitLab job traces that answer with plain text.
    """
    try:
        response = _project_request(
            project, method, path, json=None, params=params, files=None
        )
        response.raise_for_status()
        return response.text
    except httpx.HTTPStatusError as exc:
        _raise_provider_error(exc.response, exc, not_found_ok)
        return None
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
        ) from exc


class ProjectScopedGitlabClient:
    """GitLab API access scoped to one cloud project's provider token."""

    def __init__(self, project: CloudProject) -> None:
        self._project = project

    @property
    def repository(self) -> str:
        return resolve_repository(self._project)

    @property
    def domain(self) -> str:
        config, _ = resolve_provider_config(self._project)
        return str(config.get("domain") or "gitlab.com")

    @property
    def api_base(self) -> str:
        config, _ = resolve_provider_config(self._project)
        return str(config.get("api_base") or f"https://{self.domain}/api/v4").rstrip(
            "/"
        )

    @property
    def token(self) -> str:
        _, token = resolve_provider_config(self._project)
        return token

    def request(
        self,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, object] | None = None,
        files: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> Any:
        return request_project_api(
            self._project,
            method,
            path,
            json=json,
            params=params,
            files=files,
            not_found_ok=not_found_ok,
        )

    def request_all(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, object] | None = None,
        not_found_ok: bool = False,
        page_size: int = 100,
    ) -> list[Any]:
        """Page through a list-returning GitLab endpoint until exhausted.

        GitLab caps ``per_page`` at 100, so a single request truncates lists
        longer than that. Returns the concatenated pages; a non-list response
        (e.g. 404 with ``not_found_ok``) yields the pages collected so far.
        """
        results: list[Any] = []
        page = 1
        while True:
            batch = self.request(
                method,
                path,
                params={**(params or {}), "per_page": page_size, "page": page},
                not_found_ok=not_found_ok,
            )
            if not isinstance(batch, list):
                return results
            results.extend(batch)
            if len(batch) < page_size:
                return results
            page += 1

    def text(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> str | None:
        return request_project_api_text(
            self._project,
            method,
            path,
            params=params,
            not_found_ok=not_found_ok,
        )
