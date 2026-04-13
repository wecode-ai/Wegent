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
import uuid
from typing import Optional

from shared.models import EventType, ExecutionEvent, ExecutionRequest
from shared.prompts.constants import USER_QUESTION_MARKER, extract_user_question

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

        # Generate a unique block ID for the video block
        video_block_id = f"video-{uuid.uuid4().hex[:8]}"

        # Emit START event
        await emitter.emit_start(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            data={"shell_type": "Chat"},
        )

        # Emit placeholder video block immediately after START
        # This tells the frontend to show a video placeholder frame
        await self._emit_video_block(
            emitter=emitter,
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            block_id=video_block_id,
            is_placeholder=True,
            progress=0,
            status="streaming",
        )

        try:
            # Step 0: Extract user-provided reference images (highest priority)
            # If user explicitly uploaded reference images, skip intent analysis
            user_reference_images = self._extract_reference_images(request)
            prompt_text, prompt_images = self._normalize_prompt(request.prompt)
            user_reference_images.extend(prompt_images)

            # Step 1: Intent analysis for follow-ups (only when no user-uploaded images)
            if not user_reference_images and request.task_id:
                intent_result = await self._analyze_intent(
                    request=request,
                    emitter=emitter,
                    video_block_id=video_block_id,
                    current_prompt=prompt_text,
                )
                final_prompt = intent_result.merged_prompt
                reference_image = intent_result.reference_image
                image_mode = intent_result.image_mode
            else:
                # User explicitly provided attachments - use them directly
                final_prompt = prompt_text or (
                    request.prompt if isinstance(request.prompt, str) else ""
                )
                reference_image = (
                    user_reference_images[0] if user_reference_images else None
                )
                # Only set image_mode when reference_image exists
                image_mode = "first_frame" if reference_image else None

            # Step 2: Get video provider based on protocol
            # Use 'or' to handle both missing key and None value
            protocol = model_config.get("protocol") or "seedance"
            provider = get_video_provider(protocol, model_config)

            # Step 3: Create video job
            await self._emit_video_block(
                emitter=emitter,
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                block_id=video_block_id,
                is_placeholder=True,
                progress=5,
                status="streaming",
                message="Starting video generation...",
            )

            job_id = await provider.create_job(
                prompt=final_prompt,
                reference_image=reference_image,
                image_mode=image_mode,
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

                await self._emit_video_block(
                    emitter=emitter,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    message_id=message_id,
                    block_id=video_block_id,
                    is_placeholder=True,
                    progress=min(status.progress, 90),
                    status="streaming",
                    message=f"Generating video... {status.progress}%",
                )

                await asyncio.sleep(POLL_INTERVAL_SECONDS)
            else:
                raise Exception("Video generation timed out")

            # Step 5: Get result and upload
            await self._emit_video_block(
                emitter=emitter,
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                block_id=video_block_id,
                is_placeholder=True,
                progress=92,
                status="streaming",
                message="Fetching video result...",
            )

            result = await provider.get_result(job_id)

            await self._emit_video_block(
                emitter=emitter,
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                block_id=video_block_id,
                is_placeholder=True,
                progress=95,
                status="streaming",
                message="Uploading video file...",
            )

            user_id = request.user.get("id") if request.user else None
            attachment_id = await self._upload_attachment(
                result=result,
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
            )

            # Step 6: Emit final video block with actual video data
            final_video_block = {
                "id": video_block_id,
                "type": "video",
                "status": "done",
                "is_placeholder": False,
                "video_url": result.video_url,
                "video_thumbnail": result.thumbnail,
                "video_duration": result.duration,
                "video_attachment_id": attachment_id,
                "video_progress": 100,
                "timestamp": int(asyncio.get_event_loop().time() * 1000),
            }

            result_data = {
                "value": "Video generation completed",
                "image": result.thumbnail,  # For follow-up reference
                "blocks": [final_video_block],
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

    def _extract_reference_images(self, request: ExecutionRequest) -> list[str]:
        """Extract reference images from request.attachments (user-uploaded files).

        NOTE:
        - Newer chat flows may provide images via request.prompt vision blocks instead.
          Those are handled by _normalize_prompt().
        """
        reference_images: list[str] = []

        if request.attachments:
            for att in request.attachments:
                if att.get("mime_type", "").startswith("image/"):
                    url = att.get("url") or att.get("content")
                    if url:
                        reference_images.append(url)

        return reference_images

    def _normalize_prompt(
        self,
        prompt: str | list[dict],
    ) -> tuple[str, list[str]]:
        """Normalize ExecutionRequest.prompt to plain text + reference images.

        Returns:
            (prompt_text, images)

        Rules:
        - For vision content list: concatenate all input_text blocks
        - Extract input_image.image_url as reference images
        - If text contains our context wrapper, prefer the actual user question part
        """
        if isinstance(prompt, str):
            return extract_user_question(prompt), []

        if not isinstance(prompt, list):
            return extract_user_question(str(prompt)), []

        text_parts: list[str] = []
        images: list[str] = []

        for block in prompt:
            if not isinstance(block, dict):
                continue

            if block.get("type") == "input_text":
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    text_parts.append(text)

            if block.get("type") == "input_image":
                image_url = block.get("image_url")
                if isinstance(image_url, str) and image_url.strip():
                    images.append(image_url)

        combined_text = "\n".join(text_parts).strip()
        combined_text = extract_user_question(combined_text)
        return combined_text, images

    async def _analyze_intent(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
        video_block_id: str,
        current_prompt: str,
    ) -> VideoIntentResult:
        """Analyze intent for follow-up messages.

        Args:
            request: Execution request
            emitter: Result emitter for progress updates
            video_block_id: Video block ID for progress updates
            current_prompt: Normalized prompt text (already processed by _normalize_prompt)

        Returns:
            VideoIntentResult with merged prompt and image info
        """

        # Check if this is a follow-up
        if not request.task_id:
            return VideoIntentResult(
                merged_prompt=current_prompt, should_use_image=False
            )

        # Emit progress via video block
        await self._emit_video_block(
            emitter=emitter,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            block_id=video_block_id,
            is_placeholder=True,
            progress=2,
            status="streaming",
            message="Analyzing user intent...",
        )

        # Get secondary model config from model_config
        # The secondary_model_config should be injected by request_builder
        secondary_model_config = request.model_config.get("secondary_model_config")

        # Build list of subtask IDs to exclude (current user + assistant subtasks)
        exclude_ids = [
            sid for sid in [request.subtask_id, request.user_subtask_id] if sid
        ]

        analyzer = VideoIntentAnalyzer()
        return await analyzer.analyze(
            task_id=request.task_id,
            current_prompt=current_prompt,
            secondary_model_config=secondary_model_config,
            exclude_subtask_ids=exclude_ids,
        )

    async def _emit_video_block(
        self,
        emitter: ResultEmitter,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        block_id: str,
        is_placeholder: bool,
        progress: int,
        status: str,
        message: str = "",
        video_url: str = "",
        thumbnail: Optional[str] = None,
        duration: Optional[float] = None,
        attachment_id: Optional[int] = None,
    ) -> None:
        """Emit video block update.

        Args:
            emitter: Result emitter
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
            block_id: Unique block ID for the video
            is_placeholder: Whether this is a placeholder (still generating)
            progress: Progress percentage (0-100)
            status: Block status (streaming, done, error)
            message: Progress message
            video_url: Video URL (empty for placeholder)
            thumbnail: Base64 encoded thumbnail
            duration: Video duration in seconds
            attachment_id: Attachment ID for download
        """
        video_block = {
            "id": block_id,
            "type": "video",
            "status": status,
            "is_placeholder": is_placeholder,
            "video_url": video_url,
            "video_thumbnail": thumbnail,
            "video_duration": duration,
            "video_attachment_id": attachment_id,
            "video_progress": progress,
            "content": message,  # Progress message as content
            "timestamp": int(asyncio.get_event_loop().time() * 1000),
        }

        await emitter.emit(
            ExecutionEvent(
                type=EventType.CHUNK,
                task_id=task_id,
                subtask_id=subtask_id,
                # CRITICAL: Do NOT set content here for video blocks
                # The frontend appends content to message.content on each chunk
                # For video progress updates, we only want to update the video block
                # not accumulate progress messages in the main content
                content="",
                offset=0,
                result={
                    "blocks": [video_block],
                },
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
