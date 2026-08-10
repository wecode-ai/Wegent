"""Weibo media platform integration."""

import hashlib
import logging
from dataclasses import dataclass
from typing import Optional

import httpx

from app.models.user import User
from app.services.tauth import auth_headers
from app.services.weibo_account_binding import weibo_account_binding_service

logger = logging.getLogger(__name__)

WEIBO_INIT_URL = "http://i.fileplatform.api.weibo.com/2/multimedia/init.json"
WEIBO_UPLOAD_URL = "https://fileplatform.api.weibo.com/2/multimedia/upload.json"
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


@dataclass(frozen=True)
class WeiboUploadResult:
    """Result returned after uploading video bytes to Weibo file platform."""

    fid: int
    request_id: str
    url: str = ""


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
        try:
            chunk_size_kb = int(data.get("length", 4096))
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "Weibo init failed: invalid chunk length returned"
            ) from exc
        auth = data.get("auth", "")
        request_id = data.get("request_id", "")

        if not file_token:
            raise ValueError("Weibo init failed: no fileToken returned")
        if not auth:
            raise ValueError("Weibo init failed: no auth returned")
        if chunk_size_kb <= 0:
            raise ValueError("Weibo init failed: invalid chunk length returned")

        return WeiboInitResult(
            file_token=file_token,
            chunk_size=chunk_size_kb * 1024,
            auth=auth,
            request_id=request_id,
        )

    async def upload_video_bytes(
        self,
        *,
        filename: str,
        content: bytes,
        user: User | None = None,
    ) -> WeiboUploadResult:
        """Upload video bytes to Weibo file platform and return the final fid."""
        if not content:
            raise ValueError("Cannot upload empty video content")

        file_check = hashlib.md5(content).hexdigest()
        init_result = await self.init_upload(
            filename=filename,
            file_size=len(content),
            file_check=file_check,
            user=user,
        )
        chunk_size = max(init_result.chunk_size, 1)
        chunk_count = (len(content) + chunk_size - 1) // chunk_size
        last_response: dict | None = None

        async with httpx.AsyncClient(timeout=120.0) as client:
            for index in range(chunk_count):
                start = index * chunk_size
                chunk = content[start : start + chunk_size]
                section_check = hashlib.md5(chunk).hexdigest()
                response = await client.post(
                    WEIBO_UPLOAD_URL,
                    params={
                        "filetoken": init_result.file_token,
                        "startloc": str(start),
                        "sectioncheck": section_check,
                        "chunkcount": str(chunk_count),
                        "chunkindex": str(index + 1),
                        "chunksize": str(len(chunk)),
                        "filelength": str(len(content)),
                        "filecheck": file_check,
                    },
                    headers={
                        "Content-Type": "application/octet-stream",
                        "X-Up-Auth": init_result.auth,
                    },
                    content=chunk,
                )
                if response.status_code >= 400:
                    logger.error(
                        "[weibo_media] Upload chunk failed: status=%s body=%s",
                        response.status_code,
                        response.text,
                    )
                    response.raise_for_status()

                data = response.json()
                error = self._read_upload_error(data)
                if error:
                    raise ValueError(error)
                if data.get("fid"):
                    last_response = data

        if not last_response or not last_response.get("fid"):
            raise ValueError("Weibo upload completed but no fid returned")

        return WeiboUploadResult(
            fid=int(last_response["fid"]),
            request_id=last_response.get("request_id") or init_result.request_id,
            url=last_response.get("url") or "",
        )

    @staticmethod
    def _read_upload_error(data: dict) -> str | None:
        if data.get("succ") is not False:
            return None
        return (
            data.get("error")
            or data.get("errmsg")
            or data.get("msg")
            or data.get("message")
            or "Weibo chunk upload failed"
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
                    "[weibo_media] Download-link API returned failure for fid=%s", fid
                )
                return None

            video_url = data.get("url") or (data.get("urls") or [None])[0]
            if not video_url:
                logger.warning("[weibo_media] No URL in response for fid=%s", fid)
                return None

            logger.info("[weibo_media] Successfully resolved video URL for fid=%s", fid)
            return video_url
        except Exception as exc:
            logger.error(
                "[weibo_media] Failed to get download URL for fid=%s: %s", fid, exc
            )
            return None


weibo_media_service = WeiboMediaService()
