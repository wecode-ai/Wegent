# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Video job recovery logic.

This module handles recovery of in-progress video generation jobs
when the backend service restarts. It queries for subtasks with
video_job.status = "polling" and re-queues them as Celery tasks.

Uses distributed lock to prevent multiple instances from recovering
the same jobs simultaneously.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)

# Consider a video job stale if last_poll_at is older than this threshold
# Set to 10 seconds since we have Celery task_id deduplication to prevent duplicates
STALE_THRESHOLD_SECONDS = 10

# Lock name for video recovery
VIDEO_RECOVERY_LOCK_NAME = "video_recovery"
# Lock expiration time in seconds
VIDEO_RECOVERY_LOCK_EXPIRE_SECONDS = 120


async def recover_video_jobs() -> int:
    """
    Recover in-progress video jobs on backend startup.

    Uses distributed lock to ensure only one instance performs recovery.

    Query subtasks with:
    - status = RUNNING
    - result.video_job.status = "polling"
    - last_poll_at > STALE_THRESHOLD_SECONDS ago (stale)

    Re-queue Celery task with stored context using fixed task_id
    to prevent duplicate tasks.

    Returns:
        Number of recovered video jobs
    """
    from app.core.distributed_lock import distributed_lock

    # Acquire distributed lock to prevent multiple instances from recovering
    with distributed_lock.acquire_context(
        VIDEO_RECOVERY_LOCK_NAME, VIDEO_RECOVERY_LOCK_EXPIRE_SECONDS
    ) as acquired:
        if not acquired:
            logger.info(
                "[video_recovery] Another instance is recovering video jobs, skipping"
            )
            return 0

        return await _do_recover_video_jobs()


async def _do_recover_video_jobs() -> int:
    """
    Internal function to perform the actual recovery logic.

    Separated from recover_video_jobs() to keep locking logic clean.
    """
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        # Only query RUNNING subtasks created in the last hour for performance
        now_utc = datetime.now(timezone.utc)
        one_hour_ago = now_utc - timedelta(hours=1)

        # Query subtasks that may need recovery
        running_subtasks = subtask_store.list_running_since(
            db,
            created_after=one_hour_ago,
        )

        logger.info(
            f"[video_recovery] Found {len(running_subtasks)} RUNNING subtasks "
            f"(created in last hour) to check"
        )

        recovered_count = 0

        for subtask in running_subtasks:
            result = subtask.result
            if not isinstance(result, dict):
                logger.debug(
                    f"[video_recovery] Subtask {subtask.id}: result is not dict, skipping"
                )
                continue

            video_job = result.get("video_job")
            if not isinstance(video_job, dict):
                logger.debug(
                    f"[video_recovery] Subtask {subtask.id}: no video_job in result, skipping"
                )
                continue

            # Check if this is a video job in polling state
            if video_job.get("status") != "polling":
                logger.debug(
                    f"[video_recovery] Subtask {subtask.id}: video_job.status={video_job.get('status')}, not 'polling', skipping"
                )
                continue

            # Check staleness
            last_poll_str = video_job.get("last_poll_at")
            if last_poll_str:
                try:
                    last_poll_at = datetime.fromisoformat(
                        last_poll_str.replace("Z", "+00:00")
                    )
                    if last_poll_at.tzinfo is None:
                        last_poll_at = last_poll_at.replace(tzinfo=timezone.utc)

                    age_seconds = (now_utc - last_poll_at).total_seconds()
                    if age_seconds < STALE_THRESHOLD_SECONDS:
                        # Not stale yet, might still be processing
                        logger.debug(
                            f"[video_recovery] Skipping non-stale job: "
                            f"subtask_id={subtask.id}, age={age_seconds}s"
                        )
                        continue
                except (ValueError, TypeError) as e:
                    logger.warning(
                        f"[video_recovery] Invalid last_poll_at for subtask {subtask.id}: {e}"
                    )

            # Extract recovery data
            job_id = video_job.get("job_id")
            provider = video_job.get("provider")
            video_block_id = video_job.get("video_block_id")
            poll_count = video_job.get("poll_count", 0)
            progress = video_job.get("progress", 0)
            intent_result = video_job.get("intent_result")

            if not job_id or not provider or not video_block_id:
                logger.warning(
                    f"[video_recovery] Missing required fields for subtask {subtask.id}: "
                    f"job_id={job_id}, provider={provider}, video_block_id={video_block_id}"
                )
                continue

            # Get user info
            task_id = subtask.task_id
            user_id = _get_user_id_for_task(db, task_id)
            model_config = _get_model_config_for_subtask(db, subtask, user_id)

            logger.info(
                f"[video_recovery] Recovering video job: "
                f"subtask_id={subtask.id}, task_id={task_id}, job_id={job_id}, "
                f"provider={provider}, poll_count={poll_count}"
            )

            # Re-queue Celery task with fixed task_id to prevent duplicates
            from app.tasks.video_tasks import dispatch_video_polling_task

            dispatch_video_polling_task(
                subtask_id=subtask.id,
                task_id=task_id,
                user_id=user_id,
                job_id=job_id,
                provider_protocol=provider,
                video_block_id=video_block_id,
                model_config=model_config,
                message_id=subtask.message_id,
                intent_result=intent_result,
                poll_count=poll_count,
                last_progress=progress,
            )

            recovered_count += 1
            logger.info(
                f"[video_recovery] Successfully re-queued video job: "
                f"subtask_id={subtask.id}, job_id={job_id}"
            )

        return recovered_count

    except Exception as e:
        logger.exception(f"[video_recovery] Error recovering video jobs: {e}")
        return 0
    finally:
        db.close()


def _get_user_id_for_task(db, task_id: int) -> int:
    """Get user_id for a task."""
    task = task_store.get_by_id(db, task_id=task_id)
    if task and task.kind == "Task":
        return task.user_id
    return 0


def _get_model_config_for_subtask(db, subtask, user_id: int) -> Dict[str, Any]:
    """
    Get model configuration for a subtask.

    First checks task labels for forceOverrideBotModel + modelId.
    If not found, falls back to bot's model configuration.

    Args:
        db: Database session
        subtask: Subtask object
        user_id: User ID for model lookup

    Returns:
        Model configuration dict or empty dict if not found
    """
    from app.models.kind import Kind
    from app.schemas.kind import Task, Team
    from app.services.chat.config.model_resolver import (
        _extract_model_config,
        get_model_config_for_bot,
    )

    try:
        # Get task
        task = task_store.get_by_id(db, task_id=subtask.task_id)
        if not task or task.kind != "Task":
            logger.warning(f"[video_recovery] Task not found for subtask {subtask.id}")
            return {}

        task_crd = Task.model_validate(task.json)

        # Check task labels for forceOverrideBotModel + modelId
        labels = task_crd.metadata.labels or {}
        force_override = labels.get("forceOverrideBotModel") == "true"
        model_id = labels.get("modelId")
        model_type = labels.get("forceOverrideBotModelType", "public")

        if force_override and model_id:
            logger.info(
                f"[video_recovery] Using override model from task labels: "
                f"modelId={model_id}, type={model_type}"
            )
            # Query model directly by name
            model_config = _get_model_config_by_name(db, model_id, user_id, model_type)
            if model_config:
                return model_config
            logger.warning(
                f"[video_recovery] Override model {model_id} not found, "
                f"falling back to bot model"
            )

        # Fall back to bot's model configuration
        if not task_crd.spec.teamRef:
            logger.warning(f"[video_recovery] No teamRef in task {task.id}")
            return {}

        team_ref = task_crd.spec.teamRef
        team_owner_id = team_ref.user_id if team_ref.user_id is not None else user_id
        # Find team
        team = (
            db.query(Kind)
            .filter(
                Kind.user_id == team_owner_id,
                Kind.kind == "Team",
                Kind.name == team_ref.name,
                Kind.namespace == team_ref.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if not team:
            logger.warning(
                f"[video_recovery] Team not found: {task_crd.spec.teamRef.name}"
            )
            return {}

        team_crd = Team.model_validate(team.json)

        # Find the first bot with a model
        if not team_crd.spec.members:
            logger.warning(f"[video_recovery] Team {team.name} has no members")
            return {}

        for member in team_crd.spec.members:
            if not member.botRef:
                continue

            bot_owner_id = (
                member.botRef.user_id
                if member.botRef.user_id is not None
                else team_owner_id
            )
            # Find bot
            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == bot_owner_id,
                    Kind.kind == "Bot",
                    Kind.name == member.botRef.name,
                    Kind.namespace == member.botRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if not bot:
                continue

            # Use the standard model resolver to get config
            try:
                model_config = get_model_config_for_bot(db, bot, bot_owner_id)
                logger.info(
                    f"[video_recovery] Got model_config for subtask {subtask.id}: "
                    f"protocol={model_config.get('protocol')}, "
                    f"base_url={model_config.get('base_url')[:30] if model_config.get('base_url') else None}..."
                )
                return model_config
            except ValueError as e:
                logger.warning(
                    f"[video_recovery] Failed to get model config for bot {bot.name}: {e}"
                )
                continue

        logger.warning(
            f"[video_recovery] No valid bot/model found for subtask {subtask.id}"
        )
        return {}

    except Exception as e:
        logger.warning(f"[video_recovery] Error getting model config: {e}")

    return {}


def _get_model_config_by_name(
    db, model_name: str, user_id: int, model_type: str
) -> Dict[str, Any]:
    """
    Get model configuration by model name.

    Args:
        db: Database session
        model_name: Model name to find
        user_id: User ID for private model lookup
        model_type: Model type ('public' or 'private')

    Returns:
        Model configuration dict or empty dict if not found
    """
    from app.models.kind import Kind
    from app.services.chat.config.model_resolver import _extract_model_config

    try:
        # Query model by name
        if model_type == "public":
            # Public models have user_id = 0
            model = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.user_id == 0,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # Private models belong to the user
            model = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.user_id == user_id,
                    Kind.is_active == True,
                )
                .first()
            )

        if not model:
            logger.warning(
                f"[video_recovery] Model not found: name={model_name}, "
                f"type={model_type}, user_id={user_id}"
            )
            return {}

        # Extract model config using standard resolver
        model_spec = model.json.get("spec", {})
        model_config = _extract_model_config(model_spec)

        logger.info(
            f"[video_recovery] Got model config by name: model={model_name}, "
            f"protocol={model_config.get('protocol')}, "
            f"base_url={model_config.get('base_url')[:30] if model_config.get('base_url') else None}..."
        )
        return model_config

    except Exception as e:
        logger.warning(
            f"[video_recovery] Error getting model config by name {model_name}: {e}"
        )
        return {}
