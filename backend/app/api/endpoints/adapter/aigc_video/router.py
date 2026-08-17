# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated endpoints for the configured AIGC video adapter."""

import asyncio
from contextlib import suppress
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.api.endpoints.adapter.aigc_video.client import (
    fetch_health,
    validate_playback_url,
)
from app.core import security
from app.models.user import User
from wecode.config.video_media_config import video_media_settings
from wecode.service.video_media_platform import sign_urls

router = APIRouter()
MEDIA_TIMEOUT_SECONDS = 120.0
MEDIA_CHUNK_SIZE = 1024 * 1024


async def _stream_signed_video(
    signed_url: str,
    range_header: str | None,
) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=MEDIA_TIMEOUT_SECONDS, trust_env=False)
    headers = {"Range": range_header} if range_header else {}
    stream = client.stream("GET", signed_url, headers=headers)
    try:
        response = await stream.__aenter__()
        response.raise_for_status()
    except Exception as exc:
        with suppress(Exception):
            await stream.__aexit__(type(exc), exc, exc.__traceback__)
        await client.aclose()
        raise

    async def chunks():
        try:
            async for chunk in response.aiter_bytes(chunk_size=MEDIA_CHUNK_SIZE):
                if chunk:
                    yield chunk
        finally:
            await stream.__aexit__(None, None, None)
            await client.aclose()

    response_headers = {
        "Accept-Ranges": response.headers.get("accept-ranges", "bytes"),
        "Referrer-Policy": "no-referrer",
        "X-Accel-Buffering": "no",
    }
    for name in ("content-length", "content-range"):
        if value := response.headers.get(name):
            response_headers[name] = value
    return StreamingResponse(
        chunks(),
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "video/mp4"),
        headers=response_headers,
    )


@router.get("/health")
def aigc_video_health(
    current_user: User = Depends(security.get_current_user),
) -> dict[str, Any]:
    del current_user
    try:
        return {"status": "healthy", "upstream": fetch_health()}
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=502, detail="AIGC video service unavailable"
        ) from exc


@router.get("/media/playback")
async def aigc_video_playback(
    video_url: str = Query(..., min_length=1),
    range_header: str | None = Header(None, alias="Range"),
    current_user: User = Depends(security.get_current_user),
) -> StreamingResponse:
    """Refresh the anti-hotlink signature before browser-native playback."""
    del current_user
    try:
        validated_url = validate_playback_url(video_url)
        uid = video_media_settings.get_upload_uid()
        signed_urls = await asyncio.to_thread(sign_urls, [validated_url], uid)
        signed_url = signed_urls.get(validated_url)
        if not signed_url:
            raise ValueError("AIGC playback URL could not be signed")
        validate_playback_url(signed_url)
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=502, detail="AIGC video playback is unavailable"
        ) from exc

    try:
        return await _stream_signed_video(signed_url, range_header)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail="AIGC video playback is unavailable"
        ) from exc
