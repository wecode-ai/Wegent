# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

import httpx
import pytest

from app.services.execution.agents.video.workflow_service import (
    build_video_director_card_block,
)
from app.services.execution.agents.video.workflows import get_video_workflow_client
from wecode.service.qia_minute_video import (
    QIA_MINUTE_VIDEO_WORKFLOW,
    QiaMinuteVideoClient,
    QiaWorkflowError,
    normalize_qia_payload,
)


def test_qia_workflow_is_registered_as_internal_adapter() -> None:
    assert isinstance(
        get_video_workflow_client(QIA_MINUTE_VIDEO_WORKFLOW),
        QiaMinuteVideoClient,
    )


def test_normalize_qia_payload_maps_progress_and_terminal_statuses() -> None:
    partial = normalize_qia_payload(
        {
            "wb_data": {
                "status": "running",
                "progress": 55,
                "card": {
                    "title": "分镜已完成",
                    "link": "https://qia.example.com/task/1",
                },
            }
        }
    )
    completed = normalize_qia_payload(
        {"wb_data": {"status": "succeeded", "progress": 100}}
    )
    failed = normalize_qia_payload(
        {"wb_data": {"status": "error", "error_message": "upstream failed"}}
    )

    assert partial.status == "partial_ready"
    assert partial.progress == 55
    assert completed.is_completed
    assert failed.is_failed
    assert failed.error == "upstream failed"


def test_qia_card_filters_unsafe_urls() -> None:
    snapshot = normalize_qia_payload(
        {
            "wb_data": {
                "status": "completed",
                "card": {
                    "link": "javascript:alert(1)",
                    "video_url": "https://cdn.example.com/video.mp4",
                    "buttons": [
                        {
                            "button_name": "详情",
                            "button_type": "link",
                            "url": "file:///tmp/private",
                        }
                    ],
                },
            }
        }
    )
    block = build_video_director_card_block(
        block_id="card-1",
        snapshot=snapshot,
    )

    assert "link" not in block["card_data"]
    assert block["card_data"]["video_url"].startswith("https://")
    assert block["card_data"]["buttons"][0].get("url") is None
    assert block["card_status"] == "populated"


@pytest.mark.asyncio
async def test_qia_client_passes_selected_video_model(monkeypatch) -> None:
    request_body = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        request_body.update(httpx.Response(200, content=request.content).json())
        return httpx.Response(
            200,
            json={
                "task_id": "qia-1",
                "task_url": "https://qia.example.com/task/1",
                "wb_data": {"status": "processing"},
            },
        )

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    client = QiaMinuteVideoClient(
        create_url="https://qia.example.com/create",
        api_token="token",
    )

    creation = await client.create(
        prompt="brief",
        model="seedance-2",
        model_display_name="Seedance 2",
        reference_images=[],
        reference_videos=[],
        task_id=1,
        subtask_id=2,
        user_id=3,
    )

    assert request_body["model"] == "seedance-2"
    assert request_body["model_display_name"] == "Seedance 2"
    assert creation.query_url == "https://qia.example.com/task/1"


@pytest.mark.asyncio
async def test_qia_client_reports_create_failure() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(500, json={"error": "failed"})
    )
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    client = QiaMinuteVideoClient(create_url="https://qia.example.com/create")
    with (
        patch.object(httpx, "AsyncClient", client_factory),
        pytest.raises(QiaWorkflowError, match="request failed"),
    ):
        await client.create(
            prompt="brief",
            model="seedance-2",
            model_display_name=None,
            reference_images=[],
            reference_videos=[],
            task_id=1,
            subtask_id=2,
            user_id=3,
        )
