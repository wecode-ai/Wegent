# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OpenCut bridge for material-video timelines."""

import hashlib
from contextlib import suppress
from typing import Any, Optional
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.core import security
from app.core.config import settings
from app.models.user import User
from wecode.video.config.media import video_media_settings

from .opencut_support import (
    allowed_media_url,
)
from .opencut_support import as_record as _record
from .opencut_support import as_records as _records
from .opencut_support import (
    build_refined_timeline,
)
from .opencut_support import db_to_scale as _db_to_scale
from .opencut_support import (
    merge_tracks_with_original,
)
from .opencut_support import number as _number
from .opencut_support import (
    sort_storycut_track_items,
    storycut_track_metadata,
)
from .opencut_support import truthy as _truthy
from .opencut_support import (
    validate_converted_media_tracks,
)
from .opencut_urls import create_opencut_urls, verify_opencut_token

router = APIRouter()

OPENCUT_TICKS_PER_SECOND = 120000.0
MEDIA_CHUNK_SIZE = 1024 * 1024
DIRECT_MEDIA_HOST_SUFFIXES = {"sinaimg.cn", "weibocdn.com"}
DIRECT_AUDIO_KINDS = {"bgm", "voiceover", "source_audio"}


def _milliseconds(value: Any) -> int:
    if isinstance(value, dict):
        ticks = _number(value.get("ticks"))
        return max(0, round(ticks / OPENCUT_TICKS_PER_SECOND * 1000))
    return max(0, round(_number(value)))


def _opencut_milliseconds(value: Any) -> int:
    if isinstance(value, dict):
        value = value.get("ticks")
    ticks = _number(value)
    return max(0, round(ticks / OPENCUT_TICKS_PER_SECOND * 1000))


def _time_window(item: dict[str, Any], key: str = "timeline_window") -> dict[str, int]:
    window = _record(item.get(key))
    start = _milliseconds(window.get("start"))
    end = _milliseconds(window.get("end"))
    duration = _milliseconds(window.get("duration"))
    if not duration and end > start:
        duration = end - start
    if not end:
        end = start + duration
    return {"start": start, "end": end, "duration": duration}


def _element_window(element: dict[str, Any]) -> dict[str, int]:
    start = _opencut_milliseconds(element.get("startTime"))
    duration = _opencut_milliseconds(element.get("duration"))
    return {"start": start, "end": start + duration, "duration": duration}


def _stable_id(prefix: str, *values: Any) -> str:
    seed = "\0".join(str(value or "") for value in values)
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def _source(item: dict[str, Any]) -> str:
    for key in ("source_path", "path", "url"):
        value = str(item.get(key) or "").strip()
        if value:
            return value
    return ""


def _timeline_tracks(timeline: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    nested = _record(timeline.get("tracks"))

    def values(*keys: str) -> list[dict[str, Any]]:
        for key in keys:
            value = timeline.get(key)
            if isinstance(value, list):
                return _records(value)
            value = nested.get(key)
            if isinstance(value, list):
                return _records(value)
        return []

    return {
        "video": values("video_tracks", "video"),
        "subtitles": values("subtitle_tracks", "subtitles"),
        "voiceover": values("voiceover_tracks", "voiceover"),
        "bgm": values("bgm_tracks", "bgm"),
        "source_audio": values("source_audio_tracks", "source_audio"),
        "mg": values("mg_tracks", "mg"),
        "stickers": values("sticker_tracks", "stickers"),
        "text_animations": values("text_animation_tracks", "text_animations"),
        "transitions": values("transition_tracks", "transitions"),
    }


def _callback_base_url() -> str:
    value = settings.WEGENT_SOCKET_URL.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(
            status_code=503, detail="OpenCut callback URL is unavailable"
        )
    return value


def _aigc_url(path: str) -> str:
    return (
        f"{video_media_settings.AIGC_VIDEO_AGENT_URL.rstrip('/')}"
        f"/aigc_video/{path.lstrip('/')}"
    )


async def _request_aigc_json(
    *,
    method: str,
    path: str,
    uid: str,
    payload: Optional[dict[str, Any]] = None,
    params: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            response = await client.request(
                method,
                _aigc_url(path),
                headers={"UID": uid},
                json=payload,
                params=params,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail="AIGC video service is unavailable"
        ) from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)
    try:
        result = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail="AIGC video service returned invalid JSON"
        ) from exc
    return result if isinstance(result, dict) else {"result": result}


async def _fetch_timeline(
    *, session_id: str, uid: str, artifact_id: Optional[str] = None
) -> dict[str, Any]:
    params = {"task_id": artifact_id} if artifact_id else None
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            response = await client.get(
                _aigc_url(f"v2/material-video/timelines/{session_id}"),
                params=params,
                headers={"UID": uid},
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail="AIGC timeline is unavailable"
        ) from exc
    timelines = _records(_record(payload).get("tracks"))
    if artifact_id:
        matched = next(
            (
                item
                for item in reversed(timelines)
                if str(item.get("task_id") or item.get("id") or "") == artifact_id
            ),
            None,
        )
        if matched:
            return matched
        raise HTTPException(status_code=404, detail="Timeline artifact not found")
    if not timelines:
        raise HTTPException(status_code=404, detail="No editable timeline found")
    return timelines[-1]


async def _update_timeline(
    *,
    session_id: str,
    artifact_id: str,
    uid: str,
    payload: dict[str, Any],
    original: dict[str, Any],
    tracks: dict[str, Any],
) -> dict[str, Any]:
    timeline = build_refined_timeline(
        session_id=session_id,
        artifact_id=artifact_id,
        payload=payload,
        original=original,
        tracks=tracks,
    )
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            response = await client.post(
                _aigc_url("v2/material-video/local-timelines"),
                headers={"UID": uid},
                json={
                    "session_id": str(session_id),
                    "task_id": str(artifact_id),
                    "timeline": timeline,
                },
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail="AIGC timeline save failed"
        ) from exc
    return _record(payload)


def _aspect_ratio(timeline: dict[str, Any], tracks: dict[str, Any]) -> str:
    canvas = _record(timeline.get("canvas_size"))
    width = _number(canvas.get("width"))
    height = _number(canvas.get("height"))
    if not width or not height:
        for item in tracks["video"]:
            size = item.get("size")
            if isinstance(size, list) and len(size) >= 2:
                width, height = _number(size[0]), _number(size[1])
                if width and height:
                    break
    if not width or not height:
        return "9:16"
    ratio = width / height
    candidates = {
        "16:9": 16 / 9,
        "9:16": 9 / 16,
        "1:1": 1,
        "4:3": 4 / 3,
        "3:4": 3 / 4,
    }
    return min(candidates, key=lambda key: abs(candidates[key] - ratio))


def _media_proxy_url(
    *, callback_base: str, session_id: str, media_id: str, token: str
) -> str:
    return (
        f"{callback_base}/api/aigc-video/material-video/opencut/media/"
        f"{quote(str(session_id), safe='')}/{quote(media_id, safe='')}"
        f"?token={quote(token, safe='')}"
    )


def _opencut_resource_proxy_url(source: str) -> str:
    return f"/api/storycut/media-proxy?url={quote(source, safe='')}"


def _is_direct_media_source(source: str) -> bool:
    parsed = urlsplit(source)
    host = (parsed.hostname or "").lower()
    return parsed.scheme in {"http", "https"} and any(
        host == suffix or host.endswith(f".{suffix}")
        for suffix in DIRECT_MEDIA_HOST_SUFFIXES
    )


def _https_media_source(source: str) -> str:
    parsed = urlsplit(source)
    if parsed.scheme != "http":
        return source
    return urlunsplit(parsed._replace(scheme="https"))


def _should_proxy_media(kind: str, source: str) -> bool:
    if kind == "video":
        return False
    if kind in DIRECT_AUDIO_KINDS and _is_direct_media_source(source):
        return False
    return True


def _browser_media_source(
    *, kind: str, public_source: str, original_source: str
) -> str:
    if kind in {"image", "video", *DIRECT_AUDIO_KINDS}:
        for source in (public_source, original_source):
            if _is_direct_media_source(source):
                return _https_media_source(source)
    return public_source


def _media_item(
    *,
    item: dict[str, Any],
    kind: str,
    project_id: str,
    session_id: str,
    token: str,
    callback_base: str,
    index: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    source = _source(item)
    identity = item.get("media_id") or item.get("clip_id") or source or index
    media_id = _stable_id(kind, identity, index)
    proxy_url = _media_proxy_url(
        callback_base=callback_base,
        session_id=session_id,
        media_id=media_id,
        token=token,
    )
    public_source = proxy_url if _should_proxy_media(kind, source) else source
    browser_source = _browser_media_source(
        kind=kind,
        public_source=public_source,
        original_source=source,
    )
    browser_safe_original_source = (
        _https_media_source(source) if _is_direct_media_source(source) else source
    )
    storycut_source = browser_safe_original_source
    if (
        kind == "image"
        and str(item.get("clip_id") or "").startswith("wegent-attachment-")
        and urlsplit(source).scheme == "http"
        and public_source != source
    ):
        storycut_source = _opencut_resource_proxy_url(public_source)
    source_window = _time_window(item, "source_window")
    timeline_window = _time_window(item)
    duration = source_window["duration"] or timeline_window["duration"] or 3000
    size = item.get("size") if isinstance(item.get("size"), list) else []
    metadata: dict[str, Any] = {
        "name": str(item.get("clip_id") or item.get("media_id") or media_id),
        "duration": duration / 1000,
        "media_type": kind,
        "url": browser_source,
        "originalSourceUrl": browser_safe_original_source,
        "storycut": {
            "source": storycut_source,
            "sourceUrl": storycut_source,
            "browserSafeSource": browser_source,
            "metadata": dict(item),
        },
    }
    if public_source != source:
        metadata["proxySourceUrl"] = public_source
        metadata["storycut"]["proxySource"] = public_source
        metadata["storycut"]["proxySourceUrl"] = public_source
    if len(size) >= 2:
        metadata.update({"width": size[0], "height": size[1]})
    media_type = "music" if kind == "bgm" else kind
    if media_type not in {"image", "video", "mg", "music", "voiceover", "audio"}:
        media_type = "video"
    return (
        {
            "id": media_id,
            "kind": "uploaded",
            "projectId": project_id,
            "mediaType": media_type,
            "status": "completed",
            "createdAt": 0,
            "url": browser_source,
            "metadata": metadata,
        },
        {
            "media_id": media_id,
            "source": source,
            "proxy_url": proxy_url,
            "duration": duration,
        },
    )


def _subtitle_style(value: Any) -> dict[str, Any]:
    source = _record(value)
    font_size = _number(source.get("fontSize") or source.get("font_size"), 36)
    if font_size > 12:
        font_size /= 6
    return {
        "fontSize": font_size,
        "fontFamily": str(
            source.get("fontFamily")
            or source.get("font_family")
            or source.get("font_name")
            or "Noto Sans CJK SC"
        ),
        "color": str(source.get("color") or source.get("font_color") or "#ffffff"),
        "textAlign": str(
            source.get("textAlign") or source.get("text_align") or "center"
        ),
        "fontWeight": str(
            source.get("fontWeight") or source.get("font_weight") or "bold"
        ),
        "fontStyle": str(
            source.get("fontStyle") or source.get("font_style") or "normal"
        ),
        "textDecoration": str(source.get("textDecoration") or "none"),
        "letterSpacing": _number(source.get("letterSpacing"), 0),
        "lineHeight": _number(source.get("lineHeight"), 1.2),
        "background": _record(source.get("background"))
        or {"enabled": False, "color": "#000000"},
        "placement": _record(source.get("placement"))
        or {
            "verticalAlign": "bottom",
            "horizontalAlign": "center",
            "marginVerticalRatio": 0.12,
            "widthRatio": 0.88,
        },
    }


def _sticker_lanes(stickers: list[dict[str, Any]]) -> list[tuple[dict[str, Any], int]]:
    lane_ends: list[int] = []
    assigned: list[tuple[dict[str, Any], int]] = []
    for item in sorted(stickers, key=lambda value: _time_window(value)["start"]):
        window = _time_window(item)
        lane = next(
            (
                index
                for index, lane_end in enumerate(lane_ends)
                if lane_end <= window["start"]
            ),
            len(lane_ends),
        )
        if lane == len(lane_ends):
            lane_ends.append(window["end"])
        else:
            lane_ends[lane] = window["end"]
        assigned.append((item, lane))
    return assigned


def build_storycut_bundle(
    *, timeline: dict[str, Any], session_id: str, uid: str, token: str
) -> dict[str, Any]:
    """Convert one AIGC material timeline into the OpenCut import schema."""
    tracks = _timeline_tracks(timeline)
    artifact_id = str(timeline.get("task_id") or timeline.get("id") or "")
    project_id = _stable_id("wegent", session_id, artifact_id)
    callback_base = _callback_base_url()
    media: list[dict[str, Any]] = []
    keyframes: list[dict[str, Any]] = []
    track_defs: list[dict[str, Any]] = []
    media_index = 0

    track_specs = (
        ("video", "storycut-main-video", "video", "视频"),
        ("mg", "storycut-mg", "mg", "MG 动画"),
        ("bgm", "storycut-bgm", "music", "BGM"),
        ("voiceover", "storycut-voiceover", "voiceover", "配音"),
        ("source_audio", "storycut-source-audio", "audio", "原声"),
    )
    for source_kind, track_id, track_type, label in track_specs:
        items = tracks[source_kind]
        if not items and source_kind in {"mg", "source_audio"}:
            continue
        track_defs.append(
            {
                "id": track_id,
                "locked": False,
                "label": label,
                "type": track_type,
                "muted": False,
                "projectId": project_id,
            }
        )
        for index, item in enumerate(items, 1):
            source = _source(item)
            if not source:
                continue
            media_index += 1
            visual_kind = str(item.get("kind") or source_kind)
            media_kind = visual_kind if source_kind in {"video", "mg"} else source_kind
            media_item, reference = _media_item(
                item=item,
                kind=media_kind,
                project_id=project_id,
                session_id=session_id,
                token=token,
                callback_base=callback_base,
                index=media_index,
            )
            media.append(media_item)
            window = _time_window(item)
            element_id = str(
                item.get("storycut_element_id")
                or item.get("element_id")
                or _stable_id(source_kind, reference["media_id"], index)
            )
            data_type = (
                "music"
                if source_kind == "bgm"
                else (
                    "audio"
                    if source_kind == "source_audio"
                    else source_kind if source_kind != "video" else visual_kind
                )
            )
            keyframes.append(
                {
                    "id": element_id,
                    "trackId": track_id,
                    "timestamp": window["start"],
                    "duration": window["duration"] or reference["duration"],
                    "data": {
                        "type": data_type,
                        "mediaId": reference["media_id"],
                        "prompt": str(
                            item.get("prompt")
                            or item.get("clip_id")
                            or item.get("media_id")
                            or label
                        ),
                        "url": reference["proxy_url"],
                    },
                    "metadata": {
                        **item,
                        "storycut": {
                            "trackKind": source_kind,
                            "metadata": dict(item),
                        },
                        "sourceWindow": _time_window(item, "source_window"),
                    },
                }
            )

    subtitles = []
    track_defs.append(
        {
            "id": "storycut-subtitles",
            "locked": False,
            "label": "字幕",
            "type": "text",
            "projectId": project_id,
        }
    )
    for index, item in enumerate(tracks["subtitles"], 1):
        window = _time_window(item)
        subtitles.append(
            {
                "id": str(item.get("unit_id") or _stable_id("subtitle", index)),
                "text": str(item.get("text") or ""),
                "timestamp": window["start"],
                "duration": window["duration"],
                "style": _subtitle_style(item.get("style")),
                "trackId": "storycut-subtitles",
                "metadata": {
                    **item,
                    "storycut_track_id": "storycut-subtitles",
                    "storycut_track_label": "字幕",
                },
            }
        )

    stickers = []
    lanes = _sticker_lanes(tracks["stickers"])
    for lane in sorted({lane for _, lane in lanes}):
        track_defs.append(
            {
                "id": (
                    "storycut-stickers"
                    if lane == 0
                    else f"storycut-stickers-{lane + 1}"
                ),
                "locked": False,
                "label": "贴纸" if lane == 0 else f"贴纸 {lane + 1}",
                "type": "sticker",
                "projectId": project_id,
            }
        )
    for index, (item, lane) in enumerate(lanes, 1):
        window = _time_window(item)
        track_id = "storycut-stickers" if lane == 0 else f"storycut-stickers-{lane + 1}"
        style = {
            "positionX": _number(item.get("position_x")),
            "positionY": _number(item.get("position_y")),
            "scaleX": _number(item.get("scale_x"), 1),
            "scaleY": _number(item.get("scale_y"), 1),
            "rotate": _number(item.get("rotate")),
            "opacity": _number(item.get("opacity"), 1),
        }
        stickers.append(
            {
                "id": str(
                    item.get("storycut_element_id")
                    or item.get("id")
                    or _stable_id("sticker", index)
                ),
                "trackId": track_id,
                "stickerId": str(item.get("sticker_id") or item.get("stickerId") or ""),
                "name": str(item.get("name") or "贴纸"),
                "timestamp": window["start"],
                "duration": window["duration"] or 3000,
                "style": style,
                "intrinsicWidth": round(_number(item.get("intrinsic_width"), 640)),
                "intrinsicHeight": round(_number(item.get("intrinsic_height"), 640)),
                "sourcePath": str(item.get("source_path") or ""),
                "metadata": {**item, "storycut_track_id": track_id},
            }
        )

    duration = max(
        [
            int(item.get("timestamp") or 0) + int(item.get("duration") or 0)
            for item in [*keyframes, *subtitles, *stickers]
        ]
        or [0]
    )
    return {
        "schema": "storycut.videosos-import",
        "version": 1,
        "project": {
            "id": project_id,
            "title": "时间线编辑",
            "description": "素材视频时间线",
            "aspectRatio": _aspect_ratio(timeline, tracks),
            "duration": duration,
            "metadata": {
                "source": "素材视频",
                "sourceSessionId": str(session_id),
                "sourceArtifactId": artifact_id,
                "sourceNodeId": "plan_timeline",
                "uid": str(uid),
                "timelineDbId": timeline.get("id"),
            },
        },
        "media": media,
        "tracks": track_defs,
        "keyframes": keyframes,
        "subtitles": subtitles,
        "stickers": stickers,
        "textTemplates": tracks["text_animations"],
        "transitions": tracks["transitions"],
    }


def _original_metadata(value: Any) -> dict[str, Any]:
    record = _record(value)
    metadata = _record(record.get("metadata"))
    metadata_storycut = _record(metadata.get("storycut"))
    storycut = _record(record.get("storycut"))
    return {
        **storycut,
        **_record(storycut.get("metadata")),
        **metadata_storycut,
        **_record(metadata_storycut.get("metadata")),
        **metadata,
    }


def _media_source(media: dict[str, Any]) -> str:
    metadata = _original_metadata(media)
    for value in (
        metadata.get("originalSourceUrl"),
        metadata.get("original_source_url"),
        metadata.get("source"),
        metadata.get("sourceUrl"),
        metadata.get("source_url"),
        metadata.get("source_path"),
        metadata.get("path"),
        media.get("url"),
    ):
        source = str(value or "").strip()
        if source and "/material-video/opencut/media/" not in source:
            return source
    return ""


def _scene_tracks(payload: dict[str, Any]) -> dict[str, Any]:
    project = _record(payload.get("project"))
    scenes = _records(project.get("scenes"))
    scene = next((item for item in scenes if item.get("isMain")), None)
    return _record((scene or (scenes[0] if scenes else {})).get("tracks"))


def _source_window_from_element(
    element: dict[str, Any], metadata: dict[str, Any]
) -> dict[str, int]:
    trim_start = _opencut_milliseconds(element.get("trimStart"))
    duration = _opencut_milliseconds(element.get("duration"))
    retime = _record(element.get("retime"))
    rate = max(0.01, _number(retime.get("rate") or metadata.get("playback_rate"), 1))
    source_duration = round(duration * rate)
    return {
        "start": trim_start,
        "end": trim_start + source_duration,
        "duration": source_duration,
    }


def _visual_item(
    element: dict[str, Any],
    track: dict[str, Any],
    media_by_id: dict[str, dict[str, Any]],
    track_index: int,
) -> Optional[dict[str, Any]]:
    media = media_by_id.get(str(element.get("mediaId") or ""), {})
    source = _media_source(media)
    if not source:
        return None
    metadata = {**_original_metadata(media), **_original_metadata(element)}
    kind = (
        "mg"
        if str(track.get("type") or "") == "mg"
        else str(element.get("type") or "video")
    )
    params = _record(element.get("params"))
    element_muted = _truthy(params.get("muted"))
    track_muted = _truthy(track.get("muted"))
    volume_db = _number(params.get("volume"))
    muted = element_muted or track_muted
    result = {
        **metadata,
        "clip_id": str(metadata.get("clip_id") or element.get("id") or ""),
        "media_id": str(
            metadata.get("media_id")
            or metadata.get("clip_id")
            or element.get("id")
            or ""
        ),
        "kind": kind,
        "source_window": _source_window_from_element(element, metadata),
        "timeline_window": _element_window(element),
        "playback_rate": max(
            0.01, _number(_record(element.get("retime")).get("rate"), 1)
        ),
        "keep_audio": not muted
        and bool(
            element.get("isSourceAudioEnabled", metadata.get("keep_audio", False))
        ),
        "volume_db": volume_db,
        "volume_scale": 0.0 if muted else _db_to_scale(volume_db),
        "muted": muted,
        "element_id": str(element.get("id") or ""),
        "storycut_track_muted": track_muted,
        "storycut_element_muted": element_muted,
        "storycut_element_id": str(element.get("id") or ""),
        **storycut_track_metadata(track, track_index),
    }
    if kind == "mg":
        result["path"] = source
    else:
        result["source_path"] = source
    for source_key, target_key in (
        ("transform.positionX", "position_x"),
        ("transform.positionY", "position_y"),
        ("transform.scaleX", "scale_x"),
        ("transform.scaleY", "scale_y"),
        ("transform.rotate", "rotate"),
        ("opacity", "opacity"),
    ):
        if source_key in params:
            result[target_key] = params[source_key]
    return result


def _subtitle_item(
    element: dict[str, Any], track: dict[str, Any], track_index: int
) -> Optional[dict[str, Any]]:
    params = _record(element.get("params"))
    text = str(params.get("content") or element.get("name") or "").strip()
    if not text:
        return None
    metadata = _original_metadata(element)
    style = _record(metadata.get("style"))
    for key in (
        "fontSize",
        "fontFamily",
        "color",
        "textAlign",
        "fontWeight",
        "fontStyle",
        "textDecoration",
        "letterSpacing",
        "lineHeight",
    ):
        if key in params:
            style[key] = params[key]
    return {
        **metadata,
        "unit_id": str(metadata.get("unit_id") or element.get("id") or ""),
        "text": text,
        "timeline_window": _element_window(element),
        "style": style,
        **storycut_track_metadata(track, track_index),
    }


def _sticker_item(
    element: dict[str, Any], track: dict[str, Any], track_index: int
) -> Optional[dict[str, Any]]:
    metadata = _original_metadata(element)
    sticker_id = str(element.get("stickerId") or metadata.get("sticker_id") or "")
    if not sticker_id:
        return None
    params = _record(element.get("params"))
    return {
        **metadata,
        "id": str(element.get("id") or sticker_id),
        "sticker_id": sticker_id,
        "name": str(element.get("name") or metadata.get("name") or "贴纸"),
        "source_path": str(metadata.get("source_path") or ""),
        "timeline_window": _element_window(element),
        "intrinsic_width": round(_number(element.get("intrinsicWidth"), 640)),
        "intrinsic_height": round(_number(element.get("intrinsicHeight"), 640)),
        "position_x": _number(params.get("transform.positionX")),
        "position_y": _number(params.get("transform.positionY")),
        "scale_x": _number(params.get("transform.scaleX"), 1),
        "scale_y": _number(params.get("transform.scaleY"), 1),
        "rotate": _number(params.get("transform.rotate")),
        "opacity": _number(params.get("opacity"), 1),
        "storycut_element_id": str(element.get("id") or ""),
        **storycut_track_metadata(track, track_index),
    }


def _audio_item(
    element: dict[str, Any],
    track: dict[str, Any],
    media_by_id: dict[str, dict[str, Any]],
    track_index: int,
) -> Optional[dict[str, Any]]:
    media = media_by_id.get(str(element.get("mediaId") or ""), {})
    source = _media_source(media)
    if not source:
        return None
    metadata = {**_original_metadata(media), **_original_metadata(element)}
    params = _record(element.get("params"))
    element_muted = _truthy(params.get("muted"))
    track_muted = _truthy(track.get("muted"))
    volume_db = _number(params.get("volume"))
    volume_scale = 0.0 if element_muted or track_muted else _db_to_scale(volume_db)
    identity = str(
        metadata.get("media_id") or metadata.get("clip_id") or element.get("id") or ""
    )
    return {
        **metadata,
        "media_id": identity,
        "clip_id": str(metadata.get("clip_id") or identity),
        "path": source,
        "source_window": _source_window_from_element(element, metadata),
        "timeline_window": _element_window(element),
        "playback_rate": max(
            0.01, _number(_record(element.get("retime")).get("rate"), 1)
        ),
        "volume_db": volume_db,
        "volume_scale": volume_scale,
        "muted": element_muted or track_muted,
        "storycut_track_muted": track_muted,
        "storycut_element_muted": element_muted,
        "storycut_element_id": str(element.get("id") or ""),
        **storycut_track_metadata(track, track_index),
    }


def storycut_payload_to_tracks(
    payload: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """Convert an OpenCut save payload back to the AIGC material schema."""
    scene_tracks = _scene_tracks(payload)
    media_by_id = {
        str(item.get("id")): item
        for item in _records(payload.get("media"))
        if item.get("id")
    }
    result: dict[str, list[dict[str, Any]]] = {
        "video": [],
        "subtitles": [],
        "voiceover": [],
        "bgm": [],
        "source_audio": [],
        "mg": [],
        "stickers": [],
        "text_animations": [],
        "transitions": _records(payload.get("transitions")),
    }
    main = scene_tracks.get("main")
    if isinstance(main, dict):
        for element in _records(main.get("elements")):
            item = _visual_item(element, main, media_by_id, 0)
            if item:
                result["video"].append(item)
    for track_index, track in enumerate(_records(scene_tracks.get("overlay")), 1):
        for element in _records(track.get("elements")):
            element_type = str(element.get("type") or "")
            if element_type == "text":
                item = _subtitle_item(element, track, track_index)
                if item:
                    result["subtitles"].append(item)
            elif element_type == "sticker":
                item = _sticker_item(element, track, track_index)
                if item:
                    result["stickers"].append(item)
            elif element_type == "text-template":
                result["text_animations"].append(
                    {
                        **_original_metadata(element),
                        "timeline_window": _element_window(element),
                    }
                )
            else:
                item = _visual_item(element, track, media_by_id, track_index)
                if item:
                    result["mg" if item.get("kind") == "mg" else "video"].append(item)
    for track_index, track in enumerate(_records(scene_tracks.get("audio")), 1):
        hint = f"{track.get('id', '')} {track.get('name', '')} {track.get('type', '')}".lower()
        target = (
            "voiceover"
            if "voice" in hint or "配音" in hint
            else "source_audio" if "source" in hint or "原声" in hint else "bgm"
        )
        for element in _records(track.get("elements")):
            item = _audio_item(element, track, media_by_id, track_index)
            if item:
                result[target].append(item)
    sort_storycut_track_items(result)
    return result


@router.get("/material-video/opencut/open/{session_id}")
async def get_opencut_open_url(
    session_id: str,
    artifact_id: Optional[str] = Query(None),
    current_user: User = Depends(security.get_current_user),
) -> dict[str, Any]:
    uid = str(current_user.user_name or current_user.id)
    timeline = await _fetch_timeline(
        session_id=session_id,
        uid=uid,
        artifact_id=artifact_id,
    )
    resolved_artifact_id = str(timeline.get("task_id") or timeline.get("id") or "")
    if not resolved_artifact_id:
        raise HTTPException(status_code=404, detail="Timeline artifact is missing")
    urls = create_opencut_urls(
        callback_base=_callback_base_url(),
        session_id=session_id,
        artifact_id=resolved_artifact_id,
        uid=uid,
        user_id=current_user.id,
    )
    return {
        "session_id": str(session_id),
        "artifact_id": resolved_artifact_id,
        "timeline_id": timeline.get("id"),
        "open_url": urls["open_url"],
    }


@router.get("/material-video/opencut/import/{session_id}")
async def import_opencut_timeline(session_id: str, token: str) -> dict[str, Any]:
    token_payload = verify_opencut_token(token, session_id)
    timeline = await _fetch_timeline(
        session_id=session_id,
        uid=str(token_payload["uid"]),
        artifact_id=str(token_payload["artifact_id"]),
    )
    return build_storycut_bundle(
        timeline=timeline,
        session_id=session_id,
        uid=str(token_payload["uid"]),
        token=token,
    )


@router.post("/material-video/opencut/save/{session_id}")
async def save_opencut_timeline(
    session_id: str,
    token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    token_payload = verify_opencut_token(token, session_id)
    if payload.get("schema") != "storycut.opencut-refined":
        raise HTTPException(status_code=400, detail="Unsupported OpenCut save schema")
    source = _record(payload.get("source"))
    if source.get("sourceSessionId") and str(source["sourceSessionId"]) != session_id:
        raise HTTPException(status_code=400, detail="OpenCut save session mismatch")
    artifact_id = str(token_payload["artifact_id"])
    if (
        source.get("sourceArtifactId")
        and str(source["sourceArtifactId"]) != artifact_id
    ):
        raise HTTPException(status_code=400, detail="OpenCut save artifact mismatch")
    original = await _fetch_timeline(
        session_id=session_id,
        uid=str(token_payload["uid"]),
        artifact_id=artifact_id,
    )
    converted_tracks = storycut_payload_to_tracks(payload)
    validate_converted_media_tracks(payload, converted_tracks)
    tracks = merge_tracks_with_original(converted_tracks, _timeline_tracks(original))
    saved = await _update_timeline(
        session_id=session_id,
        artifact_id=artifact_id,
        uid=str(token_payload["uid"]),
        payload=payload,
        original=original,
        tracks=tracks,
    )
    return {
        "ok": True,
        "session_id": str(session_id),
        "artifact_id": artifact_id,
        "aigc_sync": saved,
    }


@router.post("/material-video/opencut/bgm/{session_id}")
async def generate_opencut_bgm(
    session_id: str,
    token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    token_payload = verify_opencut_token(token, session_id)
    generate_payload = payload.get("generateBgmPayload")
    if not isinstance(generate_payload, dict):
        raise HTTPException(status_code=400, detail="generateBgmPayload is required")
    result = await _request_aigc_json(
        method="POST",
        path="v2/material-video/generate-bgm-segment",
        uid=str(token_payload["uid"]),
        payload={**generate_payload, "session_id": str(session_id)},
    )
    return {"bgm": result}


@router.get("/material-video/opencut/bgm/{session_id}")
async def get_opencut_bgm(
    session_id: str,
    token: str,
    task_id: str,
) -> dict[str, Any]:
    token_payload = verify_opencut_token(token, session_id)
    return await _request_aigc_json(
        method="GET",
        path=f"v2/material-video/generate-bgm-segment/{quote(session_id, safe='')}",
        uid=str(token_payload["uid"]),
        params={"task_id": task_id},
    )


@router.get("/material-video/opencut/media/{session_id}/{media_id}")
async def stream_opencut_media(
    session_id: str,
    media_id: str,
    token: str,
    range_header: Optional[str] = Header(None, alias="Range"),
) -> StreamingResponse:
    token_payload = verify_opencut_token(token, session_id)
    timeline = await _fetch_timeline(
        session_id=session_id,
        uid=str(token_payload["uid"]),
        artifact_id=str(token_payload["artifact_id"]),
    )
    bundle = build_storycut_bundle(
        timeline=timeline,
        session_id=session_id,
        uid=str(token_payload["uid"]),
        token=token,
    )
    media = next(
        (
            item
            for item in _records(bundle.get("media"))
            if str(item.get("id")) == media_id
        ),
        None,
    )
    if media is None:
        raise HTTPException(status_code=404, detail="OpenCut media not found")
    source = allowed_media_url(
        _media_source(media),
        settings.WEGENT_BACKEND_PUBLIC_URL,
    )
    client = httpx.AsyncClient(timeout=120, trust_env=False, follow_redirects=False)
    stream = client.stream(
        "GET", source, headers={"Range": range_header} if range_header else {}
    )
    try:
        response = await stream.__aenter__()
        response.raise_for_status()
    except Exception as exc:
        with suppress(Exception):
            await stream.__aexit__(type(exc), exc, exc.__traceback__)
        await client.aclose()
        raise HTTPException(
            status_code=502, detail="OpenCut media is unavailable"
        ) from exc

    async def chunks():
        try:
            async for chunk in response.aiter_bytes(MEDIA_CHUNK_SIZE):
                if chunk:
                    yield chunk
        finally:
            await stream.__aexit__(None, None, None)
            await client.aclose()

    headers = {"Accept-Ranges": response.headers.get("accept-ranges", "bytes")}
    for name in ("content-length", "content-range"):
        if value := response.headers.get(name):
            headers[name] = value
    return StreamingResponse(
        chunks(),
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/octet-stream"),
        headers=headers,
    )
