# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from celery.exceptions import Ignore

from app.models.subtask import SubtaskStatus
from app.services.execution.agents.video.async_card import AsyncCardSnapshot
from app.services.execution.agents.video.extensions import PreparedVideoArtifact
from app.services.execution.agents.video.providers.base import VideoJobResult
from app.tasks.video_tasks import (
    POLL_INTERVAL_SECONDS,
    _estimate_polling_progress,
    _handle_completion,
    _is_stale_video_poll_attempt,
    _merge_video_job_result,
    _poll_async_card,
    _schedule_video_job_poll,
    dispatch_video_polling_task,
    poll_video_job,
)
from app.tasks.video_websocket import (
    _event_log_context,
    emit_video_chunk,
    emit_video_error,
)


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
        patch(
            "app.services.execution.agents.video.extensions."
            "prepare_extended_video_result",
            return_value=None,
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
    assert block["video_url"] == "/api/attachments/456/download"
    assert block["video_attachment_id"] == 456
    assert block["video_progress"] == 100
    update_subtask.assert_called_once()


def test_handle_completion_returns_external_playback_url_directly() -> None:
    provider = MagicMock()
    provider.get_result = AsyncMock(
        return_value=VideoJobResult(
            video_url="https://provider.example.com/temporary.mp4",
            metadata={"asset_id": "asset-1"},
        )
    )
    artifact = PreparedVideoArtifact(
        video_url="https://cdn.example.com/raw.mp4",
        websocket_video_url="https://cdn.example.com/signed.mp4?token=temporary",
        attachment_id=789,
        thumbnail="https://cdn.example.com/cover.jpg",
        duration=5,
        block_metadata={
            "asset_id": "asset-1",
            "cover_url": "https://cdn.example.com/cover.jpg",
        },
    )

    with (
        patch("app.tasks.video_websocket.emit_video_chunk"),
        patch("app.tasks.video_websocket.emit_video_done") as emit_done,
        patch(
            "app.services.execution.agents.video.extensions."
            "prepare_extended_video_result",
            return_value=artifact,
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

    websocket_block = emit_done.call_args.kwargs["result_data"]["blocks"][0]
    persisted_block = update_subtask.call_args.kwargs["result"]["blocks"][0]
    assert websocket_block["video_url"].endswith("?token=temporary")
    assert persisted_block["video_url"] == "https://cdn.example.com/raw.mp4"
    assert persisted_block["asset_id"] == "asset-1"
    assert persisted_block["cover_url"] == "https://cdn.example.com/cover.jpg"
    assert persisted_block["video_attachment_id"] == 789


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


def test_card_event_log_context_excludes_card_values() -> None:
    context = _event_log_context(
        {
            "subtask_id": 20,
            "result": {
                "blocks": [
                    {
                        "id": "card-1",
                        "status": "done",
                        "card_status": "populated",
                        "card_data": {
                            "video_url": "https://example.com/video.mp4?token=secret"
                        },
                        "card_preview_data": {"progress": 100},
                    }
                ]
            },
        }
    )

    assert context == {
        "subtask_id": 20,
        "block_id": "card-1",
        "status": "done",
        "card_status": "populated",
        "progress": 100,
    }
    assert "secret" not in str(context)


def test_video_progress_reaches_99_percent_after_ten_minutes() -> None:
    poll_count = 600 // POLL_INTERVAL_SECONDS

    assert _estimate_polling_progress(0, poll_count, 5) == 99


def test_video_progress_prefers_provider_value_over_estimate() -> None:
    poll_count = 600 // POLL_INTERVAL_SECONDS

    assert _estimate_polling_progress(46, poll_count, 80) == 46


def test_dispatch_video_polling_task_propagates_request_id() -> None:
    with (
        patch(
            "app.tasks.video_tasks._acquire_video_poll_schedule",
            return_value="schedule-token",
        ),
        patch(
            "app.tasks.video_tasks.get_request_id",
            return_value="trace-123",
        ),
        patch("app.tasks.video_tasks.poll_video_job.apply_async") as apply_async,
    ):
        dispatch_video_polling_task(
            subtask_id=20,
            task_id=10,
            user_id=30,
            job_id="job-1",
            provider_protocol="seedance",
            video_block_id="video-1",
            model_config={},
            message_id=None,
        )

    assert apply_async.call_args.kwargs["kwargs"]["request_id"] == "trace-123"


def test_dispatch_video_polling_task_generates_request_id() -> None:
    with (
        patch(
            "app.tasks.video_tasks._acquire_video_poll_schedule",
            return_value="schedule-token",
        ),
        patch("app.tasks.video_tasks.get_request_id", return_value=None),
        patch(
            "app.tasks.video_tasks.init_request_context",
            return_value="generated",
        ),
        patch("app.tasks.video_tasks.poll_video_job.apply_async") as apply_async,
    ):
        dispatch_video_polling_task(
            subtask_id=20,
            task_id=10,
            user_id=30,
            job_id="job-1",
            provider_protocol="seedance",
            video_block_id="video-1",
            model_config={},
            message_id=None,
        )

    assert apply_async.call_args.kwargs["kwargs"]["request_id"] == "generated"


def test_dispatch_video_polling_task_skips_when_schedule_lease_exists() -> None:
    with (
        patch(
            "app.tasks.video_tasks._acquire_video_poll_schedule",
            return_value=None,
        ),
        patch("app.tasks.video_tasks.poll_video_job.apply_async") as apply_async,
    ):
        celery_task_id = dispatch_video_polling_task(
            subtask_id=20,
            task_id=10,
            user_id=30,
            job_id="job-1",
            provider_protocol="seedance",
            video_block_id="video-1",
            model_config={},
            message_id=None,
        )

    assert celery_task_id is None
    apply_async.assert_not_called()


def test_schedule_video_job_poll_includes_schedule_token() -> None:
    with (
        patch(
            "app.tasks.video_tasks._acquire_video_poll_schedule",
            return_value="schedule-token",
        ),
        patch("app.tasks.video_tasks.poll_video_job.apply_async") as apply_async,
    ):
        scheduled = _schedule_video_job_poll(
            subtask_id=20,
            task_id=10,
            user_id=30,
            job_id="job-1",
            provider_protocol="seedance",
            video_block_id="video-1",
            model_config={},
            message_id=None,
            intent_result=None,
            poll_count=4,
            last_progress=42,
            card_context=None,
            request_id="request-1",
            countdown=3,
        )

    assert scheduled
    assert apply_async.call_args.kwargs["kwargs"]["scheduled_token"] == "schedule-token"
    assert apply_async.call_args.kwargs["countdown"] == 3


def test_poll_video_job_ignores_stale_duplicate_without_polling_provider() -> None:
    with (
        patch("app.tasks.video_tasks._release_video_poll_schedule"),
        patch("app.tasks.video_tasks._is_stale_video_poll_attempt", return_value=True),
        patch(
            "app.services.execution.agents.video.providers.get_video_provider"
        ) as get_provider,
    ):
        with pytest.raises(Ignore):
            poll_video_job.run(
                subtask_id=20,
                task_id=10,
                user_id=30,
                job_id="job-1",
                provider_protocol="seedance",
                video_block_id="video-1",
                model_config={},
                message_id=None,
                poll_count=4,
                last_progress=42,
                scheduled_token="schedule-token",
            )

    get_provider.assert_not_called()


@pytest.mark.parametrize(
    ("status", "persisted_job_id", "persisted_poll_count", "expected"),
    [
        (SubtaskStatus.COMPLETED, "job-1", 4, True),
        (SubtaskStatus.RUNNING, "job-2", 4, True),
        (SubtaskStatus.RUNNING, "job-1", 5, True),
        (SubtaskStatus.RUNNING, "job-1", 4, False),
    ],
)
def test_video_poll_attempt_must_own_active_job(
    status: SubtaskStatus,
    persisted_job_id: str,
    persisted_poll_count: int,
    expected: bool,
) -> None:
    db = MagicMock()
    subtask = MagicMock(
        status=status,
        result={
            "video_job": {
                "job_id": persisted_job_id,
                "poll_count": persisted_poll_count,
            }
        },
    )

    with (
        patch("app.db.session.SessionLocal", return_value=db),
        patch(
            "app.tasks.video_tasks.subtask_store.get_basic_by_id",
            return_value=subtask,
        ),
    ):
        is_stale = _is_stale_video_poll_attempt(
            subtask_id=20,
            job_id="job-1",
            incoming_poll_count=4,
        )

    assert is_stale is expected
    db.close.assert_called_once()


def test_poll_video_job_hands_off_during_shutdown_without_polling_provider() -> None:
    with (
        patch("app.tasks.video_tasks._release_video_poll_schedule"),
        patch("app.tasks.video_tasks._is_stale_video_poll_attempt", return_value=False),
        patch("app.tasks.video_tasks._check_cancellation_sync", return_value=False),
        patch(
            "app.tasks.video_tasks._is_local_shutdown_in_progress", return_value=True
        ),
        patch("app.tasks.video_tasks._schedule_video_job_poll") as schedule,
        patch(
            "app.services.execution.agents.video.providers.get_video_provider"
        ) as get_provider,
    ):
        with pytest.raises(Ignore):
            poll_video_job.run(
                subtask_id=20,
                task_id=10,
                user_id=30,
                job_id="job-1",
                provider_protocol="seedance",
                video_block_id="video-1",
                model_config={},
                message_id=None,
                poll_count=4,
                last_progress=42,
                scheduled_token="schedule-token",
            )

    get_provider.assert_not_called()
    assert schedule.call_args.kwargs["poll_count"] == 4
    assert schedule.call_args.kwargs["last_progress"] == 42


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


def test_merge_video_job_result_persists_card_block() -> None:
    block = {
        "id": "card-1",
        "type": "card",
        "status": "streaming",
        "card_id": "card-1",
        "card_type": "video_director_generation",
        "card_status": "partial_ready",
        "card_data": {"link": "https://workflow.example.com/task/1"},
        "card_preview_data": {"progress": 50},
        "card_error": None,
    }

    result = _merge_video_job_result(
        {},
        {
            "job_id": "workflow-1",
            "status": "polling",
            "video_block_id": "card-1",
        },
        block,
    )

    assert result["blocks"] == [block]
    assert result["video_job"]["job_id"] == "workflow-1"


def test_merge_video_job_result_preserves_incremental_card_data() -> None:
    current = {
        "video_job": {
            "job_id": "https://test-workflow.example.com/task/123",
            "video_block_id": "card-1",
        },
        "blocks": [
            {
                "id": "card-1",
                "type": "card",
                "status": "streaming",
                "card_id": "card-1",
                "card_type": "video_director_generation",
                "card_status": "partial_ready",
                "card_data": {
                    "title": "test-card-title",
                    "link": "https://test-workflow.example.com/detail/123",
                },
                "card_preview_data": {
                    "progress": 60,
                    "progress_text": "test-progress-existing",
                },
                "card_error": None,
                "timestamp": 1000,
            }
        ],
    }
    updated_block = {
        "id": "card-1",
        "type": "card",
        "status": "pending",
        "card_id": "card-1",
        "card_type": "video_director_generation",
        "card_status": "pending",
        "card_data": {},
        "card_preview_data": {
            "progress": 70,
            "progress_text": "test-progress-updated",
        },
        "card_error": None,
        "timestamp": 2000,
    }

    result = _merge_video_job_result(
        current,
        {"status": "polling", "progress": 70},
        updated_block,
    )

    block = result["blocks"][0]
    assert block["card_data"] == {
        "title": "test-card-title",
        "link": "https://test-workflow.example.com/detail/123",
    }
    assert block["card_preview_data"] == {
        "progress": 70,
        "progress_text": "test-progress-updated",
    }
    assert block["timestamp"] == 1000


def test_async_card_poll_completion_persists_populated_card() -> None:
    snapshot = AsyncCardSnapshot(
        status="completed",
        progress=100,
        progress_text="",
        card={"video_url": "https://cdn.example.com/video.mp4"},
        error=None,
    )

    with (
        patch(
            "app.services.execution.agents.video.async_card."
            "fetch_async_card_snapshot",
            new=AsyncMock(return_value=snapshot),
        ),
        patch("app.tasks.video_tasks._check_cancellation_sync", return_value=False),
        patch("app.tasks.video_tasks._update_subtask_video_job_sync") as persist,
        patch("app.tasks.video_tasks._update_subtask_status_sync") as update_status,
        patch("app.tasks.video_tasks._update_task_status_after_subtask"),
        patch("app.tasks.video_websocket.emit_card_done") as emit_done,
    ):
        result = _poll_async_card(
            subtask_id=2,
            task_id=1,
            user_id=3,
            job_id="workflow-1",
            provider_protocol="",
            video_block_id="card-1",
            model_config={},
            message_id=None,
            intent_result=None,
            poll_count=1,
            last_progress=0,
            card_context={
                "query_url": "https://workflow.example.com/task/1",
                "card_type": "video_director_generation",
            },
            request_id="request-1",
        )

    assert result["status"] == "completed"
    assert persist.call_args.args[1]["status"] == "completed"
    assert persist.call_args.args[2]["card_status"] == "populated"
    assert persist.call_args.args[2]["card_preview_data"]["title"] == ""
    assert persist.call_args.args[2]["card_preview_data"]["progress_text"] == ""
    assert update_status.call_args.args[1] == "COMPLETED"
    emit_done.assert_called_once()


def test_async_card_poll_partial_ready_persists_progress_before_retry() -> None:
    snapshot = AsyncCardSnapshot(
        status="partial_ready",
        progress=62,
        progress_text="test-progress-partial",
        card={"link": "https://workflow.example.com/task/1"},
    )
    with (
        patch(
            "app.services.execution.agents.video.async_card."
            "fetch_async_card_snapshot",
            new=AsyncMock(return_value=snapshot),
        ),
        patch("app.tasks.video_tasks._check_cancellation_sync", return_value=False),
        patch("app.tasks.video_tasks._update_subtask_video_job_sync") as persist,
        patch("app.tasks.video_tasks._schedule_video_job_poll") as schedule,
        patch("app.tasks.video_websocket.emit_card_updated") as emit,
    ):
        with pytest.raises(Ignore):
            _poll_async_card(
                subtask_id=2,
                task_id=1,
                user_id=3,
                job_id="workflow-1",
                provider_protocol="",
                video_block_id="card-1",
                model_config={},
                message_id=None,
                intent_result=None,
                poll_count=1,
                last_progress=0,
                card_context={
                    "query_url": "https://workflow.example.com/task/1",
                    "card_type": "video_director_generation",
                },
                request_id="request-1",
            )

    assert persist.call_args.args[2]["card_status"] == "partial_ready"
    assert persist.call_args.args[2]["card_preview_data"]["progress"] == 62
    assert (
        persist.call_args.args[2]["card_preview_data"]["progress_text"]
        == "test-progress-partial"
    )
    assert schedule.call_args.kwargs["poll_count"] == 1
    assert schedule.call_args.kwargs["last_progress"] == 62
    emit.assert_called_once()


@pytest.mark.parametrize(
    ("cancelled", "snapshot", "max_polls", "expected_status", "expected_error"),
    [
        (
            False,
            AsyncCardSnapshot(
                status="failed",
                progress=30,
                error="Workflow failed",
            ),
            100,
            "FAILED",
            "Workflow failed",
        ),
        (
            True,
            AsyncCardSnapshot(status="processing", progress=30),
            100,
            "CANCELLED",
            "Video generation cancelled",
        ),
        (
            False,
            AsyncCardSnapshot(status="processing", progress=30),
            1,
            "FAILED",
            "Video generation timed out",
        ),
    ],
)
def test_async_card_poll_terminal_states(
    cancelled,
    snapshot,
    max_polls,
    expected_status,
    expected_error,
) -> None:
    with (
        patch(
            "app.services.execution.agents.video.async_card."
            "fetch_async_card_snapshot",
            new=AsyncMock(return_value=snapshot),
        ),
        patch(
            "app.tasks.video_tasks._check_cancellation_sync",
            return_value=cancelled,
        ),
        patch("app.tasks.video_tasks.MAX_POLL_COUNT", max_polls),
        patch("app.tasks.video_tasks._update_subtask_video_job_sync") as persist,
        patch("app.tasks.video_tasks._update_subtask_status_sync") as update_status,
        patch("app.tasks.video_tasks._update_task_status_after_subtask"),
        patch("app.tasks.video_websocket.emit_card_error"),
        patch("app.tasks.video_websocket.emit_card_cancelled"),
        patch("app.tasks.video_websocket.emit_card_updated"),
    ):
        with pytest.raises(Ignore):
            _poll_async_card(
                subtask_id=2,
                task_id=1,
                user_id=3,
                job_id="workflow-1",
                provider_protocol="",
                video_block_id="card-1",
                model_config={},
                message_id=None,
                intent_result=None,
                poll_count=1,
                last_progress=30,
                card_context={
                    "query_url": "https://workflow.example.com/task/1",
                    "card_type": "video_director_generation",
                },
                request_id="request-1",
            )

    assert persist.call_args.args[2]["card_error"] == expected_error
    assert update_status.call_args.args[1] == expected_status
