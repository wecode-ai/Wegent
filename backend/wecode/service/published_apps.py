# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Client for the internal published apps service."""

from typing import Any

import httpx

from wecode.config.published_apps_config import PublishedAppsSettings


class PublishedAppsNotConfiguredError(RuntimeError):
    """Raised when the published apps service token is not configured."""


class PublishedAppsService:
    """Proxy client for user published apps."""

    def _build_authorization(self, settings: PublishedAppsSettings) -> str:
        if not settings.api_token:
            raise PublishedAppsNotConfiguredError(
                "Published apps service authorization is not configured"
            )
        return f"Bearer {settings.api_token}"

    def _build_headers(self, settings: PublishedAppsSettings) -> dict[str, str]:
        return {
            "accept": "application/json",
            "Authorization": self._build_authorization(settings),
            "Content-Type": "application/json",
        }

    async def list_all_apps(self) -> dict[str, Any]:
        """List all published apps across all users (admin only)."""
        config = PublishedAppsSettings()
        url = f"{config.base_url}/app/list"
        headers = self._build_headers(config)

        async with httpx.AsyncClient(
            timeout=config.PUBLISHED_APPS_TIMEOUT_SECONDS
        ) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return response.json()

    async def list_apps(self, username: str) -> dict[str, Any]:
        """List apps published by a user."""
        config = PublishedAppsSettings()
        url = f"{config.base_url}/app/list"
        headers = self._build_headers(config)

        async with httpx.AsyncClient(
            timeout=config.PUBLISHED_APPS_TIMEOUT_SECONDS
        ) as client:
            response = await client.get(
                url,
                params={"username": username},
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    async def delete_app(self, username: str, app_name: str) -> dict[str, Any]:
        """Delete a user published app."""
        config = PublishedAppsSettings()
        url = f"{config.base_url}/app/delete"
        headers = self._build_headers(config)

        async with httpx.AsyncClient(
            timeout=config.PUBLISHED_APPS_TIMEOUT_SECONDS
        ) as client:
            response = await client.request(
                "DELETE",
                url,
                json={"username": username, "app_name": app_name},
                headers=headers,
            )
            response.raise_for_status()
            return response.json()


published_apps_service = PublishedAppsService()
