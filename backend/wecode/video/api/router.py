# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated endpoints for the configured AIGC video adapter."""

import asyncio
import logging
from contextlib import suppress
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.media.weibo_image_upload import weibo_image_upload_service
from app.services.media.weibo_media_service import resolve_weibo_media_uid
from app.services.shared_task import shared_task_service
from wecode.video.api.client import (
    fetch_health,
    validate_image_url,
    validate_playback_url,
)
from wecode.video.config.media import video_media_settings
from wecode.video.services.media_platform import fetch_playback, sign_urls, upload_media

from .opencut import router as opencut_router

router = APIRouter()
router.include_router(opencut_router)
MEDIA_TIMEOUT_SECONDS = 120.0
MEDIA_CHUNK_SIZE = 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 120.0
PASS_THROUGH_REQUEST_HEADERS = {"content-type", "x-request-id"}
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

logger = logging.getLogger(__name__)


def _user_uid(current_user: User) -> str:
    return str(current_user.user_name or current_user.id)


def _shared_read_identity(
    *,
    current_user: User | None,
    share_token: str | None,
    db: Session,
) -> tuple[str, int | None]:
    if share_token:
        share_info = shared_task_service.decode_share_token(share_token, db)
        if share_info:
            return str(share_info.user_name), int(share_info.task_id)
        raise HTTPException(status_code=403, detail="Invalid task share token")
    if current_user is not None:
        return _user_uid(current_user), None
    raise HTTPException(
        status_code=401,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _media_read_identity(
    *,
    request: Request,
    current_user: User | None,
    share_token: str | None,
    db: Session,
) -> tuple[str, int | None]:
    if share_token or current_user is not None:
        return _shared_read_identity(
            current_user=current_user,
            share_token=share_token,
            db=db,
        )
    cookie_token = request.cookies.get("auth_token")
    cookie_user = (
        security.get_current_user_from_token(cookie_token, db) if cookie_token else None
    )
    if cookie_user is not None and not cookie_user.is_active:
        cookie_user = None
    return _shared_read_identity(
        current_user=cookie_user,
        share_token=None,
        db=db,
    )


def _upstream_url(path: str, query_params: list[tuple[str, str]] | None = None) -> str:
    normalized_path = path.lstrip("/")
    if normalized_path.startswith("api/v2/"):
        normalized_path = normalized_path.removeprefix("api/")
    if normalized_path.startswith("v2/"):
        normalized_path = f"aigc_video/{normalized_path}"
    elif not normalized_path.startswith("aigc_video/"):
        normalized_path = f"aigc_video/{normalized_path}"
    url = (
        f"{video_media_settings.AIGC_VIDEO_AGENT_URL.rstrip('/')}/" f"{normalized_path}"
    )
    if query_params:
        url = f"{url}?{urlencode(query_params)}"
    return url


def _response_headers(response: httpx.Response) -> dict[str, str]:
    return {
        name: value
        for name, value in response.headers.items()
        if name.lower() not in HOP_BY_HOP_HEADERS
        and name.lower() not in {"content-encoding", "content-length"}
    }


async def _forward_json(
    *, current_user: User, method: str, path: str, payload: dict[str, Any]
) -> Response:
    try:
        async with httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT_SECONDS, trust_env=False
        ) as client:
            upstream = await client.request(
                method,
                _upstream_url(path),
                headers={"UID": _user_uid(current_user)},
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504, detail="AIGC video request timed out"
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail="AIGC video service unavailable"
        ) from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )


async def _forward_shared_read(
    *,
    request: Request,
    path: str,
    uid: str,
    task_id: int | None,
) -> Response:
    query_params = [
        (name, value)
        for name, value in request.query_params.multi_items()
        if name != "share_token"
    ]
    if task_id is not None:
        query_params.extend([("skip_check", "1"), ("wegent_task_id", str(task_id))])
    try:
        async with httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT_SECONDS, trust_env=False
        ) as client:
            upstream = await client.get(
                _upstream_url(path, query_params),
                headers={"UID": uid},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504, detail="AIGC video request timed out"
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail="AIGC video service unavailable"
        ) from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )


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


async def _stream_image(image_url: str) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=MEDIA_TIMEOUT_SECONDS, trust_env=False)
    stream = client.stream(
        "GET",
        image_url,
        headers={"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"},
    )
    try:
        response = await stream.__aenter__()
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if not content_type.startswith("image/"):
            raise ValueError("AIGC image response is not an image")
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

    return StreamingResponse(
        chunks(),
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=300",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
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
    request: Request,
    video_url: str = Query(..., min_length=1),
    range_header: str | None = Header(None, alias="Range"),
    share_token: str | None = Query(None),
    current_user: User | None = Depends(security.get_current_user_optional),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Refresh the anti-hotlink signature before browser-native playback."""
    _media_read_identity(
        request=request,
        current_user=current_user,
        share_token=share_token,
        db=db,
    )
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


@router.get("/media/image")
async def aigc_video_image(
    request: Request,
    image_url: str = Query(..., min_length=1),
    share_token: str | None = Query(None),
    current_user: User | None = Depends(security.get_current_user_optional),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Proxy allowlisted storyboard images with a browser-safe content type."""
    _media_read_identity(
        request=request,
        current_user=current_user,
        share_token=share_token,
        db=db,
    )
    try:
        return await _stream_image(validate_image_url(image_url))
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=502, detail="AIGC storyboard image is unavailable"
        ) from exc


async def _replace_image(
    *, resource_path: str, file: UploadFile, current_user: User
) -> Response:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Image file is empty")
    try:
        image_pid = await weibo_image_upload_service.upload_bytes(
            filename=file.filename or "image.jpg",
            content=content,
            mime_type=file.content_type or "application/octet-stream",
            uid=resolve_weibo_media_uid(current_user),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        logger.exception("AIGC video image upload failed")
        raise HTTPException(status_code=502, detail="Image upload failed") from exc
    return await _forward_json(
        current_user=current_user,
        method="PUT",
        path=resource_path,
        payload={"image_pid": image_pid},
    )


@router.get("/api/v2/scripts/{script_id}")
@router.get("/v2/scripts/{script_id}")
async def get_shared_script(
    request: Request,
    script_id: int,
    share_token: str | None = Query(None),
    current_user: User | None = Depends(security.get_current_user_optional),
    db: Session = Depends(get_db),
) -> Response:
    """Read a script through an authenticated user or a task share token."""
    uid, task_id = _shared_read_identity(
        current_user=current_user,
        share_token=share_token,
        db=db,
    )
    return await _forward_shared_read(
        request=request,
        path=f"v2/scripts/{script_id}",
        uid=uid,
        task_id=task_id,
    )


@router.get("/api/v2/entities")
@router.get("/v2/entities")
async def get_shared_entities(
    request: Request,
    share_token: str | None = Query(None),
    current_user: User | None = Depends(security.get_current_user_optional),
    db: Session = Depends(get_db),
) -> Response:
    """Read entities through an authenticated user or a task share token."""
    uid, task_id = _shared_read_identity(
        current_user=current_user,
        share_token=share_token,
        db=db,
    )
    return await _forward_shared_read(
        request=request,
        path="v2/entities",
        uid=uid,
        task_id=task_id,
    )


@router.get("/api/v2/storyboards/{script_id}")
@router.get("/v2/storyboards/{script_id}")
async def get_shared_storyboards(
    request: Request,
    script_id: int,
    share_token: str | None = Query(None),
    current_user: User | None = Depends(security.get_current_user_optional),
    db: Session = Depends(get_db),
) -> Response:
    """Read storyboards through an authenticated user or a task share token."""
    uid, task_id = _shared_read_identity(
        current_user=current_user,
        share_token=share_token,
        db=db,
    )
    return await _forward_shared_read(
        request=request,
        path=f"v2/storyboards/{script_id}",
        uid=uid,
        task_id=task_id,
    )


@router.post("/v2/entities/{entity_id}/replace-image")
async def replace_entity_image(
    entity_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Upload and persist a replacement entity image."""
    return await _replace_image(
        resource_path=f"v2/entities/{entity_id}/replace-image",
        file=file,
        current_user=current_user,
    )


@router.post("/v2/storyboards/{storyboard_id}/replace-image")
async def replace_storyboard_image(
    storyboard_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Upload and persist a replacement storyboard image."""
    return await _replace_image(
        resource_path=f"v2/storyboards/{storyboard_id}/replace-image",
        file=file,
        current_user=current_user,
    )


@router.post("/v2/storyboards/{storyboard_id}/replace-video")
async def replace_storyboard_video(
    storyboard_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Upload and persist a replacement storyboard video."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Video file is empty")
    uid = video_media_settings.get_upload_uid()
    try:
        uploaded = await asyncio.to_thread(
            upload_media,
            data=content,
            filename=file.filename or "video.mp4",
            uid=uid,
            media_type="video",
        )
        playback_by_id = await asyncio.to_thread(
            fetch_playback, [uploaded.media_id], uid, sign=False
        )
        playback = playback_by_id.get(uploaded.media_id)
    except (httpx.HTTPError, ValueError) as exc:
        logger.exception("AIGC storyboard video upload failed")
        raise HTTPException(status_code=502, detail="Video upload failed") from exc

    return await _forward_json(
        current_user=current_user,
        method="PUT",
        path=f"v2/storyboards/{storyboard_id}/replace-video",
        payload={
            "media_id": uploaded.media_id,
            "video_play_url": playback.url if playback else "",
            "video_cover_url": playback.cover_url if playback else "",
            "duration": playback.duration if playback else 0,
        },
    )


@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def proxy_aigc_video_request(
    request: Request,
    path: str,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Proxy authenticated editor requests to the configured AIGC service."""
    headers = {"UID": _user_uid(current_user)}
    for name in PASS_THROUGH_REQUEST_HEADERS:
        if value := request.headers.get(name):
            headers[name] = value
    try:
        async with httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT_SECONDS, trust_env=False
        ) as client:
            upstream = await client.request(
                request.method,
                _upstream_url(path, list(request.query_params.multi_items())),
                headers=headers,
                content=await request.body(),
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504, detail="AIGC video request timed out"
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail="AIGC video service unavailable"
        ) from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )
