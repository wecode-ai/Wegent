"""Adapt multi-style workflows to the existing durable CardBlock protocol."""

import re
from time import time
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from jose import JWTError, jwt

from app.core.config import settings
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.execution.agents.video.async_card import (
    async_video_card_service,
    register_async_card_url_validator,
)
from shared.telemetry.decorators import trace_async
from wecode.video.config.media import video_media_settings

router = APIRouter()
CARD_TYPE = "video_multi_style_generation"
POLL_PATH = "/api/aigc-video/material-video/multi-style/card/"
UPSTREAM_PATH = "/aigc_video/v2/material-video-async/multi-style/task/by-session/"
TOKEN_KIND = "multi-style-card-poll"
STATUS_NAMES = {0: "pending", 1: "processing", 2: "completed", -1: "failed"}


def _backend_base() -> str:
    base = settings.WEGENT_BACKEND_PUBLIC_URL.strip().rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("WEGENT_BACKEND_PUBLIC_URL is required")
    return base


def is_multi_style_poll_url(value: str) -> bool:
    """Allow only our configured, signed polling endpoint."""
    try:
        parsed, base = urlsplit(value), urlsplit(_backend_base())
        session_id = parsed.path.removeprefix(base.path + POLL_PATH)
        return (
            parsed.scheme == base.scheme
            and parsed.netloc == base.netloc
            and parsed.path.startswith(base.path + POLL_PATH)
            and session_id.isdigit()
            and not parsed.fragment
        )
    except ValueError:
        return False


def _validate_task_url(task_url: str, token_info: TaskTokenInfo) -> None:
    expected = (
        video_media_settings.AIGC_VIDEO_AGENT_URL.rstrip("/")
        + UPSTREAM_PATH
        + str(token_info.task_id)
    )
    parsed = urlsplit(task_url)
    if parsed._replace(query="").geturl() != expected or parse_qs(parsed.query) != {
        "uid": [token_info.user_name]
    }:
        raise ValueError("Multi-style URL must belong to this task and user")


def _poll_url(token_info: TaskTokenInfo) -> str:
    token = jwt.encode(
        {
            "kind": TOKEN_KIND,
            "session_id": str(token_info.task_id),
            "uid": token_info.user_name,
            "exp": int(time()) + 7 * 24 * 3600,
        },
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    return f"{_backend_base()}{POLL_PATH}{token_info.task_id}?{urlencode({'token': token})}"


def _verify_token(token: str, session_id: str) -> str:
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
    except JWTError as exc:
        raise HTTPException(401, "Invalid multi-style poll token") from exc
    if (
        payload.get("kind") != TOKEN_KIND
        or payload.get("session_id") != session_id
        or not isinstance(payload.get("uid"), str)
        or not payload["uid"]
    ):
        raise HTTPException(401, "Invalid multi-style poll token")
    return payload["uid"]


def _status(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        return STATUS_NAMES.get(value, "failed")
    return value if value in STATUS_NAMES.values() else "failed"


def _progress(value: Any) -> int:
    return max(0, min(100, int(value))) if isinstance(value, (int, float)) else 0


def normalize_multi_style(raw: dict[str, Any], session_id: str) -> dict[str, Any]:
    """Keep all variants, including playable results when siblings fail."""
    items = raw.get("wb_data")
    if not isinstance(items, list):
        raise ValueError("Multi-style response must contain a variants list")
    videos = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid multi-style variant")
        child = str(item.get("sub_task_id") or "")
        if not re.fullmatch(re.escape(session_id) + r"_[1-3]", child) or child in seen:
            raise ValueError("Invalid or duplicate multi-style child session")
        seen.add(child)
        videos.append(
            {
                **{
                    key: str(item.get(key) or "")
                    for key in (
                        "sub_task_id",
                        "style_kind",
                        "audio_mode",
                        "theme",
                        "title",
                        "video_url",
                        "cover_url",
                        "media_id",
                        "error",
                    )
                },
                "status": _status(item.get("status")),
                "progress": _progress(item.get("progress")),
                "duration": (item.get("duration_ms") or 0) / 1000,
            }
        )
    state = _status(raw.get("status"))
    if state == "completed" and len(videos) != 3:
        raise ValueError("Completed multi-style task must contain three variants")
    ready = any(v["status"] == "completed" for v in videos)
    terminal = len(videos) == 3 and all(
        v["status"] in {"completed", "failed"} for v in videos
    )
    if terminal:
        state = "completed" if ready else "failed"
    elif ready and state in {"pending", "processing"}:
        state = "partial_ready"
    return {
        "status": state,
        "progress": _progress(raw.get("progress")),
        "progress_text": str(raw.get("current_step") or ""),
        "error_message": str(raw.get("error") or "") if state == "failed" else "",
        "card": {"videos": videos, "session_id": session_id},
    }


@router.get("/material-video/multi-style/card/{session_id}")
@trace_async(span_name="multi_style.poll", tracer_name=__name__)
async def poll_multi_style(session_id: str, token: str) -> dict[str, Any]:
    uid = _verify_token(token, session_id)
    url = (
        video_media_settings.AIGC_VIDEO_AGENT_URL.rstrip("/")
        + UPSTREAM_PATH
        + quote(session_id, safe="")
    )
    try:
        async with httpx.AsyncClient(
            timeout=10, trust_env=False, follow_redirects=False
        ) as client:
            response = await client.get(url, headers={"UID": uid})
            response.raise_for_status()
            return normalize_multi_style(response.json(), session_id)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise HTTPException(502, "Multi-style status unavailable") from exc


@mcp_tool(
    name="create_async_multi_video_card",
    description="Create a three-style video card and track each variant until completion.",
    server="cards",
)
@trace_async(span_name="multi_style.create_card", tracer_name=__name__)
async def create_async_multi_video_card(
    token_info: TaskTokenInfo,
    task_url: str,
    preview_title: str = "",
    progress_text: str = "",
    card_type: str = CARD_TYPE,
) -> dict[str, Any]:
    del card_type  # The source Skill passes a single-video hint; this tool owns the type.
    _validate_task_url(task_url, token_info)
    return await async_video_card_service.create(
        token_info=token_info,
        task_url=_poll_url(token_info),
        card_type=CARD_TYPE,
        preview_title=preview_title,
        progress_text=progress_text,
    )


register_async_card_url_validator(is_multi_style_poll_url)
