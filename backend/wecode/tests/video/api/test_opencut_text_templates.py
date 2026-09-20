"""Native text templates must survive import, editing, and save."""

import copy
import hashlib
import json

import pytest
from fastapi import HTTPException

from wecode.video.api.opencut import build_storycut_bundle, storycut_payload_to_tracks
from wecode.video.api.opencut_support import merge_tracks_with_original


def _animation():
    return {
        "storycut_element_id": "animation-1",
        "template_id": "minimalist/paw-diary-title",
        "template_manifest": {
            "id": "minimalist/paw-diary-title",
            "version": "1.0.0",
            "name": "Paw diary",
            "variables": {"title": {"default": "Diary"}},
        },
        "variables": {"title": "小猫日记"},
        "source_path": "https://wx1.sinaimg.cn/large/original.gif",
        "timeline_window": {"start": 2000, "end": 5000, "duration": 3000},
        "position_x": 80,
        "position_y": -100,
        "scale_x": 0.6,
        "scale_y": 0.7,
        "rotate": 5,
        "opacity": 0.8,
        "storycut_track_id": "text-custom-lane",
        "storycut_track_label": "Title",
        "storycut_track_locked": True,
    }


def _bundle(monkeypatch, item):
    monkeypatch.setattr(
        "wecode.video.api.opencut._callback_base_url", lambda: "https://wegent.test"
    )
    return build_storycut_bundle(
        timeline={"task_id": "plan-1", "text_animation_tracks": [item]},
        session_id="test-1",
        uid="tester",
        token="test-token",
    )


def _payload(template):
    element = {
        "id": template["id"],
        "type": "text-template",
        "templateId": template["templateId"],
        "templateVersion": template["templateVersion"],
        "templateManifest": template["templateManifest"],
        "variables": copy.deepcopy(template["variables"]),
        "startTime": template["timestamp"] * 120,
        "duration": template["duration"] * 120,
        "params": {
            ("opacity" if k == "opacity" else "transform." + k): v
            for k, v in template["style"].items()
        },
        "metadata": copy.deepcopy(template["metadata"]),
    }
    # OpenCut import assigns a key to the unchanged pre-rendered asset.
    element["metadata"]["render_key"] = hashlib.sha1(
        json.dumps(
            {
                "template_id": element["templateId"],
                "template_version": element["templateVersion"],
                "variables": element["variables"],
                "duration": element["duration"],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    track = {
        "id": template["trackId"],
        "type": "text",
        "name": "Title",
        "locked": True,
        "elements": [element],
    }
    return {
        "project": {"scenes": [{"isMain": True, "tracks": {"overlay": [track]}}]}
    }, element


def test_import_translates_schema_and_preserves_metadata(monkeypatch):
    item = _animation()
    original = copy.deepcopy(item)
    bundle = _bundle(monkeypatch, item)
    template = bundle["textTemplates"][0]
    assert template["templateId"] == item["template_id"]
    assert template["templateVersion"] == "1.0.0"
    assert template["variables"] == item["variables"]
    assert template["templateManifest"] == item["template_manifest"]
    assert template["timestamp"] == 2000
    assert template["duration"] == 3000
    assert template["style"]["positionY"] == -100
    assert template["style"]["scaleY"] == 0.7
    assert template["metadata"]["source_path"] == item["source_path"]
    assert bundle["project"]["duration"] == 5000
    assert (
        next(t for t in bundle["tracks"] if t["id"] == "text-custom-lane")["locked"]
        is True
    )
    assert item == original


def test_unchanged_template_roundtrip_keeps_asset(monkeypatch):
    original = _animation()
    payload, _ = _payload(_bundle(monkeypatch, original)["textTemplates"][0])
    tracks = storycut_payload_to_tracks(payload)
    saved = tracks["text_animations"][0]
    for key in (
        "template_id",
        "variables",
        "timeline_window",
        "position_x",
        "position_y",
        "scale_x",
        "scale_y",
        "rotate",
        "opacity",
        "source_path",
        "storycut_element_id",
    ):
        assert saved[key] == original[key]
    assert saved["kind"] == "text_animation"
    assert saved["storycut_track_id"] == "text-custom-lane"
    assert saved["storycut_track_index"] == 1
    assert saved["storycut_track_locked"] is True
    assert tracks["subtitles"] == []
    assert tracks["video"] == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("variables", {"title": "新文案"}),
        ("duration", 480000),
        ("templateId", "new-template"),
        ("templateVersion", "2.0.0"),
    ],
)
def test_content_edits_invalidate_old_asset_even_after_merge(monkeypatch, field, value):
    original = _animation()
    payload, element = _payload(_bundle(monkeypatch, original)["textTemplates"][0])
    element[field] = value
    element["startTime"] = 120000
    element["params"]["transform.positionX"] = 250
    result = merge_tracks_with_original(
        storycut_payload_to_tracks(payload), {"text_animations": [original]}
    )
    saved = result["text_animations"][0]
    assert saved["source_path"] == ""
    assert saved["variables"] == element["variables"]
    assert saved["template_id"] == element["templateId"]
    assert saved["template_version"] == element["templateVersion"]
    assert saved["timeline_window"]["start"] == 1000
    assert saved["timeline_window"]["duration"] == element["duration"] / 120
    assert saved["position_x"] == 250


def test_latest_uploaded_asset_overrides_imported_metadata(monkeypatch):
    payload, element = _payload(_bundle(monkeypatch, _animation())["textTemplates"][0])
    element["metadata"]["storycut"] = {
        "render_key": element["metadata"]["render_key"],
        "source_path": "https://wx1.sinaimg.cn/large/latest.gif",
        "media_id": "new-pid",
    }
    saved = storycut_payload_to_tracks(payload)["text_animations"][0]
    assert saved["source_path"].endswith("/latest.gif")
    assert saved["media_id"] == "new-pid"


def test_explicit_template_deletion_is_not_restored(monkeypatch):
    original = _animation()
    payload, _ = _payload(_bundle(monkeypatch, original)["textTemplates"][0])
    payload["project"]["scenes"][0]["tracks"]["overlay"][0]["elements"] = []
    merged = merge_tracks_with_original(
        storycut_payload_to_tracks(payload), {"text_animations": [original]}
    )
    assert merged["text_animations"] == []


def test_invalid_template_is_rejected_instead_of_silently_dropped(monkeypatch):
    item = _animation()
    item["template_id"] = ""
    with pytest.raises(HTTPException) as error:
        _bundle(monkeypatch, item)
    assert error.value.status_code == 422
    payload, element = _payload(_bundle(monkeypatch, _animation())["textTemplates"][0])
    element["templateId"] = ""
    with pytest.raises(HTTPException) as error:
        storycut_payload_to_tracks(payload)
    assert error.value.status_code == 400
