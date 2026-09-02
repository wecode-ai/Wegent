# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Video generation service used by the MCP tool."""

import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.blocking_work import run_execution_io
from app.mcp_server.auth import TaskTokenInfo
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.agents.generation_context import (
    resolve_generation_context,
    resolve_generation_model,
)

from .image_staging import stage_video_reference_images
from .materials import (
    determine_image_mode,
    normalize_reference_materials,
    validate_reference_materials,
)
from .prompt import normalize_video_prompt
from .providers import get_video_provider


@dataclass(frozen=True)
class _VideoJobPreparation:
    prompt: str
    model_config: dict[str, Any]
    images: list[dict[str, Any]]
    videos: list[dict[str, Any]]
    audios: list[dict[str, Any]]
    image_mode: Optional[str]


def _prepare_video_job(
    token_info: TaskTokenInfo,
    prompt: str,
    ratio: Optional[str],
    duration: Optional[str],
    reference_images: Optional[list[str | int]],
    reference_videos: Optional[list[str | int]],
    reference_audios: Optional[list[str | int]],
) -> _VideoJobPreparation:
    """Resolve DB-backed generation inputs inside one worker-owned session."""
    from app.db.session import SessionLocal

    prompt_text = normalize_video_prompt(prompt or "")
    if not prompt_text:
        raise ValueError("prompt is required")

    with SessionLocal() as db:
        context = resolve_generation_context(db, token_info, prompt_text)
        model_config = deepcopy(
            resolve_generation_model(db, context, prompt_text, "video")
        )
        video_config = dict(model_config.get("videoConfig") or {})
        if ratio and ratio.strip():
            video_config["ratio"] = ratio.strip()
        if duration and duration.strip():
            duration_value = duration.strip().lower().removesuffix("s").strip()
            try:
                video_config["duration"] = int(float(duration_value))
            except ValueError as exc:
                raise ValueError("duration must be a number of seconds") from exc
        model_config["videoConfig"] = video_config

        images = normalize_reference_materials(
            db, reference_images, "image", token_info.user_id
        )
        videos = normalize_reference_materials(
            db, reference_videos, "video", token_info.user_id
        )
        audios = normalize_reference_materials(
            db, reference_audios, "audio", token_info.user_id
        )
        validate_reference_materials(model_config, images, videos, audios)
        image_mode = determine_image_mode(model_config, images, videos, audios)

    return _VideoJobPreparation(
        prompt=prompt_text,
        model_config=model_config,
        images=images,
        videos=videos,
        audios=audios,
        image_mode=image_mode,
    )


def _persist_and_dispatch_video_job(
    *,
    token_info: TaskTokenInfo,
    video_job: dict[str, Any],
    job_id: str,
    protocol: str,
    video_block_id: str,
    model_config: dict[str, Any],
) -> None:
    from app.tasks.video_tasks import (
        dispatch_video_polling_task,
        update_subtask_video_job,
    )

    update_subtask_video_job(token_info.subtask_id, video_job)
    dispatch_video_polling_task(
        subtask_id=token_info.subtask_id,
        task_id=token_info.task_id,
        user_id=token_info.user_id,
        job_id=job_id,
        provider_protocol=protocol,
        video_block_id=video_block_id,
        model_config=model_config,
        message_id=None,
    )


def _fail_video_job_start(subtask_id: int, error: str) -> None:
    from app.tasks.video_tasks import fail_video_generation_start

    fail_video_generation_start(subtask_id, error)


class VideoGenerationService:
    async def create_job(
        self,
        token_info: TaskTokenInfo,
        prompt: str,
        ratio: Optional[str] = None,
        duration: Optional[str] = None,
        reference_images: Optional[list[str | int]] = None,
        reference_videos: Optional[list[str | int]] = None,
        reference_audios: Optional[list[str | int]] = None,
    ) -> dict[str, Any]:
        """Create a durable video generation job and return immediately."""
        preparation = await run_sync_in_executor(
            _prepare_video_job,
            token_info,
            prompt,
            ratio,
            duration,
            reference_images,
            reference_videos,
            reference_audios,
        )
        model_config = preparation.model_config
        images = await stage_video_reference_images(
            preparation.images, token_info.user_id
        )
        reference_image = images[0]["url"] if images else None
        protocol = model_config.get("protocol") or "seedance"
        provider = get_video_provider(protocol, model_config)
        job_id = await provider.create_job(
            prompt=preparation.prompt,
            reference_image=reference_image,
            image_mode=preparation.image_mode,
            reference_images=images,
            reference_videos=preparation.videos,
            reference_audios=preparation.audios,
        )

        video_block_id = f"video-{uuid.uuid4().hex[:8]}"
        video_job = {
            "job_id": job_id,
            "provider": protocol,
            "status": "polling",
            "progress": 5,
            "video_block_id": video_block_id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "last_poll_at": datetime.now(timezone.utc).isoformat(),
            "poll_count": 0,
            "model_name": model_config.get("model_name"),
            "model_namespace": model_config.get("model_namespace"),
        }

        try:
            await run_execution_io(
                _persist_and_dispatch_video_job,
                token_info=token_info,
                video_job=video_job,
                job_id=job_id,
                protocol=protocol,
                video_block_id=video_block_id,
                model_config=model_config,
            )
        except Exception as exc:
            error = f"Failed to persist or dispatch video job {job_id}: {exc}"
            await run_execution_io(_fail_video_job_start, token_info.subtask_id, error)
            raise RuntimeError(error) from exc

        return {
            "status": "polling",
            "job_id": job_id,
            "video_block_id": video_block_id,
            "provider": protocol,
            "message": "Video generation started.",
            "persisted": True,
        }


video_generation_service = VideoGenerationService()
