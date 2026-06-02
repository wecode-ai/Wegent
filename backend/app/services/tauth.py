# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
TAuth2 authentication service for API authorization.

This module provides TAuth2 authentication header generation for internal API calls.
TAuth2 uses HMAC-SHA1 signature for request authentication.

Token Management:
- Tokens are retrieved from Redis hash 'token_v2' with APPKEY_SOURCE as key
- Local cache with 3-hour validity period to reduce Redis load
- Automatic refresh when cache expires

Authorization Header Format:
    TAuth2 token="<url_encoded_token>",param="<url_encoded_params>",sign="<url_encoded_signature>"
"""

import base64
import hmac
import json
import time
import urllib.parse
from hashlib import sha1
from typing import Optional

import redis

from shared.logger import setup_logger

logger = setup_logger(__name__)

# ========== TAuth Configuration ==========

# Redis configuration for TAuth token retrieval
TAUTH_REDIS_HOST = "rm7455.eos.grid.sina.com.cn"
TAUTH_REDIS_PORT = 7455

# AppKey source for TAuth token retrieval from Redis
APPKEY_SOURCE = "3061639762"  # Multimedia unified storage

# Token cache duration in milliseconds (3 hours)
_TOKEN_VALID_DURATION_MS = 3 * 60 * 60 * 1000

# ========== End Configuration ==========

# Redis client for TAuth token retrieval
_tauth_redis: Optional[redis.Redis] = None

# Local token cache
_cached_token: Optional[dict] = None


def _get_tauth_redis() -> redis.Redis:
    """Get or create TAuth Redis client (lazy initialization)."""
    global _tauth_redis
    if _tauth_redis is None:
        _tauth_redis = redis.Redis(
            host=TAUTH_REDIS_HOST,
            port=TAUTH_REDIS_PORT,
            decode_responses=True,
        )
    return _tauth_redis


def _is_token_valid(token_obj: Optional[dict]) -> bool:
    """Check if token is within validity period (3 hours)."""
    if token_obj is None or "timestamp" not in token_obj:
        return False
    now = int(time.time() * 1000)
    return now - token_obj["timestamp"] < _TOKEN_VALID_DURATION_MS


def _get_token() -> Optional[dict]:
    """
    Get token object, preferring local cache.

    Fetches from Redis and updates cache when cache is invalid.

    Returns:
        Token object with tauth_token and tauth_token_secret, or None if failed.
    """
    global _cached_token

    # Check if cache is valid
    if _is_token_valid(_cached_token):
        return _cached_token

    # Cache invalid, fetch from Redis
    try:
        redis_cli = _get_tauth_redis()
        token_res = redis_cli.hget("token_v2", APPKEY_SOURCE)
        if token_res is None or token_res == "":
            logger.warning(f"No TAuth token found for APPKEY_SOURCE: {APPKEY_SOURCE}")
            return None
        _cached_token = json.loads(token_res)
        return _cached_token
    except Exception as e:
        logger.error(f"Failed to get TAuth token from Redis: {e}")
        return None


def tauth_signature_generate(
    base_string: str, tauth_token_secret: str
) -> Optional[str]:
    """
    Generate TAuth signature using HMAC-SHA1.

    Args:
        base_string: The parameter string to sign (e.g., "uid=123")
        tauth_token_secret: The signing key

    Returns:
        Base64 encoded signature, or None if inputs are invalid.
    """
    if (
        tauth_token_secret is None
        or tauth_token_secret == ""
        or base_string is None
        or base_string == ""
    ):
        return None

    key_bytes = str.encode(tauth_token_secret, encoding="utf-8")
    base_string_bytes = str.encode(base_string, encoding="utf-8")
    mac = hmac.new(key_bytes, digestmod=sha1)
    mac.update(base_string_bytes)
    return base64.b64encode(mac.digest()).decode("utf-8")


def get_parameter_signature(params_map: dict, tauth_token_secret: str) -> str:
    """
    Generate parameter signature string for Authorization header.

    Args:
        params_map: Parameter key-value pairs
        tauth_token_secret: Signing key

    Returns:
        Signature string: param="...",sign="..."
    """
    params_str = "&".join(f"{key}={params_map[key]}" for key in params_map)
    sign = tauth_signature_generate(params_str, tauth_token_secret)
    return 'param="{}",sign="{}"'.format(
        urllib.parse.quote(params_str, encoding="utf-8"),
        urllib.parse.quote(sign, encoding="utf-8"),
    )


def generate_param_map_by_uid(uid: Optional[int]) -> dict:
    """
    Generate parameter map from UID.

    Args:
        uid: User ID

    Returns:
        Parameter map with uid key.

    Raises:
        ValueError: If uid is None, negative, or non-numeric.
    """
    if uid is None:
        raise ValueError("UID is required for TAuth2 authentication")

    # Check if uid is numeric and valid
    try:
        uid_int = int(uid)
        if uid_int < 0:
            raise ValueError(f"Invalid UID: {uid} (negative value)")
    except (ValueError, TypeError) as e:
        raise ValueError(f"Invalid UID: {uid} (non-numeric)") from e

    return {"uid": str(uid_int)}


def get_authorization_header(params_map: Optional[dict]) -> Optional[str]:
    """
    Generate TAuth2 Authorization header value.

    Args:
        params_map: Optional parameter map for signature

    Returns:
        Authorization header value, or None if token unavailable.
    """
    token_obj = _get_token()
    if (
        token_obj is None
        or token_obj.get("tauth_token") is None
        or token_obj.get("tauth_token_secret") is None
    ):
        return None

    token = token_obj["tauth_token"]
    tauth_token_secret = token_obj["tauth_token_secret"]

    # Build auth header
    auth = 'TAuth2 token="{}",'.format(urllib.parse.quote(token, encoding="utf-8"))

    if params_map is None or len(params_map) == 0:
        return auth

    auth = auth + get_parameter_signature(params_map, tauth_token_secret)
    return auth


def add_authorization_to_header(headers: dict, uid: int) -> bool:
    """
    Add TAuth2 Authorization header to request headers.

    Args:
        headers: Request headers dict to modify
        uid: User ID for parameter signature

    Returns:
        True if authorization added successfully, False otherwise.
    """
    params_map = generate_param_map_by_uid(uid)
    auth_header = get_authorization_header(params_map)
    if auth_header is None:
        logger.warning(f"Failed to generate TAuth2 header for uid={uid}")
        return False

    headers["Authorization"] = auth_header
    return True


def auth_headers(uid: int, headers: Optional[dict] = None) -> dict:
    """
    Convenience function to get headers with TAuth2 authorization.

    Args:
        uid: User ID for parameter signature
        headers: Existing headers to extend (optional)

    Returns:
        Headers dict with Authorization added.
    """
    if headers is None:
        headers = {}
    add_authorization_to_header(headers, uid)
    return headers
