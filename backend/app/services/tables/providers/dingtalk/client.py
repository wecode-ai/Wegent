# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Notable API client and token manager.

Provides access to DingTalk Notable API with automatic token refresh.
"""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class DingtalkTokenManager:
    """Manages DingTalk access token with automatic refresh.

    Token is cached for 1 hour and refreshed 5 minutes before expiration.
    Thread-safe implementation using asyncio locks.
    """

    _cache: Optional[Dict[str, Any]] = None
    _lock = asyncio.Lock()

    # Token cache duration: 1 hour
    TOKEN_CACHE_DURATION = 60 * 60
    # Refresh buffer: 5 minutes before expiration
    TOKEN_REFRESH_BUFFER = 5 * 60

    def __init__(self, app_key: str, app_secret: str):
        """Initialize token manager.

        Args:
            app_key: DingTalk app key
            app_secret: DingTalk app secret
        """
        self.app_key = app_key
        self.app_secret = app_secret
        self.base_url = "https://api.dingtalk.com"

    def _is_token_valid(self) -> bool:
        """Check if cached token is still valid."""
        if not self._cache:
            return False

        current_time = time.time()
        expires_at = self._cache.get("expires_at", 0)

        # Token is valid if it hasn't expired and has more than 5 minutes left
        return expires_at > current_time + self.TOKEN_REFRESH_BUFFER

    async def _fetch_token(self) -> str:
        """Fetch new access token from DingTalk API.

        Returns:
            Access token string

        Raises:
            Exception: If token fetch fails
        """
        url = f"{self.base_url}/v1.0/oauth2/accessToken"
        payload = {
            "appKey": self.app_key,
            "appSecret": self.app_secret,
        }

        logger.info("[DingtalkTokenManager] Fetching new access token")
        logger.debug(f"[DingtalkTokenManager] Request URL: {url}")
        logger.debug(f"[DingtalkTokenManager] App Key: {self.app_key}")

        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                response = await client.post(
                    url, json=payload, headers={"Content-Type": "application/json"}
                )
                response.raise_for_status()
                data = response.json()

                logger.debug(
                    f"[DingtalkTokenManager] Response status: {response.status_code}"
                )
                logger.debug(f"[DingtalkTokenManager] Response keys: {data.keys()}")

                # Check for error response
                if "code" in data:
                    error_msg = data.get("message", "Unknown error")
                    error_code = data.get("code")
                    logger.error(
                        f"[DingtalkTokenManager] Token fetch failed: "
                        f"{error_msg} (code: {error_code})"
                    )
                    raise Exception(
                        f"Failed to get DingTalk access token: "
                        f"{error_msg} (code: {error_code})"
                    )

                # Extract access token
                access_token = data.get("accessToken")
                if not access_token:
                    logger.error(
                        f"[DingtalkTokenManager] Missing accessToken in response: {data}"
                    )
                    raise Exception("Missing accessToken in response")

                logger.info("[DingtalkTokenManager] Successfully fetched access token")
                return access_token

            except httpx.HTTPStatusError as e:
                logger.error(
                    f"[DingtalkTokenManager] HTTP error: {e.response.status_code} - "
                    f"{e.response.text}"
                )
                raise Exception(f"HTTP error fetching token: {e.response.status_code}")
            except httpx.RequestError as e:
                logger.error(f"[DingtalkTokenManager] Request error: {e}")
                raise Exception(f"Request error fetching token: {e}")

    async def get_token(self) -> str:
        """Get access token with caching.

        Returns cached token if valid, otherwise fetches new token.
        Thread-safe using asyncio lock.

        Returns:
            Access token string
        """
        # Fast path: return cached token if valid
        if self._is_token_valid():
            return self._cache["access_token"]

        # Slow path: fetch new token with lock
        async with self._lock:
            # Double-check after acquiring lock
            if self._is_token_valid():
                return self._cache["access_token"]

            # Fetch new token
            access_token = await self._fetch_token()

            # Update cache
            current_time = time.time()
            self._cache = {
                "access_token": access_token,
                "expires_at": current_time + self.TOKEN_CACHE_DURATION,
            }

            logger.info(
                f"[DingtalkTokenManager] Token cached, expires in "
                f"{self.TOKEN_CACHE_DURATION} seconds"
            )

            return access_token

    def clear_cache(self) -> None:
        """Clear token cache (force refresh on next request)."""
        self._cache = None
        logger.info("[DingtalkTokenManager] Token cache cleared")


class DingtalkNotableClient:
    """Client for DingTalk Notable (multi-dimensional table) API.

    Provides methods to interact with DingTalk tables including:
    - Listing records with pagination
    - Getting all sheets in a base
    """

    def __init__(
        self,
        token_manager: DingtalkTokenManager,
        operator_id: str,
    ):
        """Initialize Notable client.

        Args:
            token_manager: Token manager instance for getting access tokens
            operator_id: Operator user ID
        """
        self.token_manager = token_manager
        self.operator_id = operator_id
        self.base_url = "https://api.dingtalk.com"

    async def list_records(
        self,
        base_id: str,
        sheet_id_or_name: str,
        page_size: Optional[int] = None,
        next_token: Optional[str] = None,
        filter_expr: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List records from a sheet.

        Args:
            base_id: Notable base ID
            sheet_id_or_name: Sheet ID or name
            page_size: Maximum number of records to return (default 20, max 100)
            next_token: Pagination token for next page
            filter_expr: Filter expression (optional)

        Returns:
            Response dict with structure:
            {
                "success": bool,
                "result": {
                    "hasMore": bool,
                    "nextToken": str,
                    "records": [
                        {
                            "id": str,
                            "fields": dict,
                            "createdTime": str,
                            "modifiedTime": str
                        }
                    ]
                },
                "errorCode": str,
                "errorMsg": str
            }
        """
        try:
            access_token = await self.token_manager.get_token()

            url = (
                f"{self.base_url}/v1.0/notable/bases/{base_id}"
                f"/sheets/{sheet_id_or_name}/records"
            )

            # Build query parameters
            params: Dict[str, Any] = {
                "operatorId": self.operator_id,
            }
            if page_size is not None:
                params["maxResults"] = min(page_size, 100)
            if next_token:
                params["nextToken"] = next_token

            logger.info(
                f"[DingtalkNotableClient] Listing records: "
                f"base={base_id}, sheet={sheet_id_or_name}"
            )
            logger.debug(f"[DingtalkNotableClient] Params: {params}")

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    url,
                    params=params,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )

                response.raise_for_status()
                data = response.json()

                logger.info(
                    f"[DingtalkNotableClient] Retrieved {len(data.get('records', []))} records"
                )

                return {
                    "success": True,
                    "result": data,
                }

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_code = error_data.get("code", "HTTP_ERROR")
            error_msg = error_data.get("message", str(e))
            http_status = e.response.status_code

            logger.error(
                f"[DingtalkNotableClient] HTTP error listing records: "
                f"{error_code} - {error_msg} (HTTP {http_status})"
            )

            return {
                "success": False,
                "errorCode": error_code,
                "errorMsg": error_msg,
                "httpStatus": http_status,
            }

        except Exception as e:
            logger.error(f"[DingtalkNotableClient] Error listing records: {e}")
            return {
                "success": False,
                "errorCode": "UNKNOWN_ERROR",
                "errorMsg": str(e),
            }

    async def get_all_sheets(self, base_id: str) -> Dict[str, Any]:
        """Get all sheets in the base.

        Args:
            base_id: Notable base ID

        Returns:
            Response dict with structure:
            {
                "success": bool,
                "result": {
                    "value": [
                        {"id": str, "name": str}
                    ]
                },
                "errorCode": str,
                "errorMsg": str
            }
        """
        try:
            access_token = await self.token_manager.get_token()

            url = f"{self.base_url}/v1.0/notable/bases/{base_id}/sheets"

            params = {
                "operatorId": self.operator_id,
            }

            logger.info(f"[DingtalkNotableClient] Getting all sheets: base={base_id}")

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    url,
                    params=params,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )

                response.raise_for_status()
                data = response.json()

                logger.info(
                    f"[DingtalkNotableClient] Retrieved {len(data.get('value', []))} sheets"
                )

                return {
                    "success": True,
                    "result": data,
                }

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_code = error_data.get("code", "HTTP_ERROR")
            error_msg = error_data.get("message", str(e))

            logger.error(
                f"[DingtalkNotableClient] HTTP error getting sheets: "
                f"{error_code} - {error_msg}"
            )

            return {
                "success": False,
                "errorCode": error_code,
                "errorMsg": error_msg,
            }

        except Exception as e:
            logger.error(f"[DingtalkNotableClient] Error getting sheets: {e}")
            return {
                "success": False,
                "errorCode": "UNKNOWN_ERROR",
                "errorMsg": str(e),
            }
