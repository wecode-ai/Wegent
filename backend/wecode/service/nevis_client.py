# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Nevis Sandbox API client.

Provides methods to manage cloud device lifecycle through Nevis Sandbox API:
- Create sandbox VMs
- Query sandbox status
- Restart sandbox VMs
- Delete sandbox VMs
"""

import logging
from typing import Any, Dict, Optional

import httpx

from wecode.config.nevis_config import nevis_settings

logger = logging.getLogger(__name__)

# HTTP client timeout settings
NEVIS_TIMEOUT = 30.0  # seconds


class NevisClientError(Exception):
    """Base exception for Nevis client errors."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class NevisClient:
    """Nevis Sandbox API client.

    Manages cloud device lifecycle through Nevis Sandbox API.
    """

    def __init__(self):
        """Initialize Nevis client with settings from environment."""
        self.base_url = nevis_settings.NEVIS_BASE_URL.rstrip("/")
        self.manager_id = nevis_settings.NEVIS_MANAGER_ID
        self.image_id = nevis_settings.NEVIS_IMAGE_ID
        self.signature = nevis_settings.NEVIS_SIGNATURE

    def _get_headers(self) -> Dict[str, str]:
        """Get request headers with authentication."""
        return {
            "X-Signature": self.signature,
            "Content-Type": "application/json",
        }

    def _get_sandboxes_url(self, sandbox_id: Optional[str] = None) -> str:
        """Build sandbox API URL.

        Args:
            sandbox_id: Optional sandbox ID for specific sandbox operations

        Returns:
            Full API URL
        """
        base = f"{self.base_url}/apis/sandboxes/v1/managers/{self.manager_id}/sandboxes"
        if sandbox_id:
            return f"{base}/{sandbox_id}"
        return base

    def is_configured(self) -> bool:
        """Check if Nevis client is properly configured.

        Returns:
            True if all required settings are present
        """
        return bool(
            self.base_url and self.manager_id and self.image_id and self.signature
        )

    async def create_sandbox(
        self,
        user_data: str,
        envs: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Create a new sandbox VM.

        Args:
            user_data: Base64 encoded startup script for cloud-init
            envs: Optional environment variables for the VM

        Returns:
            Sandbox creation response containing sandbox ID and status

        Raises:
            NevisClientError: If API call fails
        """
        if not self.is_configured():
            raise NevisClientError("Nevis client is not properly configured")

        url = self._get_sandboxes_url()
        payload = {
            "managerId": self.manager_id,
            "type": "VM",
            "configs": {
                "imageId": self.image_id,
                "envs": envs or {},
                "extras": {
                    "user_data": user_data,
                },
            },
        }

        logger.info(f"Creating Nevis sandbox with image_id={self.image_id}")

        async with httpx.AsyncClient(timeout=NEVIS_TIMEOUT) as client:
            try:
                response = await client.post(
                    url,
                    headers=self._get_headers(),
                    json=payload,
                )
                response.raise_for_status()
                result = response.json()
                logger.info(f"Nevis sandbox created: {result.get('id', 'unknown')}")
                return result
            except httpx.HTTPStatusError as e:
                logger.error(
                    f"Nevis API error: status={e.response.status_code}, "
                    f"body={e.response.text}"
                )
                raise NevisClientError(
                    f"Failed to create sandbox: {e.response.text}",
                    status_code=e.response.status_code,
                )
            except httpx.RequestError as e:
                logger.error(f"Nevis API request error: {str(e)}")
                raise NevisClientError(f"Failed to connect to Nevis API: {str(e)}")

    async def get_sandbox(self, sandbox_id: str) -> Dict[str, Any]:
        """Get sandbox status and information.

        Args:
            sandbox_id: The sandbox ID to query

        Returns:
            Sandbox information including status, IP address, etc.

        Raises:
            NevisClientError: If API call fails
        """
        if not self.is_configured():
            raise NevisClientError("Nevis client is not properly configured")

        url = self._get_sandboxes_url(sandbox_id)
        logger.debug(f"Querying Nevis sandbox: {sandbox_id}")

        async with httpx.AsyncClient(timeout=NEVIS_TIMEOUT) as client:
            try:
                response = await client.get(url, headers=self._get_headers())
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    logger.warning(f"Nevis sandbox not found: {sandbox_id}")
                    raise NevisClientError(
                        f"Sandbox not found: {sandbox_id}",
                        status_code=404,
                    )
                logger.error(
                    f"Nevis API error: status={e.response.status_code}, "
                    f"body={e.response.text}"
                )
                raise NevisClientError(
                    f"Failed to get sandbox: {e.response.text}",
                    status_code=e.response.status_code,
                )
            except httpx.RequestError as e:
                logger.error(f"Nevis API request error: {str(e)}")
                raise NevisClientError(f"Failed to connect to Nevis API: {str(e)}")

    async def restart_sandbox(self, sandbox_id: str) -> Dict[str, Any]:
        """Restart a sandbox VM.

        API: POST /apis/sandboxes/v1/managers/{manager_id}/sandboxes/{sandbox_id}/restart

        Args:
            sandbox_id: The sandbox ID to restart

        Returns:
            Restart operation response from Nevis API

        Raises:
            NevisClientError: If API call fails
        """
        if not self.is_configured():
            raise NevisClientError("Nevis client is not properly configured")

        url = f"{self._get_sandboxes_url(sandbox_id)}/restart"
        payload = {
            "id": sandbox_id,
            "managerId": self.manager_id,
        }

        logger.info(f"Restarting Nevis sandbox: {sandbox_id}")

        async with httpx.AsyncClient(timeout=NEVIS_TIMEOUT) as client:
            try:
                response = await client.post(
                    url,
                    headers=self._get_headers(),
                    json=payload,
                )
                response.raise_for_status()
                result = response.json()
                logger.info(f"Nevis sandbox restart initiated: {sandbox_id}")
                return result
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    logger.warning(f"Nevis sandbox not found: {sandbox_id}")
                    raise NevisClientError(
                        f"Sandbox not found: {sandbox_id}",
                        status_code=404,
                    )
                logger.error(
                    f"Nevis API error: status={e.response.status_code}, "
                    f"body={e.response.text}"
                )
                raise NevisClientError(
                    f"Failed to restart sandbox: {e.response.text}",
                    status_code=e.response.status_code,
                )
            except httpx.RequestError as e:
                logger.error(f"Nevis API request error: {str(e)}")
                raise NevisClientError(f"Failed to connect to Nevis API: {str(e)}")

    async def delete_sandbox(self, sandbox_id: str) -> bool:
        """Delete a sandbox VM.

        Args:
            sandbox_id: The sandbox ID to delete

        Returns:
            True if deletion was successful

        Raises:
            NevisClientError: If API call fails
        """
        if not self.is_configured():
            raise NevisClientError("Nevis client is not properly configured")

        url = self._get_sandboxes_url(sandbox_id)
        logger.info(f"Deleting Nevis sandbox: {sandbox_id}")

        async with httpx.AsyncClient(timeout=NEVIS_TIMEOUT) as client:
            try:
                response = await client.delete(url, headers=self._get_headers())
                response.raise_for_status()
                logger.info(f"Nevis sandbox deleted: {sandbox_id}")
                return True
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    # Sandbox already deleted, treat as success
                    logger.warning(
                        f"Nevis sandbox not found during delete: {sandbox_id}"
                    )
                    return True
                logger.error(
                    f"Nevis API error: status={e.response.status_code}, "
                    f"body={e.response.text}"
                )
                raise NevisClientError(
                    f"Failed to delete sandbox: {e.response.text}",
                    status_code=e.response.status_code,
                )
            except httpx.RequestError as e:
                logger.error(f"Nevis API request error: {str(e)}")
                raise NevisClientError(f"Failed to connect to Nevis API: {str(e)}")


# Singleton instance
nevis_client = NevisClient()
