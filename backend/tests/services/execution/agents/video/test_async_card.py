# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

import httpx
import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.services.execution.agents.video.async_card import (
    AsyncCardError,
    AsyncVideoCardService,
    build_async_card_block,
    fetch_async_card_snapshot,
    normalize_async_card_payload,
)


@pytest.fixture(autouse=True)
def allow_public_test_hosts(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.execution.agents.video.async_card._validate_url_for_ssrf",
        lambda _url: True,
    )


def test_normalize_async_card_payload_preserves_public_card_json() -> None:
    snapshot = normalize_async_card_payload(
        {
            "wb_data": {
                "status": "partial_ready",
                "progress": 55,
                "progress_text": "test-progress-partial",
                "card": {
                    "title": "test-card-title",
                    "link": "https://test-workflow.example.com/task/123",
                    "preview_content": {"text": "test-preview-content"},
                    "custom_section": {"label": "test-custom-label"},
                    "buttons": [
                        {
                            "button_id": "generate-entities",
                            "button_name": "test-chat-action",
                            "button_type": "chat",
                        }
                    ],
                    "polling_url": "https://private.example.com/status",
                    "_button_configs": {"private": True},
                },
            }
        }
    )

    assert snapshot.is_partial_ready
    assert snapshot.progress == 55
    assert snapshot.card["custom_section"] == {"label": "test-custom-label"}
    assert snapshot.card["link"] == "https://test-workflow.example.com/task/123"
    assert snapshot.card["buttons"][0]["button_type"] == "chat"
    assert "polling_url" not in snapshot.card
    assert "_button_configs" not in snapshot.card


def test_normalize_async_card_payload_rejects_missing_status() -> None:
    snapshot = normalize_async_card_payload(
        {
            "wb_data": {
                "progress": 20,
                "card": {"title": "test-card-title"},
            }
        }
    )

    assert snapshot.is_failed
    assert snapshot.error == "Card workflow failed with status ''"


def test_async_card_block_filters_unsafe_navigation_urls() -> None:
    snapshot = normalize_async_card_payload(
        {
            "wb_data": {
                "status": "completed",
                "card": {
                    "title": "Generated video",
                    "link": "javascript:alert(1)",
                    "video_url": "https://cdn.example.com/video.mp4",
                    "buttons": [
                        {
                            "button_name": "test-link-action",
                            "button_type": "link",
                            "url": "file:///tmp/private",
                            "prompt": "private prompt",
                            "skill": ["private-skill"],
                        }
                    ],
                },
            }
        }
    )
    block = build_async_card_block(
        block_id="card-1",
        card_type="video_director_generation",
        snapshot=snapshot,
        preview_title="test-preview-title",
        default_progress_text="test-progress",
    )

    assert "link" not in block["card_data"]
    assert block["card_data"]["video_url"].startswith("https://")
    assert block["card_data"]["buttons"][0].get("url") is None
    assert "prompt" not in block["card_data"]["buttons"][0]
    assert "skill" not in block["card_data"]["buttons"][0]
    assert block["card_status"] == "populated"


@pytest.mark.asyncio
async def test_fetch_async_card_snapshot_reads_wb_data() -> None:
    client_options = {}
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "wb_data": {
                    "status": "completed",
                    "progress": 100,
                    "card": {
                        "video_url": "https://cdn.example.com/video.mp4",
                    },
                }
            },
        )
    )
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        client_options.update(kwargs)
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    with patch.object(httpx, "AsyncClient", client_factory):
        snapshot = await fetch_async_card_snapshot(
            "https://test-workflow.example.com/task/123"
        )

    assert snapshot.is_completed
    assert snapshot.card["video_url"] == "https://cdn.example.com/video.mp4"
    assert client_options["follow_redirects"] is False


@pytest.mark.asyncio
async def test_fetch_async_card_snapshot_rejects_invalid_url() -> None:
    with pytest.raises(AsyncCardError, match="absolute HTTP"):
        await fetch_async_card_snapshot("file:///tmp/status.json")


@pytest.mark.asyncio
async def test_fetch_async_card_snapshot_rejects_blocked_host(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.execution.agents.video.async_card._validate_url_for_ssrf",
        lambda _url: False,
    )

    with pytest.raises(AsyncCardError, match="not an allowed"):
        await fetch_async_card_snapshot("http://127.0.0.1/status")


@pytest.mark.asyncio
async def test_async_card_service_persists_and_dispatches_card() -> None:
    service = AsyncVideoCardService()
    token_info = TaskTokenInfo(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="tester",
    )

    with (
        patch("app.tasks.video_tasks.update_subtask_video_job") as persist,
        patch("app.tasks.video_tasks.dispatch_video_polling_task") as dispatch,
        patch("app.tasks.video_websocket.emit_card_created") as emit,
    ):
        result = await service.create(
            token_info=token_info,
            task_url="https://test-workflow.example.com/task/123",
            card_type="video_director_generation",
        )

    video_job = persist.call_args.args[1]
    block = persist.call_args.args[2]
    assert video_job["job_id"].startswith("async-card-")
    assert video_job["query_url"] == "https://test-workflow.example.com/task/123"
    assert video_job["preview_title"] == ""
    assert video_job["progress_text"] == ""
    assert block["type"] == "card"
    assert block["card_status"] == "pending"
    assert block["card_preview_data"]["title"] == ""
    assert block["card_preview_data"]["progress_text"] == ""
    assert dispatch.call_args.kwargs["card_context"]["query_url"] == (
        "https://test-workflow.example.com/task/123"
    )
    assert emit.call_args.kwargs["block"]["card_type"] == ("video_director_generation")
    assert result == {
        "id": block["id"],
        "card_type": "video_director_generation",
        "status": "pending",
        "data": {},
        "preview_data": block["card_preview_data"],
    }
    assert "task_url" not in result


@pytest.mark.asyncio
async def test_async_card_service_reports_dispatch_failure() -> None:
    service = AsyncVideoCardService()
    token_info = TaskTokenInfo(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="tester",
    )

    with (
        patch("app.tasks.video_tasks.update_subtask_video_job") as persist,
        patch(
            "app.tasks.video_tasks.dispatch_video_polling_task",
            side_effect=RuntimeError("queue unavailable"),
        ),
        patch("app.tasks.video_tasks.fail_video_generation_start") as fail,
        patch("app.tasks.video_websocket.emit_card_created"),
        patch("app.tasks.video_websocket.emit_card_error") as emit_error,
    ):
        with pytest.raises(RuntimeError, match="queue unavailable"):
            await service.create(
                token_info=token_info,
                task_url="https://test-workflow.example.com/task/123",
            )

    assert persist.call_count == 2
    failed_job = persist.call_args_list[1].args[1]
    failed_block = persist.call_args_list[1].args[2]
    assert failed_job["status"] == "failed"
    assert failed_block["card_status"] == "error"
    emit_error.assert_called_once()
    fail.assert_called_once()
