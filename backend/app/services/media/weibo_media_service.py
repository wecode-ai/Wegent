"""Weibo media platform integration."""

import logging
from dataclasses import dataclass
from typing import Optional

import httpx

from app.models.user import User
from app.services.tauth import auth_headers
from app.services.weibo_account_binding import weibo_account_binding_service

logger = logging.getLogger(__name__)

WEIBO_INIT_URL = "http://i.fileplatform.api.weibo.com/2/multimedia/init.json"
WEIBO_DOWNLOAD_URL = (
    "http://i.fileplatform.api.weibo.com/2/multimedia/downloadlink.json"
)
WEIBO_SOURCE = "3061639762"
WEIBO_SERVICE_UID = 5835938223


def resolve_weibo_media_uid(user: User | None) -> int:
    """Resolve the TAuth UID for Weibo video APIs."""
    if user is None:
        return WEIBO_SERVICE_UID

    binding_status = weibo_account_binding_service.get_status(user)
    if binding_status.weibo_uid and binding_status.weibo_uid.isdigit():
        return int(binding_status.weibo_uid)

    return WEIBO_SERVICE_UID


@dataclass(frozen=True)
class WeiboInitResult:
    """Result returned by Weibo upload initialization."""

    file_token: str
    chunk_size: int
    auth: str
    request_id: str


class WeiboMediaService:
    """Client wrapper for Weibo media upload and download-link APIs."""

    async def init_upload(
        self,
        filename: str,
        file_size: int,
        file_check: str,
        user: User | None = None,
    ) -> WeiboInitResult:
        """Initialize chunked upload and return client upload parameters."""
        params = {
            "upload_only": "true",
            "name": filename,
            "length": file_size,
            "check": file_check,
            "type": "short_video_tmp",
            "mediaprops": "",
        }
        headers = auth_headers(resolve_weibo_media_uid(user))

        async with httpx.AsyncClient() as client:
            response = await client.get(
                WEIBO_INIT_URL,
                params=params,
                headers=headers,
                timeout=30.0,
            )

        if response.status_code >= 400:
            logger.error(
                "Weibo init failed: status=%s, url=%s, response_body=%s",
                response.status_code,
                response.url,
                response.text,
            )
            raise httpx.HTTPStatusError(
                "Weibo init failed",
                request=response.request,
                response=response,
            )

        data = response.json()
        file_token = data.get("fileToken")
        chunk_size_kb = data.get("length", 4096)
        auth = data.get("auth", "")
        request_id = data.get("request_id", "")

        if not file_token:
            raise ValueError("Weibo init failed: no fileToken returned")
        if not auth:
            raise ValueError("Weibo init failed: no auth returned")

        return WeiboInitResult(
            file_token=file_token,
            chunk_size=chunk_size_kb * 1024,
            auth=auth,
            request_id=request_id,
        )

    def get_download_url(self, fid: int, user: User | None = None) -> Optional[str]:
        """Convert a Weibo file ID to a short-lived download URL."""
        logger.info("[weibo_media] Converting fid=%s to video URL", fid)

        params = {
            "fid": fid,
            "source": WEIBO_SOURCE,
        }
        headers = auth_headers(resolve_weibo_media_uid(user))

        try:
            with httpx.Client() as client:
                response = client.get(
                    WEIBO_DOWNLOAD_URL,
                    params=params,
                    headers=headers,
                    timeout=30.0,
                )

            if response.status_code >= 400:
                logger.error(
                    "[weibo_media] Download-link API error: status=%s, body=%s",
                    response.status_code,
                    response.text,
                )
                return None

            data = response.json()
            logger.info(
                "[weibo_media] Download-link response: succ=%s, has_url=%s, has_urls=%s",
                data.get("succ"),
                bool(data.get("url")),
                bool(data.get("urls")),
            )

            if not data.get("succ"):
                logger.warning(
                    "[weibo_media] Download-link API returned failure: %s", data
                )
                return None

            video_url = data.get("url") or (data.get("urls") or [None])[0]
            if not video_url:
                logger.warning(
                    "[weibo_media] No URL in response for fid=%s: %s", fid, data
                )
                return None

            logger.info(
                "[weibo_media] Successfully got video URL for fid=%s: %s...",
                fid,
                video_url[:80],
            )
            return video_url
        except Exception as exc:
            logger.error(
                "[weibo_media] Failed to get download URL for fid=%s: %s", fid, exc
            )
            return None


weibo_media_service = WeiboMediaService()
