# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk OAuth service."""
import base64
import hashlib
import hmac
import logging
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from app.core.cache import cache_manager
from dingtalk.config import dingtalk_config

logger = logging.getLogger(__name__)


@dataclass
class DingTalkUserInfo:
    """DingTalk user info response."""

    user_id: str
    union_id: str
    name: str
    avatar: str = ""


class DingTalkService:
    """DingTalk OAuth service implementation."""

    DINGTALK_API_BASE = "https://api.dingtalk.com"
    ACCESS_TOKEN_CACHE_KEY = "dingtalk:access_token"
    ACCESS_TOKEN_TTL = 6000  # Refresh before 7200s expiry

    def __init__(self):
        self.config = dingtalk_config

    async def get_access_token(self) -> str:
        """
        Get DingTalk app access token with Redis caching.
        API: POST /v1.0/oauth2/accessToken
        """
        # Try cache first
        cached_token = await cache_manager.get(self.ACCESS_TOKEN_CACHE_KEY)
        if cached_token:
            logger.debug("[DingTalk] Using cached access token")
            return cached_token

        # Fetch new token
        logger.info("[DingTalk] Fetching new access token")
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.DINGTALK_API_BASE}/v1.0/oauth2/accessToken",
                json={
                    "appKey": self.config.client_id,
                    "appSecret": self.config.client_secret,
                },
            )
            response.raise_for_status()
            data = response.json()

        access_token = data.get("accessToken")
        if not access_token:
            raise ValueError(f"Failed to get access token: {data}")

        # Cache the token
        await cache_manager.set(
            self.ACCESS_TOKEN_CACHE_KEY, access_token, expire=self.ACCESS_TOKEN_TTL
        )

        return access_token

    async def get_user_info(self, auth_code: str) -> DingTalkUserInfo:
        """
        Get user info by auth code.

        Step 1: Exchange auth_code for user access token
        API: POST /v1.0/oauth2/userAccessToken

        Step 2: Get user info with user access token
        API: GET /v1.0/contact/users/me
        """
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Step 1: Get user access token
            logger.info("[DingTalk] Exchanging auth code for user access token")
            token_response = await client.post(
                f"{self.DINGTALK_API_BASE}/v1.0/oauth2/userAccessToken",
                json={
                    "clientId": self.config.client_id,
                    "clientSecret": self.config.client_secret,
                    "code": auth_code,
                    "grantType": "authorization_code",
                },
            )

            # Log detailed error for debugging
            if token_response.status_code != 200:
                error_body = token_response.text
                logger.error(
                    f"[DingTalk] userAccessToken failed: "
                    f"status={token_response.status_code}, body={error_body}"
                )
            token_response.raise_for_status()
            token_data = token_response.json()

            user_access_token = token_data.get("accessToken")
            if not user_access_token:
                raise ValueError(f"Failed to get user access token: {token_data}")

            # Step 2: Get user info
            logger.info("[DingTalk] Fetching user info")
            user_response = await client.get(
                f"{self.DINGTALK_API_BASE}/v1.0/contact/users/me",
                headers={"x-acs-dingtalk-access-token": user_access_token},
            )
            user_response.raise_for_status()
            user_data = user_response.json()

        return DingTalkUserInfo(
            user_id=user_data.get("userId", ""),
            union_id=user_data.get("unionId", ""),
            name=user_data.get("nick", ""),
            avatar=user_data.get("avatarUrl", ""),
        )

    def verify_signature(self, timestamp: str, signature: str) -> bool:
        """
        Verify DingTalk request signature.
        signature = base64(hmac-sha256(timestamp, client_secret))
        """
        if not timestamp or not signature:
            return False

        # Check timestamp freshness (5 minutes)
        try:
            ts = int(timestamp)
            now = int(time.time() * 1000)
            if abs(now - ts) > self.config.code_expire_seconds * 1000:
                logger.warning(
                    f"[DingTalk] Timestamp expired: ts={ts}, now={now}, "
                    f"diff={(now - ts) / 1000}s"
                )
                return False
        except ValueError:
            logger.warning(f"[DingTalk] Invalid timestamp format: {timestamp}")
            return False

        # Verify signature
        expected = base64.b64encode(
            hmac.new(
                self.config.client_secret.encode(),
                timestamp.encode(),
                hashlib.sha256,
            ).digest()
        ).decode()

        if not hmac.compare_digest(signature, expected):
            logger.warning("[DingTalk] Signature verification failed")
            return False

        return True


# Global service instance
dingtalk_service = DingTalkService()
