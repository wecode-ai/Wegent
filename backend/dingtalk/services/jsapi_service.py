# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk JSAPI ticket and signature service."""
import hashlib
import logging
import time
from urllib.parse import urlparse, urlunparse, unquote

import httpx

from app.core.cache import cache_manager
from dingtalk.config import dingtalk_config

logger = logging.getLogger(__name__)

JSAPI_TICKET_CACHE_KEY = "dingtalk:jsapi_ticket"
JSAPI_TICKET_TTL = 6000  # Refresh before 7200s expiry

# Fixed nonce string used for JSAPI signature calculation.
# Must match JSAPI_NONCE_STR constant in frontend/src/dingtalk/lib/dingtalk-sdk.ts.
NONCE_STR = "ISEEDEADPEOPLE"


def _decode_url(url: str) -> str:
    """
    Decode URL for signature calculation.

    iOS passes URL-encoded URLs, Android passes raw URLs.
    Developers use raw URLs, so we need to URL-decode the query string.
    """
    parsed = urlparse(url)
    decoded_query = unquote(parsed.query) if parsed.query else ""
    rebuilt = urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path,
        parsed.params,
        decoded_query,
        "",  # Remove fragment for signature
    ))
    return rebuilt


def _compute_signature(jsticket: str, nonce_str: str, timestamp: int, url: str) -> str:
    """
    Compute dd.config signature using SHA-256.

    Formula: SHA256("jsapi_ticket=<ticket>&noncestr=<nonce>&timestamp=<ts>&url=<url>")
    """
    decoded_url = _decode_url(url)
    plain = (
        f"jsapi_ticket={jsticket}"
        f"&noncestr={nonce_str}"
        f"&timestamp={timestamp}"
        f"&url={decoded_url}"
    )
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


class JsapiService:
    """DingTalk JSAPI ticket and signature service."""

    DINGTALK_API_BASE = "https://api.dingtalk.com"

    def __init__(self):
        self.config = dingtalk_config

    async def _get_access_token(self) -> str:
        """
        Get DingTalk app access token.
        Uses the same approach as DingTalkService but with a separate cache key
        to avoid coupling.
        """
        cache_key = "dingtalk:jsapi_access_token"
        cached = await cache_manager.get(cache_key)
        if cached:
            return cached

        logger.info("[DingTalk JSAPI] Fetching new access token for JSAPI ticket")
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
            logger.info(f"Failed to get access token for JSAPI: {data}")
            return None 

        expire_in = data.get("expireIn", 7200)
        ttl = max(expire_in - 600, 600)  # Refresh 10 minutes before expiry
        await cache_manager.set(cache_key, access_token, expire=ttl)
        return access_token

    async def get_jsapi_ticket(self) -> str:
        """
        Get DingTalk JSAPI ticket with Redis caching.
        API: POST /v1.0/oauth2/jsapiTickets
        """
        cached = await cache_manager.get(JSAPI_TICKET_CACHE_KEY)
        if cached:
            logger.debug("[DingTalk JSAPI] Using cached JSAPI ticket")
            return cached

        logger.info("[DingTalk JSAPI] Fetching new JSAPI ticket")
        access_token = await self._get_access_token()

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.DINGTALK_API_BASE}/v1.0/oauth2/jsapiTickets",
                headers={"x-acs-dingtalk-access-token": access_token},
            )
            response.raise_for_status()
            data = response.json()

        ticket = data.get("jsapiTicket")
        if not ticket:
            logger.info(f"Failed to get JSAPI ticket: {data}")
            return None

        expire_in = data.get("expireIn", 7200)
        ttl = max(expire_in - 600, 600)
        await cache_manager.set(JSAPI_TICKET_CACHE_KEY, ticket, expire=ttl)
        logger.info("[DingTalk JSAPI] JSAPI ticket fetched and cached")
        return ticket

    async def get_jsapi_sign(self, url: str) -> dict:
        """
        Generate dd.config signature parameters for the given page URL.

        Returns only timeStamp and signature - other dd.config params
        (agentId, corpId, nonceStr, jsApiList) are read from frontend env vars.
        """
        jsticket = await self.get_jsapi_ticket()
        # DingTalk dd.config requires seconds-level timestamp (not milliseconds)
        timestamp = int(time.time())
        nonce_str = NONCE_STR
        signature = _compute_signature(jsticket, nonce_str, timestamp, url)

        return {
            "timeStamp": timestamp,
            "signature": signature,
        }


# Global service instance
jsapi_service = JsapiService()
