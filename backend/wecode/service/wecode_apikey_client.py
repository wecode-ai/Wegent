# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared client for WeCode API Key management service.

Provides both sync and async methods to get or create API keys
for users via the external copilot.weibo.com service.
"""

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# External API endpoints
APIKEY_GET_URL = "https://copilot.weibo.com/v1/wecode_apikey/get_apikeys"
APIKEY_CREATE_URL = "https://copilot.weibo.com/v1/wecode_apikey/create_apikey"
AUTH_SIGN = "wecode_apikey_server_auth_91854e590f3c647c6237745794e4"

# Placeholder used in Model CRD api_key fields
WECODE_USER_API_KEY_PLACEHOLDER = "${WECODE_USER_API_KEY}"


def _extract_apikey_from_get_response(result: Any) -> str | None:
    """Extract API key from get_apikeys response."""
    if not result or not isinstance(result, dict):
        return None
    data = result.get("data", {})
    if not isinstance(data, dict):
        return None
    apikeys = data.get("apikeys", [])
    if not isinstance(apikeys, list) or len(apikeys) == 0:
        return None
    apikey = apikeys[0]
    if apikey and isinstance(apikey, str) and apikey.strip():
        return apikey.strip()
    return None


def _extract_apikey_from_create_response(result: Any) -> str | None:
    """Extract API key from create_apikey response."""
    if not result or not isinstance(result, dict):
        return None
    data = result.get("data", {})
    if not isinstance(data, dict):
        return None
    apikey = data.get("apikey")
    if apikey and isinstance(apikey, str) and apikey.strip():
        return apikey.strip()
    return None


def get_or_create_apikey_sync(username: str) -> str:
    """
    Synchronously get or create an API key for the given username.

    Tries to retrieve an existing key first; if none exists, creates a new one.

    Args:
        username: The username to get/create API key for

    Returns:
        The API key string

    Raises:
        Exception: If both get and create operations fail
    """
    payload = {"username": username, "sign": AUTH_SIGN}

    with httpx.Client() as client:
        try:
            logger.info(f"Attempting to get API key for user: {username}")
            response = client.post(
                APIKEY_GET_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            apikey = _extract_apikey_from_get_response(response.json())
            if apikey:
                logger.info(
                    f"Successfully retrieved existing API key for user: {username}"
                )
                return apikey

            logger.info(
                f"No existing API key found, creating new one for user: {username}"
            )
            response = client.post(
                APIKEY_CREATE_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            apikey = _extract_apikey_from_create_response(response.json())
            if apikey:
                logger.info(f"Successfully created new API key for user: {username}")
                return apikey

            raise Exception(
                f"Failed to get valid API key from create response for user: {username}"
            )

        except httpx.HTTPStatusError as e:
            logger.error(
                f"HTTP error when getting/creating API key for {username}: "
                f"{e.response.status_code} - {e.response.text}"
            )
            raise Exception(f"HTTP error: {e.response.status_code}")
        except Exception as e:
            logger.error(f"Error getting/creating API key for {username}: {str(e)}")
            raise


async def get_or_create_apikey_async(username: str) -> str:
    """
    Asynchronously get or create an API key for the given username.

    Tries to retrieve an existing key first; if none exists, creates a new one.

    Args:
        username: The username to get/create API key for

    Returns:
        The API key string

    Raises:
        Exception: If both get and create operations fail
    """
    payload = {"username": username, "sign": AUTH_SIGN}

    async with httpx.AsyncClient() as client:
        try:
            logger.info(f"Attempting to get API key for user: {username}")
            response = await client.post(
                APIKEY_GET_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            apikey = _extract_apikey_from_get_response(response.json())
            if apikey:
                logger.info(
                    f"Successfully retrieved existing API key for user: {username}"
                )
                return apikey

            logger.info(
                f"No existing API key found, creating new one for user: {username}"
            )
            response = await client.post(
                APIKEY_CREATE_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            apikey = _extract_apikey_from_create_response(response.json())
            if apikey:
                logger.info(f"Successfully created new API key for user: {username}")
                return apikey

            raise Exception(
                f"Failed to get valid API key from create response for user: {username}"
            )

        except httpx.HTTPStatusError as e:
            logger.error(
                f"HTTP error when getting/creating API key for {username}: "
                f"{e.response.status_code} - {e.response.text}"
            )
            raise Exception(f"HTTP error: {e.response.status_code}")
        except Exception as e:
            logger.error(f"Error getting/creating API key for {username}: {str(e)}")
            raise


def replace_api_key_in_config(config: Any, real_apikey: str) -> Any:
    """
    Recursively replace ${WECODE_USER_API_KEY} placeholder in config with real API key.

    Args:
        config: The configuration object (dict, list, or primitive)
        real_apikey: The real API key to replace with

    Returns:
        The config with placeholders replaced
    """
    if isinstance(config, dict):
        return {
            key: replace_api_key_in_config(value, real_apikey)
            for key, value in config.items()
        }
    elif isinstance(config, list):
        return [replace_api_key_in_config(item, real_apikey) for item in config]
    elif isinstance(config, str):
        return config.replace(WECODE_USER_API_KEY_PLACEHOLDER, real_apikey)
    else:
        return config
