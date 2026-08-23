# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable workflow-managed video generation."""

import asyncio
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.mcp_server.auth import TaskTokenInfo
from app.models.subtask import Subtask, SubtaskRole

from .prompt import normalize_video_prompt
from .workflows import get_video_workflow_client
from .workflows.base import VideoWorkflowSnapshot

VIDEO_DIRECTOR_CARD_TYPE = "video_director_generation"


def build_video_director_card_block(
    *,
    block_id: str,
    snapshot: VideoWorkflowSnapshot,
) -> dict[str, Any]:
    """Build the public CardBlock representation for a workflow snapshot."""
    if snapshot.is_completed:
        block_status = "done"
        card_status = "populated"
    elif snapshot.is_failed:
        block_status = "error"
        card_status = "error"
    elif snapshot.is_partial_ready:
        block_status = "streaming"
        card_status = "partial_ready"
    else:
        block_status = "pending"
        card_status = "pending"

    card = dict(snapshot.card)
    return {
        "id": block_id,
        "type": "card",
        "status": block_status,
        "card_type": VIDEO_DIRECTOR_CARD_TYPE,
        "card_id": block_id,
        "card_status": card_status,
        "card_data": card,
        "card_preview_data": {
            "title": card.get("title") or "Video generation",
            "progress": snapshot.progress,
            "progress_text": snapshot.progress_text,
            "video_url": card.get("video_url"),
            "cover_url": card.get("cover_url"),
        },
        "card_error": snapshot.error,
        "timestamp": int(time.time() * 1000),
    }


def resolve_selected_video_params(
    db: Session,
    token_info: TaskTokenInfo,
) -> dict[str, Any]:
    """Read the video model selected on the immediately preceding user turn."""
    user_subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == token_info.task_id,
            Subtask.role == SubtaskRole.USER,
            Subtask.id < token_info.subtask_id,
        )
        .order_by(Subtask.message_id.desc(), Subtask.id.desc())
        .first()
    )
    if not user_subtask or not isinstance(user_subtask.result, dict):
        return {}
    config = user_subtask.result.get("video_config")
    return dict(config) if isinstance(config, dict) else {}


class VideoWorkflowService:
    """Create workflow jobs while reusing the shared video task lifecycle."""

    async def create_video_workflow(
        self,
        *,
        db: Session,
        token_info: TaskTokenInfo,
        workflow_type: str,
        prompt: str,
        reference_images: Optional[list[str | int]] = None,
        reference_videos: Optional[list[str | int]] = None,
    ) -> dict[str, Any]:
        prompt_text = normalize_video_prompt(prompt or "")
        if not prompt_text:
            raise ValueError("prompt is required")

        video_params = resolve_selected_video_params(db, token_info)
        model = str(video_params.get("model") or "").strip()
        if not model:
            raise ValueError("Please select a video model first")

        workflow = get_video_workflow_client(workflow_type)
        creation = await workflow.create(
            prompt=prompt_text,
            model=model,
            model_display_name=video_params.get("model_display_name"),
            reference_images=reference_images or [],
            reference_videos=reference_videos or [],
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            user_id=token_info.user_id,
        )

        block_id = f"video-director-{uuid.uuid4().hex}"
        block = build_video_director_card_block(
            block_id=block_id,
            snapshot=creation.snapshot,
        )
        now = datetime.now(timezone.utc).isoformat()
        video_job = {
            "job_id": creation.external_task_id or creation.query_url,
            "workflow_type": workflow_type,
            "query_url": creation.query_url,
            "status": "polling",
            "progress": creation.snapshot.progress,
            "video_block_id": block_id,
            "started_at": now,
            "last_poll_at": now,
            "poll_count": 0,
            "model_name": model,
        }

        from app.tasks.video_tasks import (
            dispatch_video_polling_task,
            fail_video_generation_start,
            update_subtask_video_job,
        )
        from app.tasks.video_websocket import emit_card_created

        try:
            await asyncio.to_thread(
                update_subtask_video_job,
                token_info.subtask_id,
                video_job,
                block,
            )
            emit_card_created(
                task_id=token_info.task_id,
                subtask_id=token_info.subtask_id,
                block=block,
            )
            dispatch_video_polling_task(
                subtask_id=token_info.subtask_id,
                task_id=token_info.task_id,
                user_id=token_info.user_id,
                job_id=video_job["job_id"],
                provider_protocol="",
                video_block_id=block_id,
                model_config={},
                message_id=None,
                workflow_type=workflow_type,
                workflow_context={"query_url": creation.query_url},
            )
        except Exception as exc:
            error = f"Failed to persist or dispatch video workflow: {exc}"
            await asyncio.to_thread(
                fail_video_generation_start,
                token_info.subtask_id,
                error,
            )
            raise RuntimeError(error) from exc

        return {
            "status": "polling",
            "job_id": video_job["job_id"],
            "video_block_id": block_id,
            "workflow": workflow_type,
            "message": "Video workflow started.",
            "persisted": True,
        }


video_workflow_service = VideoWorkflowService()
