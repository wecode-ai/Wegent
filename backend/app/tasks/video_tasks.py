# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery tasks for video generation polling.

This module contains Celery tasks that poll video generation jobs
for completion status. The polling is decoupled from the main request
handler to ensure:
1. Video generation tasks survive backend restarts
2. Progress updates are pushed via WebSocket in real-time
3. Cancellation works across service restarts
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from celery import states
from celery.exceptions import Ignore, Retry

from app.core.celery_app import celery_app
from app.core.config import settings
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)

# Polling configuration
POLL_INTERVAL_SECONDS = max(1, settings.VIDEO_POLL_INTERVAL_SECONDS)
MAX_POLL_COUNT = max(1, settings.VIDEO_MAX_POLL_COUNT)
VIDEO_PROGRESS_ESTIMATE_SECONDS = 600

# Redis key prefix for cancellation flags (same as session.py)
CANCEL_KEY_PREFIX = "chat:cancel:"

# Celery task ID prefix for video polling tasks
VIDEO_POLL_TASK_ID_PREFIX = "video_poll_"


def _estimate_polling_progress(
    provider_progress: int,
    poll_count: int,
    last_progress: int,
) -> int:
    """Estimate 5-99% progress over ten minutes without reaching completion."""
    if provider_progress > 0:
        return min(provider_progress, 99)

    elapsed = poll_count * POLL_INTERVAL_SECONDS
    ratio = min(max(elapsed / VIDEO_PROGRESS_ESTIMATE_SECONDS, 0), 1)
    estimated = 5 + int(94 * ratio)
    return min(max(estimated, last_progress), 99)


def dispatch_video_polling_task(
    subtask_id: int,
    task_id: int,
    user_id: int,
    job_id: str,
    provider_protocol: str,
    video_block_id: str,
    model_config: Dict[str, Any],
    message_id: Optional[int],
    intent_result: Optional[Dict[str, Any]] = None,
    poll_count: int = 0,
    last_progress: int = 0,
) -> str:
    """
    Dispatch a video polling Celery task with a fixed task_id.

    Uses fixed task_id based on subtask_id to prevent duplicate tasks.
    If a task with the same ID already exists in the queue, Celery
    will not create a duplicate.

    Args:
        subtask_id: Subtask ID
        task_id: Task ID
        user_id: User ID
        job_id: Provider job ID
        provider_protocol: Provider protocol
        video_block_id: Video block ID
        model_config: Model configuration
        message_id: Message ID
        intent_result: Intent analysis result
        poll_count: Current poll count
        last_progress: Last progress value

    Returns:
        Celery task ID
    """
    # Use fixed task_id based on subtask_id to prevent duplicate tasks
    celery_task_id = f"{VIDEO_POLL_TASK_ID_PREFIX}{subtask_id}"

    logger.info(
        f"[video_tasks] Dispatching polling task: "
        f"celery_task_id={celery_task_id}, subtask_id={subtask_id}, job_id={job_id}"
    )

    poll_video_job.apply_async(
        kwargs={
            "subtask_id": subtask_id,
            "task_id": task_id,
            "user_id": user_id,
            "job_id": job_id,
            "provider_protocol": provider_protocol,
            "video_block_id": video_block_id,
            "model_config": model_config,
            "message_id": message_id,
            "intent_result": intent_result,
            "poll_count": poll_count,
            "last_progress": last_progress,
        },
        task_id=celery_task_id,
    )

    return celery_task_id


def _check_cancellation_sync(subtask_id: int) -> bool:
    """
    Check if the video generation task has been cancelled.

    Uses sync Redis client since we're in a Celery worker.

    Args:
        subtask_id: Subtask ID to check

    Returns:
        True if cancelled, False otherwise
    """
    try:
        import redis

        from app.core.config import settings

        redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        cancel_key = f"{CANCEL_KEY_PREFIX}{subtask_id}"
        value = redis_client.get(cancel_key)
        redis_client.close()
        # cache_manager uses orjson.dumps(True) which produces "true" (lowercase JSON)
        is_cancelled = value == "true"
        logger.debug(
            f"[video_tasks] Check cancellation: subtask_id={subtask_id}, "
            f"key={cancel_key}, value={value}, is_cancelled={is_cancelled}"
        )
        return is_cancelled
    except Exception as e:
        logger.warning(
            f"[video_tasks] Failed to check cancellation for {subtask_id}: {e}"
        )
        return False


def _update_subtask_video_job_sync(
    subtask_id: int,
    video_job_data: Dict[str, Any],
) -> None:
    """
    Update subtask.result.video_job in database.

    Args:
        subtask_id: Subtask ID
        video_job_data: Video job context data
    """
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        subtask = subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
        if not subtask:
            raise ValueError(f"Subtask {subtask_id} not found")

        result = _merge_video_job_result(subtask.result, video_job_data)
        subtask_store.update_result(db, subtask=subtask, result=result)
        db.commit()

        logger.debug(f"[video_tasks] Updated video_job for subtask {subtask_id}")
    except Exception as e:
        logger.error(f"[video_tasks] Failed to update video_job for {subtask_id}: {e}")
        db.rollback()
        raise
    finally:
        db.close()


def _merge_video_job_result(
    current_result: Optional[Dict[str, Any]],
    video_job_data: Dict[str, Any],
) -> Dict[str, Any]:
    """Persist recovery metadata and a refresh-safe video placeholder block."""
    result = dict(current_result or {})
    existing_job = result.get("video_job")
    merged_job = dict(existing_job) if isinstance(existing_job, dict) else {}
    merged_job.update(
        {key: value for key, value in video_job_data.items() if value is not None}
    )
    result["video_job"] = merged_job

    block_id = merged_job.get("video_block_id")
    if not block_id:
        return result

    existing_blocks = result.get("blocks")
    blocks = list(existing_blocks) if isinstance(existing_blocks, list) else []
    existing_block = next(
        (
            block
            for block in blocks
            if isinstance(block, dict) and block.get("id") == block_id
        ),
        None,
    )
    placeholder = {
        "id": block_id,
        "type": "video",
        "status": "streaming",
        "is_placeholder": True,
        "video_url": "",
        "video_thumbnail": None,
        "video_duration": None,
        "video_attachment_id": None,
        "video_progress": merged_job.get("progress", 0),
        "content": "",
        "timestamp": (
            existing_block.get("timestamp")
            if isinstance(existing_block, dict)
            else int(time.time() * 1000)
        ),
    }
    if existing_block is None:
        blocks.append(placeholder)
    else:
        blocks[blocks.index(existing_block)] = placeholder
    result["blocks"] = blocks
    return result


def update_subtask_video_job(
    subtask_id: int,
    video_job_data: Dict[str, Any],
) -> None:
    """Persist video polling context for recovery."""
    _update_subtask_video_job_sync(subtask_id, video_job_data)


def fail_video_generation_start(subtask_id: int, error: str) -> None:
    """Mark a video generation task failed when setup cannot be persisted."""
    task_id = _update_subtask_status_sync(subtask_id, "FAILED", error=error)
    if task_id:
        _update_task_status_after_subtask(task_id)


def _update_subtask_status_sync(
    subtask_id: int,
    status: str,
    result: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
) -> int:
    """
    Update subtask status in database.

    Args:
        subtask_id: Subtask ID
        status: New status (COMPLETED, FAILED, CANCELLED)
        result: Optional result data
        error: Optional error message

    Returns:
        Task ID for the subtask
    """
    from app.db.session import SessionLocal
    from app.models.subtask import SubtaskStatus

    db = SessionLocal()
    try:
        subtask = subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
        if not subtask:
            logger.warning(f"[video_tasks] Subtask {subtask_id} not found")
            return 0

        fields: Dict[str, Any] = {"status": SubtaskStatus(status)}
        if result is not None:
            fields["result"] = result

        if error is not None:
            fields["error_message"] = error

        if status in ("COMPLETED", "FAILED", "CANCELLED"):
            fields["completed_at"] = datetime.now()

        task_id = subtask.task_id
        subtask_store.update_fields(db, subtask=subtask, **fields)
        db.commit()

        logger.info(f"[video_tasks] Updated subtask {subtask_id} status to {status}")
        return task_id
    except Exception as e:
        logger.error(
            f"[video_tasks] Failed to update status for {subtask_id}: {e}",
            exc_info=True,
        )
        db.rollback()
        return 0
    finally:
        db.close()


def _run_async(coro):
    """Helper to run async code in sync context."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(
    bind=True,
    name="app.tasks.video_tasks.poll_video_job",
    max_retries=MAX_POLL_COUNT,
    default_retry_delay=POLL_INTERVAL_SECONDS,
    autoretry_for=(Exception,),
    retry_backoff=False,  # Fixed interval
)
def poll_video_job(
    self,
    subtask_id: int,
    task_id: int,
    user_id: int,
    job_id: str,
    provider_protocol: str,
    video_block_id: str,
    model_config: Dict[str, Any],
    message_id: Optional[int],
    intent_result: Optional[Dict[str, Any]] = None,
    poll_count: int = 0,
    last_progress: int = 0,
):
    """
    Poll video generation job status.

    This Celery task polls the video provider for job completion status.
    On each poll:
    - Check cancellation via Redis
    - Call provider.get_status()
    - Emit progress via WebSocket
    - On completion: upload attachment, emit DONE
    - On failure: emit ERROR
    - Retry with exponential backoff until max_retries

    Args:
        subtask_id: Subtask ID
        task_id: Task ID
        user_id: User ID
        job_id: Provider job ID
        provider_protocol: Provider protocol (seedance, wanxiang, kling)
        video_block_id: Video block ID for WebSocket updates
        model_config: Model configuration
        message_id: Message ID
        intent_result: Intent analysis result (merged_prompt, reference_image, etc.)
        poll_count: Current poll count (for retry tracking)
        last_progress: Last progress value
    """
    from app.services.execution.agents.video.providers import get_video_provider
    from app.tasks.video_websocket import (
        emit_video_cancelled,
        emit_video_chunk,
        emit_video_done,
        emit_video_error,
    )
    from shared.utils.error_classifier import format_error_message

    poll_count += 1
    logger.info(
        f"[video_tasks] Polling job: job_id={job_id}, subtask_id={subtask_id}, "
        f"poll_count={poll_count}/{MAX_POLL_COUNT}"
    )

    # Check cancellation
    if _check_cancellation_sync(subtask_id):
        logger.info(f"[video_tasks] Job cancelled: subtask_id={subtask_id}")

        # Emit cancelled event
        emit_video_cancelled(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            video_block_id=video_block_id,
            progress=last_progress,
        )

        # Update subtask status
        _update_subtask_status_sync(subtask_id, "CANCELLED")

        # Update task status
        _update_task_status_after_subtask(task_id)

        # Don't retry
        raise Ignore()

    try:
        # Get provider
        provider = get_video_provider(provider_protocol, model_config)

        # Poll status
        status = _run_async(provider.get_status(job_id))

        current_progress = _estimate_polling_progress(
            status.progress,
            poll_count,
            last_progress,
        )

        # Update video_job tracking data
        video_job_data = {
            "job_id": job_id,
            "provider": provider_protocol,
            "status": "polling",
            "progress": current_progress,
            "video_block_id": video_block_id,
            "started_at": None,  # Preserved from initial creation
            "last_poll_at": datetime.now(timezone.utc).isoformat(),
            "poll_count": poll_count,
            "intent_result": intent_result,
        }
        _update_subtask_video_job_sync(subtask_id, video_job_data)

        if status.is_completed:
            logger.info(f"[video_tasks] Job completed: job_id={job_id}")
            _handle_completion(
                provider=provider,
                job_id=job_id,
                task_id=task_id,
                subtask_id=subtask_id,
                user_id=user_id,
                message_id=message_id,
                video_block_id=video_block_id,
            )
            return {"status": "completed", "job_id": job_id}

        if status.is_failed:
            logger.error(
                f"[video_tasks] Job failed: job_id={job_id}, error={status.error}"
            )
            # status.error can be a dict or string, convert to string for storage
            raw_error = status.error or "Video generation failed"
            if isinstance(raw_error, dict):
                error_message = raw_error.get("message") or str(raw_error)
            else:
                error_message = str(raw_error)

            emit_video_error(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                video_block_id=video_block_id,
                error_message=error_message,
                progress=current_progress,
            )

            _update_subtask_status_sync(subtask_id, "FAILED", error=error_message)
            _update_task_status_after_subtask(task_id)

            raise Ignore()

        # Emit progress update
        emit_video_chunk(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            video_block_id=video_block_id,
            progress=current_progress,
            status="streaming",
        )

        # Schedule retry with updated poll_count
        if poll_count >= MAX_POLL_COUNT:
            logger.error(f"[video_tasks] Job timeout: job_id={job_id}")
            emit_video_error(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                video_block_id=video_block_id,
                error_message="Video generation timed out",
                progress=current_progress,
            )
            _update_subtask_status_sync(
                subtask_id, "FAILED", error="Video generation timed out"
            )
            _update_task_status_after_subtask(task_id)
            raise Ignore()

        # Retry with updated state
        raise self.retry(
            countdown=POLL_INTERVAL_SECONDS,
            kwargs={
                "subtask_id": subtask_id,
                "task_id": task_id,
                "user_id": user_id,
                "job_id": job_id,
                "provider_protocol": provider_protocol,
                "video_block_id": video_block_id,
                "model_config": model_config,
                "message_id": message_id,
                "intent_result": intent_result,
                "poll_count": poll_count,
                "last_progress": current_progress,
            },
        )

    except Ignore:
        raise
    except Retry:
        # Retry exception is normal Celery behavior - let it propagate
        raise
    except self.MaxRetriesExceededError:
        logger.error(f"[video_tasks] Max retries exceeded: job_id={job_id}")
        emit_video_error(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            video_block_id=video_block_id,
            error_message="Video generation timed out after maximum retries",
            progress=last_progress,
        )
        _update_subtask_status_sync(
            subtask_id,
            "FAILED",
            error="Video generation timed out after maximum retries",
        )
        _update_task_status_after_subtask(task_id)
        raise Ignore()
    except Exception as e:
        logger.exception(f"[video_tasks] Error polling job {job_id}: {e}")
        error_message = format_error_message(e)

        # On unexpected errors, emit error and don't retry
        emit_video_error(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            video_block_id=video_block_id,
            error_message=error_message,
            progress=last_progress,
        )

        _update_subtask_status_sync(subtask_id, "FAILED", error=error_message)
        _update_task_status_after_subtask(task_id)

        raise Ignore()


def _handle_completion(
    provider,
    job_id: str,
    task_id: int,
    subtask_id: int,
    user_id: int,
    message_id: Optional[int],
    video_block_id: str,
) -> None:
    """
    Handle video job completion.

    Fetches result from provider, uploads attachment, and emits DONE event.
    """
    from app.tasks.video_websocket import emit_video_chunk, emit_video_done

    # Emit progress: fetching result
    emit_video_chunk(
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        video_block_id=video_block_id,
        progress=99,
        status="streaming",
    )

    # Get result
    result = _run_async(provider.get_result(job_id))

    logger.info(
        f"[video_tasks] Got result: task_id={task_id}, subtask_id={subtask_id}, "
        f"video_url={result.video_url}"
    )

    # Emit progress: uploading
    emit_video_chunk(
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        video_block_id=video_block_id,
        progress=99,
        status="streaming",
    )

    # Upload attachment
    from app.services.execution.agents.video.attachment_uploader import (
        upload_video_attachment,
    )

    attachment_id = _run_async(
        upload_video_attachment(
            video_url=result.video_url,
            thumbnail=result.thumbnail,
            duration=result.duration,
            user_id=user_id,
            task_id=task_id,
            subtask_id=subtask_id,
        )
    )

    playback_url = result.video_url

    # Build final video block
    final_video_block = {
        "id": video_block_id,
        "type": "video",
        "status": "done",
        "is_placeholder": False,
        "video_url": playback_url,
        "video_thumbnail": result.thumbnail,
        "video_duration": result.duration,
        "video_attachment_id": attachment_id,
        "video_progress": 100,
        "timestamp": int(time.time() * 1000),
    }

    # Result data for database (stores raw URL)
    db_result_data = {
        "value": "Video generation completed",
        "image": result.thumbnail,
        "blocks": [final_video_block.copy()],
    }

    # Result data for WebSocket (will have signed URL)
    ws_result_data = {
        "value": "Video generation completed",
        "image": result.thumbnail,
        "blocks": [final_video_block.copy()],
    }

    logger.info(
        f"[video_tasks] Video done data: task_id={task_id}, subtask_id={subtask_id}, "
        f"playback_url={playback_url}, video_block_id={video_block_id}, "
        f"attachment_id={attachment_id}"
    )

    emit_video_done(
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        result_data=ws_result_data,
    )

    # Update subtask status with raw URL
    _update_subtask_status_sync(subtask_id, "COMPLETED", result=db_result_data)

    # Update task status
    _update_task_status_after_subtask(task_id)

    logger.info(
        f"[video_tasks] Completed: task_id={task_id}, subtask_id={subtask_id}, "
        f"attachment_id={attachment_id}"
    )


def _update_task_status_after_subtask(task_id: int) -> None:
    """
    Update task status after subtask completion.

    Uses the same logic as db_handler._update_task_status_sync.
    """
    from datetime import datetime

    from app.db.session import SessionLocal
    from app.models.subtask import SubtaskStatus
    from app.schemas.kind import Task
    from app.services.adapters.collaboration_strategy import (
        CollaborationStrategyFactory,
    )

    db = SessionLocal()
    try:
        task = task_store.get_active_task(db, task_id=task_id)
        if not task:
            return

        subtasks = subtask_store.list_assistant_by_task(db, task_id=task_id)
        if not subtasks:
            return

        task_crd = Task.model_validate(task.json)
        last_subtask = subtasks[-1]

        if task_crd.status:
            strategy = CollaborationStrategyFactory.get_strategy_for_task(db, task_id)

            # Get the status string from subtask status enum
            subtask_status_str = last_subtask.status.value

            # Use strategy to determine task status
            new_status, progress = strategy.get_task_status_on_subtask_complete(
                db, task_id, last_subtask.id, subtask_status_str
            )

            task_crd.status.status = new_status
            task_crd.status.result = last_subtask.result

            if progress is not None:
                task_crd.status.progress = progress

            # Set completedAt for terminal statuses
            if new_status in ("COMPLETED", "CANCELLED", "PENDING_CONFIRMATION"):
                task_crd.status.completedAt = datetime.now()

            if last_subtask.status == SubtaskStatus.FAILED:
                task_crd.status.errorMessage = last_subtask.error_message

            task_crd.status.updatedAt = datetime.now()

        task_store.update_json(db, task=task, payload=task_crd.model_dump(mode="json"))
        # Sync task_status column
        if task_crd.status and task_crd.status.status:
            task_store.update_fields(
                db,
                task=task,
                task_status=task_crd.status.status,
            )
        db.commit()

        persisted_status = (
            task_crd.status.status if task_crd.status else task.task_status
        )
        logger.info(
            f"[video_tasks] Updated task {task_id} status to {persisted_status}"
        )
    except Exception as e:
        logger.exception(f"[video_tasks] Error updating task {task_id} status: {e}")
        db.rollback()
    finally:
        db.close()
