# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo multimedia upload and playback client for video generation."""

import hashlib
import json
import math
import uuid
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from app.services.tauth import auth_headers
from wecode.config.video_media_config import video_media_settings

_DEFAULT_CHUNK_SIZE = 512 * 1024


@dataclass(frozen=True)
class UploadedMedia:
    """Stable identifiers returned by the Weibo file platform."""

    media_id: str
    upload_id: str


@dataclass(frozen=True)
class PlaybackInfo:
    """Playable media metadata resolved from a stable media ID."""

    url: str
    cover_url: Optional[str] = None
    duration: Optional[float] = None
    size: Optional[int] = None


def upload_media(
    *,
    data: bytes,
    filename: str,
    uid: str,
    media_type: str,
) -> UploadedMedia:
    """Upload video or podcast audio using the four-step file-platform flow."""
    config = video_media_settings
    config.validate_storage_config()
    if not data:
        raise ValueError("Cannot upload empty media")

    upload_type = "podcast_audio" if media_type == "audio" else "video"
    base_url = config.WEIBO_FILEPLATFORM_URL.rstrip("/")
    common_headers = auth_headers(uid)
    timeout = config.WEIBO_MEDIA_TIMEOUT_SECONDS

    with httpx.Client(timeout=timeout) as client:
        dispatch = client.get(
            f"{base_url}/2/fileplatform/dispatch.json",
            params={
                "types": upload_type,
                "size": str(len(data)),
                "version": "4",
                "source": config.WEIBO_TAUTH2_APPKEY,
            },
            headers=common_headers,
        )
        dispatch.raise_for_status()
        upload_info = dispatch.json().get(upload_type) or {}
        required_urls = (
            "internal_init_url",
            "internal_upload_url",
            "internal_check_url",
        )
        if any(not upload_info.get(key) for key in required_urls):
            raise ValueError("Invalid Weibo file-platform dispatch response")

        init_result = _initialize_upload(
            client=client,
            url=upload_info["internal_init_url"],
            data_size=len(data),
            filename=filename,
            uid=uid,
            upload_type=upload_type,
        )
        media_id = str(init_result.get("media_id") or "")
        upload_id = str(init_result.get("upload_id") or "")
        upload_auth = str(init_result.get("auth") or "")
        if not media_id or not upload_id or not upload_auth:
            raise ValueError("Invalid Weibo file-platform init response")

        strategy = init_result.get("strategy") or {}
        chunk_size_kb = strategy.get("chunk_size")
        chunk_size = (
            int(chunk_size_kb) * 1024
            if isinstance(chunk_size_kb, (int, float)) and chunk_size_kb > 0
            else _DEFAULT_CHUNK_SIZE
        )
        chunk_count = max(1, math.ceil(len(data) / chunk_size))
        _upload_chunks(
            client=client,
            url=upload_info["internal_upload_url"],
            data=data,
            upload_id=upload_id,
            media_id=media_id,
            upload_auth=upload_auth,
            upload_type=upload_type,
            chunk_size=chunk_size,
        )
        check = client.post(
            upload_info["internal_check_url"],
            params={
                "upload_id": upload_id,
                "media_id": media_id,
                "upload_protocol": "binary",
                "count": str(chunk_count),
                "action": "finish",
                "size": str(len(data)),
                "client": "web",
                "name": filename,
            },
            headers={**auth_headers(uid), "X-Up-Auth": upload_auth},
        )
        check.raise_for_status()
        if check.json().get("result") is not True:
            raise ValueError("Weibo file-platform upload check failed")

    return UploadedMedia(media_id=media_id, upload_id=upload_id)


def _initialize_upload(
    *,
    client: httpx.Client,
    url: str,
    data_size: int,
    filename: str,
    uid: str,
    upload_type: str,
) -> dict[str, Any]:
    mediaprops = {"aigc_material": 1}
    if upload_type == "podcast_audio":
        mediaprops["video_type"] = "podcast_audio"
    biz_file = json.dumps(
        {
            "type": upload_type,
            "c": "web",
            "size": str(data_size),
            "name": filename,
            "mediaprops": json.dumps(mediaprops),
            "availability": {"upload_protocols": ["binary"]},
        }
    )
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="biz_file"\r\n'
        "Content-Type: application/json\r\n\r\n"
        f"{biz_file}\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    response = client.post(
        url,
        params={
            "source": video_media_settings.WEIBO_TAUTH2_APPKEY,
            "size": str(data_size),
            "name": filename,
            "type": upload_type,
            "client": "web",
        },
        headers={
            **auth_headers(uid),
            "Content-Type": f"multipart/mixed; boundary={boundary}",
        },
        content=body,
    )
    response.raise_for_status()
    return response.json()


def _upload_chunks(
    *,
    client: httpx.Client,
    url: str,
    data: bytes,
    upload_id: str,
    media_id: str,
    upload_auth: str,
    upload_type: str,
    chunk_size: int,
) -> None:
    chunk_count = max(1, math.ceil(len(data) / chunk_size))
    for index in range(chunk_count):
        start = index * chunk_size
        chunk = data[start : start + chunk_size]
        response = client.post(
            url,
            params={
                "upload_id": upload_id,
                "media_id": media_id,
                "upload_protocol": "binary",
                "type": upload_type,
                "client": "web",
                "check": hashlib.md5(chunk).hexdigest(),
                "index": str(index),
                "size": str(len(chunk)),
                "start_loc": str(start),
                "count": str(chunk_count),
            },
            headers={"X-Up-Auth": upload_auth},
            content=chunk,
        )
        response.raise_for_status()
        if response.json().get("result") is not True:
            raise ValueError(f"Weibo media chunk upload failed at index {index}")


def fetch_playback(
    media_ids: list[str],
    uid: str,
    *,
    sign: bool = True,
) -> dict[str, Optional[PlaybackInfo]]:
    """Resolve stable media IDs into original media URLs."""
    normalized_ids = list(
        dict.fromkeys(str(item).strip() for item in media_ids if item)
    )
    if not normalized_ids:
        return {}

    config = video_media_settings
    config.validate_playback_config()
    with httpx.Client(timeout=config.WEIBO_MEDIA_TIMEOUT_SECONDS) as client:
        response = client.get(
            config.WEIBO_VIDEO_SHOW_BATCH_URL,
            params={
                "ids": ",".join(normalized_ids),
                "id_type": 1,
                "part": "origin",
                "cover_types": "first_frame",
                "source": config.WEIBO_TAUTH2_APPKEY,
                "ssig": "true",
            },
            headers=auth_headers(uid),
        )
        response.raise_for_status()
        payload = response.json()

    result: dict[str, Optional[PlaybackInfo]] = {}
    raw_urls: list[str] = []
    for media_id in normalized_ids:
        item = payload.get(media_id)
        if not isinstance(item, dict):
            result[media_id] = None
            continue
        info = _parse_playback_info(item)
        result[media_id] = info
        if info is not None:
            raw_urls.append(info.url)

    if sign and raw_urls:
        signed = sign_urls(raw_urls, uid)
        result = {
            media_id: (
                PlaybackInfo(
                    url=signed.get(info.url) or info.url,
                    cover_url=info.cover_url,
                    duration=info.duration,
                    size=info.size,
                )
                if info is not None
                else None
            )
            for media_id, info in result.items()
        }
    return result


def sign_urls(urls: list[str], uid: str) -> dict[str, Optional[str]]:
    """Generate current anti-hotlink URLs for raw playback URLs."""
    unique_urls = list(dict.fromkeys(url for url in urls if url))
    if not unique_urls:
        return {}
    config = video_media_settings
    config.validate_storage_config()
    with httpx.Client(timeout=config.WEIBO_MEDIA_TIMEOUT_SECONDS) as client:
        response = client.get(
            config.WEIBO_MEDIA_SSIG_URL,
            params={
                "source": config.WEIBO_TAUTH2_APPKEY,
                "urls": ",".join(url.split("?", 1)[0] for url in unique_urls),
            },
            headers=auth_headers(uid),
        )
        response.raise_for_status()
        payload = response.json()
    signed: dict[str, Optional[str]] = {url: None for url in unique_urls}
    for index, item in enumerate(payload.get("results") or []):
        if index >= len(unique_urls) or not isinstance(item, dict):
            break
        result_data = item.get("result_data") or {}
        if item.get("result") == 0 and result_data.get("ssig_url"):
            signed[unique_urls[index]] = str(result_data["ssig_url"])
    return signed


def _parse_playback_info(item: dict[str, Any]) -> Optional[PlaybackInfo]:
    candidates = (item.get("origin") or {}).get("videos") or []
    usable = [
        value for value in candidates if isinstance(value, dict) and value.get("url")
    ]
    candidate = usable[0] if usable else None
    if candidate is None:
        return None
    basic_info = item.get("video_basic_info") or {}
    cover = next(
        (
            value.get("url")
            for value in basic_info.get("covers") or item.get("covers") or []
            if isinstance(value, dict) and value.get("url")
        ),
        None,
    )
    duration = item.get("duration") or basic_info.get("duration")
    size = candidate.get("size")
    return PlaybackInfo(
        url=str(candidate["url"]).split("?", 1)[0],
        cover_url=str(cover) if cover else None,
        duration=float(duration) if isinstance(duration, (int, float)) else None,
        size=int(size) if isinstance(size, (int, float)) else None,
    )
