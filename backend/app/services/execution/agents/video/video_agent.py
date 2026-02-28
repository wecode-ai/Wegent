# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Video generation agent.

Handles video generation workflow:
1. Intent analysis for follow-up messages (using secondary LLM)
2. Video generation via provider (Seedance, Runway, etc.)
3. Progress polling and streaming
4. Result upload as attachment
"""

import asyncio
import logging
from typing import Optional

from shared.models import EventType, ExecutionEvent, ExecutionRequest

from ...emitters import ResultEmitter
from ..base import PollingAgent
from .intent_analyzer import VideoIntentAnalyzer, VideoIntentResult
from .providers import get_video_provider

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 3
MAX_POLL_COUNT = 600  # 30 minutes


class VideoAgent(PollingAgent):
    """Video generation polling agent.

    Handles video generation tasks by:
    1. Analyzing intent for follow-up messages
    2. Creating video generation job via provider
    3. Polling for progress
    4. Uploading result as attachment
    """

    @property
    def name(self) -> str:
        return "VideoAgent"

    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """
        Execute video generation task.

        Workflow:
        1. Emit START event
        2. Analyze intent if follow-up (using secondary model)
        3. Create video generation job via provider
        4. Poll for progress
        5. Upload result as attachment
        6. Emit DONE event

        Args:
            request: Execution request
            emitter: Result emitter for streaming events
        """
        from app.services.chat.storage.session import session_manager

        cancel_event = await session_manager.register_stream(request.subtask_id)

        task_id = request.task_id
        subtask_id = request.subtask_id
        message_id = request.message_id
        model_config = request.model_config or {}

        # Emit START
        await emitter.emit_start(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            data={"shell_type": "Chat"},
        )

        try:
            # Step 1: Intent analysis for follow-ups
            intent_result = await self._analyze_intent(
                request=request,
                emitter=emitter,
            )

            # Step 2: Get video provider based on protocol
            protocol = model_config.get("protocol", "seedance")
            provider = get_video_provider(protocol, model_config)

            # Step 3: Create video job
            await self._emit_progress(
                emitter, task_id, subtask_id, message_id, 5, "Starting video generation..."
            )

            job_id = await provider.create_job(
                prompt=intent_result.merged_prompt,
                reference_image=intent_result.reference_image,
                image_mode=intent_result.image_mode,
            )

            logger.info(
                f"[{self.name}] Job created: job_id={job_id}, task_id={task_id}"
            )

            # Step 4: Poll for completion
            for poll_num in range(1, MAX_POLL_COUNT + 1):
                # Check cancellation
                if cancel_event.is_set() or await session_manager.is_cancelled(
                    subtask_id
                ):
                    logger.info(f"[{self.name}] Cancelled: task_id={task_id}")
                    await emitter.emit(
                        ExecutionEvent(
                            type=EventType.CANCELLED,
                            task_id=task_id,
                            subtask_id=subtask_id,
                            message_id=message_id,
                        )
                    )
                    return

                status = await provider.get_status(job_id)

                if status.is_completed:
                    break
                elif status.is_failed:
                    raise Exception(status.error or "Video generation failed")

                await self._emit_progress(
                    emitter,
                    task_id,
                    subtask_id,
                    message_id,
                    progress=min(status.progress, 90),
                    message=f"Generating video... {status.progress}%",
                )

                await asyncio.sleep(POLL_INTERVAL_SECONDS)
            else:
                raise Exception("Video generation timed out")

            # Step 5: Get result and upload
            await self._emit_progress(
                emitter, task_id, subtask_id, message_id, 92, "Fetching video result..."
            )

            result = await provider.get_result(job_id)

            await self._emit_progress(
                emitter, task_id, subtask_id, message_id, 95, "Uploading video file..."
            )

            user_id = request.user.get("id") if request.user else None
            attachment_id = await self._upload_attachment(
                result=result,
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
            )

            # Step 6: Emit DONE
            result_data = {
                "value": "Video generation completed",
                "image": result.thumbnail,  # For follow-up reference
                "video": {
                    "attachment_id": attachment_id,
                    "video_url": result.video_url,
                    "thumbnail": result.thumbnail,
                    "duration": result.duration,
                },
            }

            await emitter.emit(
                ExecutionEvent(
                    type=EventType.DONE,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    result=result_data,
                    message_id=message_id,
                )
            )

            logger.info(
                f"[{self.name}] Completed: task_id={task_id}, attachment_id={attachment_id}"
            )

        except Exception as e:
            logger.exception(f"[{self.name}] Error: task_id={task_id}, error={e}")
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.ERROR,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=str(e),
                    message_id=message_id,
                )
            )

        finally:
            await session_manager.unregister_stream(subtask_id)

    async def _analyze_intent(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> VideoIntentResult:
        """Analyze intent for follow-up messages.

        Args:
            request: Execution request
            emitter: Result emitter for progress updates

        Returns:
            VideoIntentResult with merged prompt and image info
        """
        current_prompt = (
            request.prompt
            if isinstance(request.prompt, str)
            else str(request.prompt)
        )

        # Check if this is a follow-up
        if not request.task_id:
            return VideoIntentResult(merged_prompt=current_prompt, should_use_image=False)

        # Emit progress
        await self._emit_progress(
            emitter,
            request.task_id,
            request.subtask_id,
            request.message_id,
            progress=2,
            message="Analyzing user intent...",
        )

        # Get secondary model config from model_config
        # The secondary_model_config should be injected by request_builder
        secondary_model_config = request.model_config.get("secondary_model_config")

        analyzer = VideoIntentAnalyzer()
        return await analyzer.analyze(
            task_id=request.task_id,
            current_prompt=current_prompt,
            secondary_model_config=secondary_model_config,
        )

    async def _emit_progress(
        self,
        emitter: ResultEmitter,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        progress: int,
        message: str,
    ) -> None:
        """Emit progress update.

        Args:
            emitter: Result emitter
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
            progress: Progress percentage (0-100)
            message: Progress message
        """
        await emitter.emit(
            ExecutionEvent(
                type=EventType.CHUNK,
                task_id=task_id,
                subtask_id=subtask_id,
                content=message,
                offset=0,
                result={"progress": progress},
                message_id=message_id,
            )
        )

    async def _upload_attachment(
        self,
        result,
        user_id: int,
        task_id: int,
        subtask_id: int,
    ) -> int:
        """Upload video as attachment.

        Args:
            result: Video job result
            user_id: User ID
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            Attachment ID (SubtaskContext ID)
        """
        from .attachment_uploader import upload_video_attachment

        return await upload_video_attachment(
            video_url=result.video_url,
            thumbnail=result.thumbnail,
            duration=result.duration,
            user_id=user_id,
            task_id=task_id,
            subtask_id=subtask_id,
        )
