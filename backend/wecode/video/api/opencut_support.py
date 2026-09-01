# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Validation and merge helpers for the OpenCut bridge."""

import math
import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException

ALLOWED_MEDIA_HOST_SUFFIXES = {
    "aliyuncs.com",
    "amazonaws.com",
    "byteimg.com",
    "douyin.com",
    "douyinvod.com",
    "myqcloud.com",
    "sinaimg.cn",
    "volces.com",
    "volcvideo.com",
    "weibo.com",
    "weibocdn.com",
}
WEGENT_ATTACHMENT_PATH = "/api/attachments/download/shared"


def as_record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def as_records(value: Any) -> list[dict[str, Any]]:
    return [dict(item) for item in value or [] if isinstance(item, dict)]


def number(value: Any, default: float = 0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed == parsed else default


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def db_to_scale(volume_db: float) -> float:
    return max(0.0, min(4.0, math.pow(10, volume_db / 20)))


def _is_wegent_attachment_url(value: str, backend_public_url: str) -> bool:
    parsed = urlsplit(value)
    backend = urlsplit(backend_public_url.strip().rstrip("/"))
    return (
        parsed.scheme in {"http", "https"}
        and parsed.scheme == backend.scheme
        and parsed.netloc.lower() == backend.netloc.lower()
        and not parsed.username
        and not parsed.password
        and parsed.path == WEGENT_ATTACHMENT_PATH
        and bool(parse_qs(parsed.query).get("token"))
    )


def allowed_media_url(value: str, backend_public_url: str = "") -> str:
    if backend_public_url and _is_wegent_attachment_url(value, backend_public_url):
        return value
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.username
        or parsed.password
        or not any(
            host == suffix or host.endswith(f".{suffix}")
            for suffix in ALLOWED_MEDIA_HOST_SUFFIXES
        )
    ):
        raise HTTPException(status_code=400, detail="Unsupported OpenCut media URL")
    return value


def storycut_track_metadata(track: dict[str, Any], track_index: int) -> dict[str, Any]:
    """Preserve StoryCut track order so the renderer keeps the same z-index."""
    return {
        "storycut_track_id": str(track.get("id") or ""),
        "storycut_track_label": str(track.get("name") or track.get("label") or ""),
        "storycut_track_type": str(track.get("type") or ""),
        "storycut_track_index": track_index,
        "storycut_track_locked": bool(track.get("locked", False)),
        "storycut_track_muted": bool(track.get("muted", False)),
    }


def sort_storycut_track_items(
    tracks: dict[str, list[dict[str, Any]]],
) -> None:
    """Order saved items by StoryCut layer and then by timeline position."""

    def sort_key(item: dict[str, Any]) -> tuple[float, float]:
        window = item.get("timeline_window")
        window = window if isinstance(window, dict) else {}
        try:
            return (
                float(item.get("storycut_track_index") or 0),
                float(window.get("start") or 0),
            )
        except (TypeError, ValueError):
            return (0, 0)

    for items in tracks.values():
        items.sort(key=sort_key)


def build_refined_timeline(
    *,
    session_id: str,
    artifact_id: str,
    payload: dict[str, Any],
    original: dict[str, Any],
    tracks: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Build the lossless AIGC timeline persisted after an OpenCut save."""
    project = payload.get("project")
    project = project if isinstance(project, dict) else {}
    settings = project.get("settings")
    settings = settings if isinstance(settings, dict) else {}
    canvas = settings.get("canvasSize")
    canvas = canvas if isinstance(canvas, dict) else original.get("canvas_size")
    canvas = canvas if isinstance(canvas, dict) else {}
    width = _positive_int(canvas.get("width"))
    height = _positive_int(canvas.get("height"))
    if not width or not height:
        width, height = _canvas_from_video(tracks.get("video") or [])
    background = settings.get("background")
    background = background if isinstance(background, dict) else {}
    color = str(background.get("color") or original.get("background_color") or "")
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?", color):
        color = "#000000"
    color = color[:7]
    canvas_size = {"width": width or 1280, "height": height or 720}
    video = [
        {
            **item,
            "size": [canvas_size["width"], canvas_size["height"]],
            "render_background_color": color,
        }
        for item in tracks.get("video") or []
    ]
    return {
        "session_id": str(session_id),
        "task_id": str(artifact_id),
        "video_tracks": video,
        "subtitle_tracks": tracks.get("subtitles") or [],
        "voiceover_tracks": tracks.get("voiceover") or [],
        "bgm_tracks": tracks.get("bgm") or [],
        "mg_tracks": tracks.get("mg") or [],
        "sticker_tracks": tracks.get("stickers") or [],
        "text_animation_tracks": tracks.get("text_animations") or [],
        "transition_tracks": tracks.get("transitions") or [],
        "canvas_size": canvas_size,
        "background_color": color,
        "duration_ms": _tracks_duration_ms(tracks),
        "source": "opencut_refined",
    }


def _positive_int(value: Any) -> int:
    try:
        return max(0, min(4096, round(float(value))))
    except (TypeError, ValueError):
        return 0


def _canvas_from_video(items: list[dict[str, Any]]) -> tuple[int, int]:
    for item in items:
        size = item.get("size")
        if isinstance(size, list) and len(size) >= 2:
            width, height = _positive_int(size[0]), _positive_int(size[1])
            if width and height:
                return width, height
    return 0, 0


def _tracks_duration_ms(tracks: dict[str, list[dict[str, Any]]]) -> int:
    duration = 0.0
    for items in tracks.values():
        for item in items:
            window = item.get("timeline_window")
            if not isinstance(window, dict):
                continue
            try:
                start = float(window.get("start") or 0)
                end = float(window.get("end") or 0)
                item_duration = float(window.get("duration") or 0)
            except (TypeError, ValueError):
                continue
            duration = max(duration, end or start + item_duration)
    return max(1000, round(duration))


def validate_converted_media_tracks(
    payload: dict[str, Any], tracks: dict[str, list[dict[str, Any]]]
) -> None:
    project = payload.get("project") if isinstance(payload.get("project"), dict) else {}
    scenes = [item for item in project.get("scenes") or [] if isinstance(item, dict)]
    scene = next((item for item in scenes if item.get("isMain")), None)
    scene = scene or (scenes[0] if scenes else {})
    scene_tracks = scene.get("tracks") if isinstance(scene.get("tracks"), dict) else {}
    main = scene_tracks.get("main")
    main = main if isinstance(main, dict) else {}
    overlay = [
        item for item in scene_tracks.get("overlay") or [] if isinstance(item, dict)
    ]
    visual_count = sum(
        str(element.get("type") or "") in {"image", "video"}
        for track in [main, *overlay]
        for element in track.get("elements") or []
        if isinstance(element, dict)
    )
    audio_count = sum(
        str(element.get("type") or "") == "audio"
        for track in scene_tracks.get("audio") or []
        if isinstance(track, dict)
        for element in track.get("elements") or []
        if isinstance(element, dict)
    )
    converted_visual_count = len(tracks["video"]) + len(tracks["mg"])
    converted_audio_count = sum(
        len(tracks[kind]) for kind in ("voiceover", "bgm", "source_audio")
    )
    if converted_visual_count != visual_count:
        raise HTTPException(
            status_code=400,
            detail="OpenCut visual media metadata is incomplete",
        )
    if converted_audio_count != audio_count:
        raise HTTPException(
            status_code=400,
            detail="OpenCut audio media metadata is incomplete",
        )


def _track_identity(item: dict[str, Any]) -> list[str]:
    identities: list[str] = []
    for key in (
        "clip_id",
        "media_id",
        "unit_id",
        "voiceover_id",
        "bgm_id",
        "mg_id",
        "sticker_id",
        "storycut_element_id",
    ):
        if value := str(item.get(key) or "").strip():
            identity = f"{key}:{value}"
            if identity not in identities:
                identities.append(identity)
    for key in ("source_path", "path"):
        if value := str(item.get(key) or "").strip():
            parsed = urlsplit(value)
            source = (
                f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                if parsed.scheme and parsed.netloc
                else value.split("?", 1)[0]
            )
            identity = f"source:{source}"
            if identity not in identities:
                identities.append(identity)
    return identities


def merge_tracks_with_original(
    tracks: dict[str, list[dict[str, Any]]],
    original_tracks: dict[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    merged: dict[str, list[dict[str, Any]]] = {}
    for kind, items in tracks.items():
        originals = original_tracks.get(kind, [])
        index = {
            identity: item for item in originals for identity in _track_identity(item)
        }
        merged[kind] = []
        for item in items:
            source = next(
                (
                    index[identity]
                    for identity in _track_identity(item)
                    if identity in index
                ),
                None,
            )
            merged[kind].append({**source, **item} if source else item)
    return merged
