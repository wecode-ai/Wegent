from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException

from app.mcp_server.auth import TaskTokenInfo
from app.services.execution.agents.video.async_card import normalize_async_card_payload
from wecode.video.api import multi_style as module


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(
        module.settings, "WEGENT_BACKEND_PUBLIC_URL", "http://127.0.0.1:8500"
    )
    monkeypatch.setattr(
        module.video_media_settings, "AIGC_VIDEO_AGENT_URL", "http://aigc.test/2"
    )
    return TaskTokenInfo(task_id=137, subtask_id=300, user_id=2, user_name="tester")


def variants(statuses):
    return [
        {
            "sub_task_id": f"137_{i + 1}",
            "status": state,
            "video_url": (
                "https://video.weibocdn.com/test.mp4" if state == "completed" else ""
            ),
            "duration_ms": 12000,
        }
        for i, state in enumerate(statuses)
    ]


@pytest.mark.parametrize(
    "states,parent,expected",
    [
        (["pending"] * 3, 1, "processing"),
        (["completed", "processing", "failed"], 1, "partial_ready"),
        (["completed", "failed", "completed"], 2, "completed"),
        (["failed"] * 3, -1, "failed"),
    ],
)
def test_adapts_to_shared_protocol_without_dropping_variants(states, parent, expected):
    raw = {"status": parent, "wb_data": variants(states), "progress": 60}
    result = normalize_async_card_payload(module.normalize_multi_style(raw, "137"))
    assert result.status == expected
    assert len(result.card["videos"]) == 3
    assert result.card["videos"][0]["duration"] == 12


def test_editor_callback_can_bypass_frontend_same_origin_proxy(monkeypatch):
    from wecode.video.api.opencut import _callback_base_url

    monkeypatch.setattr(module.settings, "FRONTEND_URL", "http://frontend.test")
    monkeypatch.setattr(module.video_media_settings, "OPENCUT_CALLBACK_URL", "")
    assert _callback_base_url() == "http://frontend.test"
    monkeypatch.setattr(
        module.video_media_settings, "OPENCUT_CALLBACK_URL", "https://backend.test/"
    )
    assert _callback_base_url() == "https://backend.test"


@pytest.mark.parametrize("child", ["138_1", "137_4", "../137_1", "137_1/other"])
def test_rejects_foreign_or_invalid_variants(child):
    with pytest.raises(ValueError):
        module.normalize_multi_style(
            {"status": 2, "wb_data": [{"sub_task_id": child}]}, "137"
        )


@pytest.mark.parametrize("kind", ["image", "video"])
def test_import_rejects_missing_visual_source_instead_of_dropping_it(kind, configured):
    from wecode.video.api.opencut import build_storycut_bundle

    with pytest.raises(HTTPException, match="missing its source URL"):
        build_storycut_bundle(
            timeline={
                "task_id": "timeline",
                "video_tracks": [
                    {"kind": kind, "clip_id": "missing", "source_path": ""}
                ],
            },
            session_id="137",
            uid="tester",
            token="test",
        )


def test_poll_token_is_scoped(configured):
    url = module._poll_url(configured)
    token = parse_qs(urlsplit(url).query)["token"][0]
    assert module._verify_token(token, "137") == "tester"
    with pytest.raises(HTTPException):
        module._verify_token(token, "138")
    with pytest.raises(HTTPException):
        module._verify_token(token + "bad", "137")
    assert module.is_multi_style_poll_url(url)
    assert not module.is_multi_style_poll_url(url.replace("127.0.0.1", "attacker.test"))
    assert not module.is_multi_style_poll_url(
        url.replace("/card/137", "/card/../secret")
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://aigc.test/2/aigc_video/v2/material-video-async/multi-style/task/by-session/138?uid=tester",
        "http://aigc.test/2/aigc_video/v2/material-video-async/multi-style/task/by-session/137?uid=other",
        "http://attacker.test/2/aigc_video/v2/material-video-async/multi-style/task/by-session/137?uid=tester",
    ],
)
def test_tool_url_cannot_change_task_or_user(configured, url):
    with pytest.raises(ValueError):
        module._validate_task_url(url, configured)


@pytest.mark.asyncio
async def test_tool_reuses_durable_service(configured, monkeypatch):
    create = AsyncMock(return_value={"id": "card"})
    monkeypatch.setattr(
        module, "async_video_card_service", SimpleNamespace(create=create)
    )
    result = await module.create_async_multi_video_card(
        token_info=configured,
        task_url="http://aigc.test/2/aigc_video/v2/material-video-async/multi-style/task/by-session/137?uid=tester",
        card_type="video_short_generation",
    )
    assert result == {"id": "card"}
    assert create.await_args.kwargs["card_type"] == module.CARD_TYPE
    assert module.is_multi_style_poll_url(create.await_args.kwargs["task_url"])


@pytest.mark.asyncio
async def test_poll_forwards_only_signed_identity(configured, monkeypatch):
    token = parse_qs(urlsplit(module._poll_url(configured)).query)["token"][0]
    response = httpx.Response(
        200,
        json={"status": 2, "wb_data": variants(["completed"] * 3)},
        request=httpx.Request("GET", "http://aigc.test"),
    )
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.get.return_value = response
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda **kwargs: client)
    result = await module.poll_multi_style("137", token)
    assert result["status"] == "completed"
    assert client.get.await_args.kwargs["headers"] == {"UID": "tester"}
    assert client.get.await_args.args[0].endswith("/137")


@pytest.mark.asyncio
async def test_empty_editor_export_does_not_erase_existing_video(monkeypatch):
    from wecode.video.api import opencut

    monkeypatch.setattr(
        opencut,
        "verify_opencut_token",
        lambda *args: {"uid": "tester", "artifact_id": "timeline"},
    )
    monkeypatch.setattr(
        opencut,
        "_fetch_timeline",
        AsyncMock(
            return_value={"video_tracks": [{"source_path": "https://cdn.test/a.mp4"}]}
        ),
    )
    update = AsyncMock()
    monkeypatch.setattr(opencut, "_update_timeline", update)
    with pytest.raises(HTTPException, match="empty visual track"):
        await opencut.save_opencut_timeline(
            "137_2",
            "token",
            {
                "schema": "storycut.opencut-refined",
                "project": {
                    "scenes": [
                        {
                            "isMain": True,
                            "tracks": {"main": {"type": "video", "elements": []}},
                        }
                    ]
                },
            },
        )
    update.assert_not_awaited()
