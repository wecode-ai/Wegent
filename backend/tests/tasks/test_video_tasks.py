# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

from app.services.execution.agents.video.providers.base import VideoJobResult
from app.tasks.video_tasks import (
    POLL_INTERVAL_SECONDS,
    _estimate_polling_progress,
    _handle_completion,
    _merge_video_job_result,
)
from app.tasks.video_websocket import emit_video_chunk, emit_video_error


def test_handle_completion_persists_standard_video_result() -> None:
    provider = MagicMock()
    provider.get_result = AsyncMock(
        return_value=VideoJobResult(
            video_url="https://example.com/generated.mp4",
            thumbnail="thumbnail",
            duration=5,
        )
    )

    with (
        patch(
            "app.tasks.video_websocket.emit_video_chunk",
        ),
        patch(
            "app.tasks.video_websocket.emit_video_done",
        ) as emit_done,
        patch(
            "app.services.execution.agents.video.attachment_uploader."
            "upload_video_attachment",
            new=AsyncMock(return_value=456),
        ),
        patch("app.tasks.video_tasks._update_subtask_status_sync") as update_subtask,
        patch("app.tasks.video_tasks._update_task_status_after_subtask"),
    ):
        _handle_completion(
            provider=provider,
            job_id="job-1",
            task_id=10,
            subtask_id=20,
            user_id=30,
            message_id=None,
            video_block_id="video-1",
        )

    result_data = emit_done.call_args.kwargs["result_data"]
    block = result_data["blocks"][0]
    assert block["video_url"] == "https://example.com/generated.mp4"
    assert block["video_attachment_id"] == 456
    assert block["video_progress"] == 100
    update_subtask.assert_called_once()


def test_emit_video_error_closes_placeholder_before_error_event() -> None:
    with patch(
        "app.tasks.video_websocket.emit_chat_event_from_celery"
    ) as emit_chat_event:
        emit_video_error(
            task_id=10,
            subtask_id=20,
            message_id=30,
            video_block_id="video-1",
            error_message="request rejected",
            progress=5,
        )

    assert emit_chat_event.call_count == 2
    chunk_payload = emit_chat_event.call_args_list[0].args[1]
    block = chunk_payload["result"]["blocks"][0]
    assert block["status"] == "error"
    assert block["is_placeholder"] is False
    assert block["video_progress"] == 5
    assert emit_chat_event.call_args_list[1].args[0] == "chat:error"


def test_video_progress_blocks_do_not_include_status_copy() -> None:
    with patch(
        "app.tasks.video_websocket.emit_chat_event_from_celery"
    ) as emit_chat_event:
        emit_video_chunk(
            task_id=10,
            subtask_id=20,
            message_id=30,
            video_block_id="video-1",
            progress=25,
            status="streaming",
            message="Starting video generation...",
        )

    block = emit_chat_event.call_args.args[1]["result"]["blocks"][0]
    assert block["content"] == ""


def test_video_progress_reaches_99_percent_after_ten_minutes() -> None:
    poll_count = 600 // POLL_INTERVAL_SECONDS

    assert _estimate_polling_progress(0, poll_count, 5) == 99


def test_video_progress_prefers_provider_value_over_estimate() -> None:
    poll_count = 600 // POLL_INTERVAL_SECONDS

    assert _estimate_polling_progress(46, poll_count, 80) == 46


def test_merge_video_job_result_persists_refresh_placeholder() -> None:
    result = _merge_video_job_result(
        {
            "video_job": {
                "started_at": "2026-08-07T08:00:00+00:00",
            }
        },
        {
            "job_id": "job-1",
            "status": "polling",
            "progress": 37,
            "video_block_id": "video-1",
            "started_at": None,
        },
    )

    assert result["video_job"]["started_at"] == "2026-08-07T08:00:00+00:00"
    assert result["blocks"] == [
        {
            "id": "video-1",
            "type": "video",
            "status": "streaming",
            "is_placeholder": True,
            "video_url": "",
            "video_thumbnail": None,
            "video_duration": None,
            "video_attachment_id": None,
            "video_progress": 37,
            "content": "",
            "timestamp": result["blocks"][0]["timestamp"],
        }
    ]
