# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk OAuth service."""
import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
from dataclasses import dataclass
from typing import Optional

import httpx

from app.core.cache import cache_manager
from app.core.config import settings
from dingtalk.config import dingtalk_config

logger = logging.getLogger(__name__)


@dataclass
class DingTalkUserInfo:
    """DingTalk user info response."""

    user_id: str
    union_id: str
    name: str


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
                f"{self.DINGTALK_API_BASE}/v1.0/oauth2/{settings.DINGTALK_CORP_ID}/token",
                json={
                    "client_id": self.config.client_id,
                    "client_secret": self.config.client_secret,
                    "grant_type": "client_credentials",
                },
            )
            response.raise_for_status()
            data = response.json()

        access_token = data.get("access_token")
        if not access_token:
            raise ValueError(f"Failed to get access token: {data}")

        # Cache the token
        await cache_manager.set(
            self.ACCESS_TOKEN_CACHE_KEY, access_token, expire=self.ACCESS_TOKEN_TTL
        )

        return access_token

    async def get_user_info(
        self, auth_code: str, access_token: str
    ) -> DingTalkUserInfo:
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
            user_response = await client.post(
                f"https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token={access_token}",
                json={"code": auth_code},
            )

            user_response.raise_for_status()
            user_data = user_response.json().get("result", {})

        return DingTalkUserInfo(
            user_id=user_data.get("userid", ""),
            union_id=user_data.get("unionid", ""),
            name=user_data.get("name", ""),
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

    async def get_employee_email(self, employee_id: str) -> Optional[str]:
        """
        Get employee email by employee ID (工号) from ERP API.

        API: GET http://api.service.erp.sina.com.cn/api2/index.php/b/emp-getOnlyEmail
        """
        if not self.config.erp_api_key:
            logger.warning("[DingTalk] ERP API key not configured")
            return None

        if not employee_id:
            logger.warning("[DingTalk] Employee ID is empty")
            return None

        # Build data and token
        data = {"EMPLOYEE_ID": [employee_id]}
        data_json = json.dumps(data, separators=(",", ":"))
        token = hashlib.md5((data_json + self.config.erp_api_key).encode()).hexdigest()

        # Build request params
        request_param = {"data": data, "token": token}
        json_param = json.dumps(request_param, separators=(",", ":"))
        encoded_param = urllib.parse.quote(json_param)

        url = f"http://api.service.erp.sina.com.cn/api2/index.php/b/emp-getOnlyEmail?json={encoded_param}"

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url)
                response.raise_for_status()
                result = response.json()

            logger.info(
                f"[DingTalk] ERP API response: {response.status_code}, {result}"
            )
            if result.get("code") == "0":
                email_data = result.get("data", {}).get(employee_id, {})
                email = email_data.get("EMAIL")
                if email:
                    logger.info(
                        f"[DingTalk] Got email for employee {employee_id}: {email}"
                    )
                    return email
                else:
                    logger.warning(
                        f"[DingTalk] No email found for employee {employee_id}"
                    )
                    return None
            else:
                logger.warning(
                    f"[DingTalk] ERP API error: code={result.get('code')}, "
                    f"msg={result.get('msg')}"
                )
                return None
        except Exception as e:
            logger.error(f"[DingTalk] Failed to get employee email: {e}")
            return None


# Global service instance
dingtalk_service = DingTalkService()
