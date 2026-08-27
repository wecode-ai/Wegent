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
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from celery import states
from celery.exceptions import Ignore

from app.core.celery_app import celery_app
from app.core.config import settings
from app.stores.tasks import subtask_store, task_store
from shared.telemetry.context import (
    get_request_id,
    init_request_context,
    set_request_context,
)

logger = logging.getLogger(__name__)

# Polling configuration
POLL_INTERVAL_SECONDS = max(1, settings.VIDEO_POLL_INTERVAL_SECONDS)
MAX_POLL_COUNT = max(1, settings.VIDEO_MAX_POLL_COUNT)
VIDEO_PROGRESS_ESTIMATE_SECONDS = 600

# Redis key prefix for cancellation flags (same as session.py)
CANCEL_KEY_PREFIX = "chat:cancel:"

# Celery task ID prefix for video polling tasks
VIDEO_POLL_TASK_ID_PREFIX = "video_poll_"
VIDEO_POLL_SCHEDULE_KEY_PREFIX = "video_poll_scheduled:"
VIDEO_POLL_SCHEDULE_LEASE_SECONDS = max(
    POLL_INTERVAL_SECONDS,
    settings.VIDEO_POLL_SCHEDULE_LEASE_SECONDS,
)
VIDEO_SHUTDOWN_HANDOFF_DELAY_SECONDS = max(
    POLL_INTERVAL_SECONDS,
    settings.VIDEO_SHUTDOWN_HANDOFF_DELAY_SECONDS,
)

_RELEASE_REDIS_TOKEN_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
end
return 0
"""


def _video_poll_schedule_key(subtask_id: int) -> str:
    return f"{VIDEO_POLL_SCHEDULE_KEY_PREFIX}{subtask_id}"


def _get_video_poll_redis_client():
    import redis

    redis_url = settings.CELERY_BROKER_URL or settings.REDIS_URL
    return redis.from_url(
        redis_url,
        decode_responses=True,
        socket_timeout=0.5,
        socket_connect_timeout=0.5,
        retry_on_timeout=False,
    )


def _acquire_video_poll_schedule(subtask_id: int) -> Optional[str]:
    """Reserve one queued video polling task for a subtask."""
    token = str(uuid.uuid4())
    client = None
    try:
        client = _get_video_poll_redis_client()
        acquired = client.set(
            _video_poll_schedule_key(subtask_id),
            token,
            nx=True,
            ex=VIDEO_POLL_SCHEDULE_LEASE_SECONDS,
        )
        return token if acquired else None
    except Exception as exc:
        logger.warning(
            "[video_tasks] Failed to acquire video poll schedule lease; "
            "allowing dispatch: subtask_id=%d error=%s",
            subtask_id,
            exc,
        )
        return token
    finally:
        if client is not None:
            client.close()


def _release_video_poll_schedule(
    subtask_id: int,
    token: Optional[str],
) -> None:
    """Release a queued video polling reservation when the task starts."""
    if not token:
        return

    client = None
    try:
        client = _get_video_poll_redis_client()
        client.eval(
            _RELEASE_REDIS_TOKEN_SCRIPT,
            1,
            _video_poll_schedule_key(subtask_id),
            token,
        )
    except Exception as exc:
        logger.warning(
            "[video_tasks] Failed to release video poll schedule lease: "
            "subtask_id=%d error=%s",
            subtask_id,
            exc,
        )
    finally:
        if client is not None:
            client.close()


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
    card_context: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """
    Dispatch a video polling Celery task with a fixed task_id.

    Uses a Redis schedule lease so only one poll is queued per subtask.

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
        card_context: External CardBlock polling metadata

    Returns:
        Celery task ID, or None when another poll is already queued.
    """
    celery_task_id = f"{VIDEO_POLL_TASK_ID_PREFIX}{subtask_id}"
    scheduled_token = _acquire_video_poll_schedule(subtask_id)
    if scheduled_token is None:
        logger.info(
            "[video_tasks] Skip duplicate polling dispatch: "
            "celery_task_id=%s subtask_id=%d job_id=%s",
            celery_task_id,
            subtask_id,
            job_id,
        )
        return None

    request_id = get_request_id() or init_request_context()

    logger.info(
        f"[video_tasks] Dispatching polling task: "
        f"celery_task_id={celery_task_id}, subtask_id={subtask_id}, job_id={job_id}, "
        f"request_id={request_id}"
    )

    try:
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
                "card_context": card_context,
                "request_id": request_id,
                "scheduled_token": scheduled_token,
            },
            task_id=celery_task_id,
        )
    except Exception:
        _release_video_poll_schedule(subtask_id, scheduled_token)
        raise

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
    block: Optional[Dict[str, Any]] = None,
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

        result = _merge_video_job_result(subtask.result, video_job_data, block)
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
    block: Optional[Dict[str, Any]] = None,
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
    if block is not None:
        if existing_block is None:
            blocks.append(block)
        else:
            persisted_block = dict(existing_block)
            persisted_block.update(block)
            if existing_block.get("type") == "card" and block.get("type") == "card":
                existing_card_data = existing_block.get("card_data")
                updated_card_data = block.get("card_data")
                persisted_block["card_data"] = {
                    **(
                        existing_card_data
                        if isinstance(existing_card_data, dict)
                        else {}
                    ),
                    **(
                        updated_card_data if isinstance(updated_card_data, dict) else {}
                    ),
                }
                existing_preview = existing_block.get("card_preview_data")
                updated_preview = block.get("card_preview_data")
                persisted_block["card_preview_data"] = {
                    **(existing_preview if isinstance(existing_preview, dict) else {}),
                    **(updated_preview if isinstance(updated_preview, dict) else {}),
                }
                persisted_block["timestamp"] = existing_block.get(
                    "timestamp",
                    block.get("timestamp"),
                )
            blocks[blocks.index(existing_block)] = persisted_block
        result["blocks"] = blocks
        return result

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
    block: Optional[Dict[str, Any]] = None,
) -> None:
    """Persist video polling context for recovery."""
    _update_subtask_video_job_sync(subtask_id, video_job_data, block)


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


def _schedule_video_job_poll(
    *,
    subtask_id: int,
    task_id: int,
    user_id: int,
    job_id: str,
    provider_protocol: str,
    video_block_id: str,
    model_config: Dict[str, Any],
    message_id: Optional[int],
    intent_result: Optional[Dict[str, Any]],
    poll_count: int,
    last_progress: int,
    card_context: Optional[Dict[str, Any]],
    request_id: str,
    countdown: int,
) -> bool:
    """Schedule the next video poll through the shared Celery broker."""
    scheduled_token = _acquire_video_poll_schedule(subtask_id)
    if scheduled_token is None:
        logger.info(
            "[video_tasks] Skip duplicate next poll dispatch: "
            "subtask_id=%d job_id=%s poll_count=%d",
            subtask_id,
            job_id,
            poll_count,
        )
        return False

    try:
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
                "card_context": card_context,
                "request_id": request_id,
                "scheduled_token": scheduled_token,
            },
            countdown=countdown,
        )
    except Exception:
        _release_video_poll_schedule(subtask_id, scheduled_token)
        raise
    return True


def _is_stale_video_poll_attempt(
    subtask_id: int,
    job_id: str,
    incoming_poll_count: int,
) -> bool:
    """Return True unless this task still owns the active video poll chain."""
    from app.db.session import SessionLocal
    from app.models.subtask import SubtaskStatus

    db = SessionLocal()
    try:
        subtask = subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
        if not subtask:
            logger.warning(
                "[video_tasks] Ignoring poll for missing subtask: "
                "subtask_id=%d job_id=%s",
                subtask_id,
                job_id,
            )
            return True

        if subtask.status != SubtaskStatus.RUNNING:
            logger.info(
                "[video_tasks] Ignoring poll for inactive subtask: "
                "subtask_id=%d job_id=%s status=%s",
                subtask_id,
                job_id,
                subtask.status,
            )
            return True

        result = subtask.result
        if not isinstance(result, dict):
            return True

        video_job = result.get("video_job")
        if not isinstance(video_job, dict):
            return True

        persisted_job_id = video_job.get("job_id")
        if persisted_job_id != job_id:
            logger.info(
                "[video_tasks] Ignoring poll for superseded job: "
                "subtask_id=%d job_id=%s current_job_id=%s",
                subtask_id,
                job_id,
                persisted_job_id,
            )
            return True

        persisted_poll_count = video_job.get("poll_count")
        if not isinstance(persisted_poll_count, int):
            return True

        return persisted_poll_count > incoming_poll_count
    except Exception as exc:
        logger.warning(
            "[video_tasks] Failed to verify video poll ownership: "
            "subtask_id=%d job_id=%s poll_count=%d error=%s",
            subtask_id,
            job_id,
            incoming_poll_count,
            exc,
        )
        return True
    finally:
        db.close()


def _is_local_shutdown_in_progress() -> bool:
    """Return True when the current backend process is shutting down."""
    try:
        from app.core.local_shutdown import is_local_shutdown
        from app.core.shutdown import shutdown_manager

        return is_local_shutdown() or shutdown_manager.is_shutting_down
    except Exception as exc:
        logger.warning("[video_tasks] Failed to read shutdown state: %s", exc)
        return False


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
    card_context: Optional[Dict[str, Any]] = None,
    request_id: Optional[str] = None,
    scheduled_token: Optional[str] = None,
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
        request_id: Request ID propagated across Celery retries
    """
    if request_id:
        set_request_context(request_id)
    else:
        request_id = init_request_context()

    from app.services.execution.agents.video.providers import get_video_provider
    from app.tasks.video_websocket import (
        emit_video_cancelled,
        emit_video_chunk,
        emit_video_done,
        emit_video_error,
    )
    from shared.utils.error_classifier import format_error_message

    incoming_poll_count = poll_count
    poll_count += 1
    logger.info(
        f"[video_tasks] Polling job: job_id={job_id}, subtask_id={subtask_id}, "
        f"poll_count={poll_count}/{MAX_POLL_COUNT}"
    )
    _release_video_poll_schedule(subtask_id, scheduled_token)

    if _is_stale_video_poll_attempt(subtask_id, job_id, incoming_poll_count):
        logger.info(
            "[video_tasks] Ignoring stale duplicated poll: "
            "job_id=%s task_id=%d subtask_id=%d incoming_poll=%d",
            job_id,
            task_id,
            subtask_id,
            incoming_poll_count,
        )
        raise Ignore()

    if card_context:
        return _poll_async_card(
            subtask_id=subtask_id,
            task_id=task_id,
            user_id=user_id,
            job_id=job_id,
            provider_protocol=provider_protocol,
            video_block_id=video_block_id,
            model_config=model_config,
            message_id=message_id,
            intent_result=intent_result,
            poll_count=poll_count,
            last_progress=last_progress,
            card_context=card_context,
            request_id=request_id,
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

    if _is_local_shutdown_in_progress():
        logger.info(
            "[video_tasks] Polling handed off during shutdown: "
            "job_id=%s task_id=%d subtask_id=%d",
            job_id,
            task_id,
            subtask_id,
        )
        _schedule_video_job_poll(
            subtask_id=subtask_id,
            task_id=task_id,
            user_id=user_id,
            job_id=job_id,
            provider_protocol=provider_protocol,
            video_block_id=video_block_id,
            model_config=model_config,
            message_id=message_id,
            intent_result=intent_result,
            poll_count=incoming_poll_count,
            last_progress=last_progress,
            card_context=card_context,
            request_id=request_id,
            countdown=VIDEO_SHUTDOWN_HANDOFF_DELAY_SECONDS,
        )
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

        _schedule_video_job_poll(
            subtask_id=subtask_id,
            task_id=task_id,
            user_id=user_id,
            job_id=job_id,
            provider_protocol=provider_protocol,
            video_block_id=video_block_id,
            model_config=model_config,
            message_id=message_id,
            intent_result=intent_result,
            poll_count=poll_count,
            last_progress=current_progress,
            card_context=card_context,
            request_id=request_id,
            countdown=POLL_INTERVAL_SECONDS,
        )
        raise Ignore()

    except Ignore:
        raise
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


def _poll_async_card(
    *,
    subtask_id: int,
    task_id: int,
    user_id: int,
    job_id: str,
    provider_protocol: str,
    video_block_id: str,
    model_config: Dict[str, Any],
    message_id: Optional[int],
    intent_result: Optional[Dict[str, Any]],
    poll_count: int,
    last_progress: int,
    card_context: Dict[str, Any],
    request_id: str,
):
    """Poll an external CardBlock through the shared durable video task."""
    from app.services.execution.agents.video.async_card import (
        AsyncCardSnapshot,
        build_async_card_block,
        fetch_async_card_snapshot,
    )
    from app.tasks.video_websocket import (
        emit_card_cancelled,
        emit_card_done,
        emit_card_error,
        emit_card_updated,
    )
    from shared.utils.error_classifier import format_error_message

    query_url = str(card_context.get("query_url") or "")
    card_type = str(card_context.get("card_type") or "")
    preview_title = str(card_context.get("preview_title") or "")
    default_progress_text = str(card_context.get("progress_text") or "")

    def persist_snapshot(
        snapshot: AsyncCardSnapshot,
        job_status: str = "polling",
    ) -> Dict[str, Any]:
        block = build_async_card_block(
            block_id=video_block_id,
            card_type=card_type,
            snapshot=snapshot,
            preview_title=preview_title,
            default_progress_text=default_progress_text,
        )
        video_job_data = {
            "job_id": job_id,
            "query_url": query_url,
            "card_type": card_type,
            "preview_title": preview_title,
            "progress_text": default_progress_text,
            "status": job_status,
            "progress": snapshot.progress,
            "video_block_id": video_block_id,
            "started_at": None,
            "last_poll_at": datetime.now(timezone.utc).isoformat(),
            "poll_count": poll_count,
        }
        _update_subtask_video_job_sync(subtask_id, video_job_data, block)
        logger.info(
            "[video_tasks] Async card snapshot persisted: task_id=%s "
            "subtask_id=%s job_id=%s poll_count=%s/%s job_status=%s "
            "provider_status=%s progress=%s block_status=%s card_status=%s "
            "card_keys=%s",
            task_id,
            subtask_id,
            job_id,
            poll_count,
            MAX_POLL_COUNT,
            job_status,
            snapshot.status,
            snapshot.progress,
            block["status"],
            block["card_status"],
            sorted(snapshot.card),
        )
        return block

    def fail(error_message: str, progress: int) -> None:
        snapshot = AsyncCardSnapshot(
            status="failed",
            progress=progress,
            error=error_message,
        )
        block = persist_snapshot(snapshot, "failed")
        emit_card_error(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            block=block,
        )
        _update_subtask_status_sync(subtask_id, "FAILED", error=error_message)
        _update_task_status_after_subtask(task_id)

    if _check_cancellation_sync(subtask_id):
        snapshot = AsyncCardSnapshot(
            status="failed",
            progress=last_progress,
            error="Video generation cancelled",
        )
        block = persist_snapshot(snapshot, "cancelled")
        emit_card_cancelled(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            block=block,
        )
        _update_subtask_status_sync(subtask_id, "CANCELLED")
        _update_task_status_after_subtask(task_id)
        raise Ignore()

    if _is_local_shutdown_in_progress():
        logger.info(
            "[video_tasks] Async card polling handed off during shutdown: "
            "job_id=%s task_id=%d subtask_id=%d",
            job_id,
            task_id,
            subtask_id,
        )
        _schedule_video_job_poll(
            subtask_id=subtask_id,
            task_id=task_id,
            user_id=user_id,
            job_id=job_id,
            provider_protocol=provider_protocol,
            video_block_id=video_block_id,
            model_config=model_config,
            message_id=message_id,
            intent_result=intent_result,
            poll_count=max(0, poll_count - 1),
            last_progress=last_progress,
            card_context=card_context,
            request_id=request_id,
            countdown=VIDEO_SHUTDOWN_HANDOFF_DELAY_SECONDS,
        )
        raise Ignore()

    try:
        snapshot = _run_async(fetch_async_card_snapshot(query_url))
        block = persist_snapshot(
            snapshot,
            "completed" if snapshot.is_completed else "polling",
        )

        if snapshot.is_completed:
            emit_card_done(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                block=block,
            )
            _update_subtask_status_sync(subtask_id, "COMPLETED")
            _update_task_status_after_subtask(task_id)
            return {"status": "completed", "job_id": job_id}

        if snapshot.is_failed:
            fail(snapshot.error or "Video generation failed", snapshot.progress)
            raise Ignore()

        emit_card_updated(task_id=task_id, subtask_id=subtask_id, block=block)
        if poll_count >= MAX_POLL_COUNT:
            fail("Video generation timed out", snapshot.progress)
            raise Ignore()

        _schedule_video_job_poll(
            subtask_id=subtask_id,
            task_id=task_id,
            user_id=user_id,
            job_id=job_id,
            provider_protocol=provider_protocol,
            video_block_id=video_block_id,
            model_config=model_config,
            message_id=message_id,
            intent_result=intent_result,
            poll_count=poll_count,
            last_progress=snapshot.progress,
            card_context=card_context,
            request_id=request_id,
            countdown=POLL_INTERVAL_SECONDS,
        )
        raise Ignore()
    except Ignore:
        raise
    except Exception as exc:
        error_message = format_error_message(exc)
        if poll_count < MAX_POLL_COUNT:
            _schedule_video_job_poll(
                subtask_id=subtask_id,
                task_id=task_id,
                user_id=user_id,
                job_id=job_id,
                provider_protocol=provider_protocol,
                video_block_id=video_block_id,
                model_config=model_config,
                message_id=message_id,
                intent_result=intent_result,
                poll_count=poll_count,
                last_progress=last_progress,
                card_context=card_context,
                request_id=request_id,
                countdown=POLL_INTERVAL_SECONDS,
            )
            raise Ignore()
        fail(error_message, last_progress)
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

    from app.services.execution.agents.video.extensions import (
        PreparedVideoArtifact,
        prepare_extended_video_result,
    )

    artifact = prepare_extended_video_result(
        result=result,
        user_id=user_id,
        task_id=task_id,
        subtask_id=subtask_id,
    )
    if artifact is None:
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
        from app.services.context import context_service

        playback_url = context_service.build_attachment_url(attachment_id)
        artifact = PreparedVideoArtifact(
            video_url=playback_url,
            websocket_video_url=playback_url,
            attachment_id=attachment_id,
            thumbnail=result.thumbnail,
            duration=result.duration,
        )

    # Build final video block
    final_video_block = {
        "id": video_block_id,
        "type": "video",
        "status": "done",
        "is_placeholder": False,
        "video_url": artifact.video_url,
        "video_thumbnail": artifact.thumbnail,
        "video_duration": artifact.duration,
        "video_attachment_id": artifact.attachment_id,
        "video_progress": 100,
        "timestamp": int(time.time() * 1000),
        **artifact.block_metadata,
    }

    # Persist the stable URL selected by the active result storage implementation.
    db_result_data = {
        "value": "Video generation completed",
        "image": artifact.thumbnail,
        "blocks": [final_video_block.copy()],
    }

    # The WebSocket representation may use a freshly signed playback URL.
    ws_result_data = {
        "value": "Video generation completed",
        "image": artifact.thumbnail,
        "blocks": [final_video_block.copy()],
    }
    ws_result_data["blocks"][0]["video_url"] = artifact.websocket_video_url

    logger.info(
        f"[video_tasks] Video done data: task_id={task_id}, subtask_id={subtask_id}, "
        f"playback_url={artifact.video_url}, video_block_id={video_block_id}, "
        f"attachment_id={artifact.attachment_id}"
    )

    emit_video_done(
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        result_data=ws_result_data,
    )

    _update_subtask_status_sync(subtask_id, "COMPLETED", result=db_result_data)

    # Update task status
    _update_task_status_after_subtask(task_id)

    logger.info(
        f"[video_tasks] Completed: task_id={task_id}, subtask_id={subtask_id}, "
        f"attachment_id={artifact.attachment_id}"
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
