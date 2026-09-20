"""Translate native text templates between AIGC and OpenCut."""

import hashlib
import json
from typing import Any

from fastapi import HTTPException

from .opencut_support import as_record, number, storycut_track_metadata


def text_template_import(
    item: dict[str, Any], *, element_id: str, window: dict[str, int]
) -> dict[str, Any]:
    """Preserve the original asset metadata alongside the editable template."""
    template_id = str(item.get("template_id") or "").strip()
    if not template_id:
        raise HTTPException(422, "Text animation is missing its template ID")
    manifest = as_record(item.get("template_manifest"))
    track_id = str(item.get("storycut_track_id") or "storycut-text-templates")
    return {
        "id": element_id,
        "trackId": track_id,
        "templateId": template_id,
        "templateVersion": str(
            item.get("template_version") or manifest.get("version") or ""
        ),
        "templateManifest": manifest,
        "variables": as_record(item.get("variables")),
        "name": str(item.get("name") or manifest.get("name") or template_id),
        "timestamp": window["start"],
        "duration": window["duration"] or 3000,
        "style": {
            "positionX": number(item.get("position_x")),
            "positionY": number(item.get("position_y")),
            "scaleX": number(item.get("scale_x"), 0.6),
            "scaleY": number(item.get("scale_y"), 0.6),
            "rotate": number(item.get("rotate")),
            "opacity": number(item.get("opacity"), 1),
        },
        "metadata": {
            **item,
            "storycut_element_id": element_id,
            "storycut_track_id": track_id,
            "storycut_track_label": str(item.get("storycut_track_label") or "文字模板"),
        },
    }


def _render_key(element: dict[str, Any]) -> str:
    """Match OpenCut's stable JSON hash; duration is expressed in editor ticks."""
    duration = element.get("duration")
    if isinstance(duration, float) and duration.is_integer():
        duration = int(duration)
    value = {
        "template_id": element.get("templateId"),
        "template_version": element.get("templateVersion"),
        "variables": as_record(element.get("variables")),
        "duration": duration,
    }
    return hashlib.sha1(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def text_template_save(
    element: dict[str, Any],
    *,
    metadata: dict[str, Any],
    window: dict[str, int],
    track: dict[str, Any],
    track_index: int,
) -> dict[str, Any]:
    """Keep current edits and invalidate assets rendered from older content."""
    template_id = str(element.get("templateId") or "").strip()
    manifest = as_record(element.get("templateManifest"))
    if not template_id or not manifest:
        raise HTTPException(400, "OpenCut text template metadata is incomplete")
    render_key = _render_key(element)
    # Newly uploaded assets live inside metadata.storycut, ahead of imported data.
    asset = {
        **metadata,
        **as_record(as_record(element.get("metadata")).get("storycut")),
    }
    source = (
        str(asset.get("source_path") or "")
        if asset.get("render_key") == render_key
        else ""
    )
    params = as_record(element.get("params"))
    return {
        **metadata,
        "id": str(element.get("id") or ""),
        "storycut_element_id": str(element.get("id") or ""),
        "name": str(element.get("name") or manifest.get("name") or template_id),
        "template_id": template_id,
        "template_version": str(element.get("templateVersion") or ""),
        "template_manifest": manifest,
        "variables": as_record(element.get("variables")),
        "render_key": render_key,
        # Empty values must overwrite old paths when merging with the original.
        "source_path": source,
        "path": "",
        "url": "",
        "preview_path": "",
        "preview_url": "",
        "media_id": str(asset.get("media_id") or "") if source else "",
        "timeline_window": window,
        "kind": "text_animation",
        "loop": False,
        "position_x": number(params.get("transform.positionX")),
        "position_y": number(params.get("transform.positionY")),
        "scale_x": number(params.get("transform.scaleX"), 0.6),
        "scale_y": number(params.get("transform.scaleY"), 0.6),
        "rotate": number(params.get("transform.rotate")),
        "opacity": number(params.get("opacity"), 1),
        **storycut_track_metadata(track, track_index),
    }
