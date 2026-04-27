# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Client for the internal published apps service."""

import os
from typing import Any

import httpx

DEFAULT_PUBLISHED_APPS_API_URL = "http://10.37.255.188:3001"
PUBLISHED_APPS_TIMEOUT_SECONDS = 10.0


class PublishedAppsNotConfiguredError(RuntimeError):
    """Raised when the published apps service token is not configured."""


class PublishedAppsService:
    """Proxy client for user published apps."""

    def _get_base_url(self) -> str:
        return (
            os.getenv("RUNTIME_PUBLISHED_APPS_API_URL")
            or os.getenv("PUBLISHED_APPS_API_URL")
            or DEFAULT_PUBLISHED_APPS_API_URL
        ).rstrip("/")

    def _get_authorization(self) -> str:
        token = os.getenv("RUNTIME_PUBLISHED_APPS_API_TOKEN") or os.getenv(
            "PUBLISHED_APPS_API_TOKEN"
        )
        if not token:
            raise PublishedAppsNotConfiguredError(
                "Published apps service authorization is not configured"
            )
        return f"Bearer {token}"

    async def list_apps(self, username: str) -> dict[str, Any]:
        """List apps published by a user."""
        url = f"{self._get_base_url()}/app/list"
        headers = {
            "accept": "application/json",
            "Authorization": self._get_authorization(),
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=PUBLISHED_APPS_TIMEOUT_SECONDS) as client:
            response = await client.get(
                url,
                params={"username": username},
                headers=headers,
            )
            response.raise_for_status()
            return response.json()


published_apps_service = PublishedAppsService()
