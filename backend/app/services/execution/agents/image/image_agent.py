# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Image generation agent.

Handles image generation workflow:
1. Parse request and extract image config
2. Call image generation provider
3. Upload result as attachment
4. Emit events via emitter
"""

import asyncio
import logging
import time
import uuid
from typing import List, Optional

from shared.models import EventType, ExecutionEvent, ExecutionRequest

from ...emitters import ResultEmitter
from ..base import PollingAgent
from .providers import get_image_provider

logger = logging.getLogger(__name__)


class ImageAgent(PollingAgent):
    """Image generation agent.

    Note: Although this inherits from PollingAgent, it doesn't actually poll.
    The Seedream API is synchronous, so we just wait for the response.
    We inherit from PollingAgent for interface consistency.
    """

    @property
    def name(self) -> str:
        return "ImageAgent"

    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """
        Execute image generation task.

        Workflow:
        1. Emit START event
        2. Call image generation provider
        3. Upload result as attachment
        4. Emit DONE event with image result
        """
        from app.services.chat.storage.session import session_manager

        cancel_event = await session_manager.register_stream(request.subtask_id)

        task_id = request.task_id
        subtask_id = request.subtask_id
        message_id = request.message_id
        model_config = request.model_config or {}

        # Generate unique block ID for image block
        image_block_id = f"image-{uuid.uuid4().hex[:8]}"

        # Emit START event
        await emitter.emit_start(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            data={"shell_type": "Chat"},
        )

        # Emit placeholder image block
        await self._emit_image_block(
            emitter=emitter,
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            block_id=image_block_id,
            is_placeholder=True,
            status="streaming",
            message="Generating image...",
        )

        try:
            # Check cancellation
            if cancel_event.is_set() or await session_manager.is_cancelled(subtask_id):
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

            # Get image provider
            protocol = model_config.get("protocol") or "seedream"
            provider = get_image_provider(protocol, model_config)

            # Extract prompt
            prompt = (
                request.prompt
                if isinstance(request.prompt, str)
                else str(request.prompt)
            )

            # Extract reference images from attachments if any
            reference_images = self._extract_reference_images(request)

            # Generate images
            logger.info(
                f"[{self.name}] Generating image: task_id={task_id}, "
                f"provider={provider.name}"
            )

            result = await provider.generate(
                prompt=prompt,
                reference_images=reference_images,
            )

            if not result.images:
                raise Exception("No images generated")

            # Upload images as attachments
            user_id = request.user.get("id") if request.user else None
            attachment_ids: List[int] = []
            image_urls: List[str] = []

            for i, image in enumerate(result.images):
                # Get image URL (either direct URL or convert from base64)
                image_url = image.url
                if not image_url and image.b64_json:
                    # For base64, we'll store it directly
                    image_url = f"data:image/jpeg;base64,{image.b64_json}"

                if image_url:
                    image_urls.append(image_url)

                    # Upload as attachment
                    attachment_id = await self._upload_attachment(
                        image_url=image_url,
                        image_size=image.size,
                        user_id=user_id,
                        task_id=task_id,
                        subtask_id=subtask_id,
                        index=i,
                    )
                    attachment_ids.append(attachment_id)

            # Emit final image block with actual image data
            final_image_block = {
                "id": image_block_id,
                "type": "image",
                "status": "done",
                "is_placeholder": False,
                "image_urls": image_urls,
                "image_attachment_ids": attachment_ids,
                "image_count": len(image_urls),
                "timestamp": int(time.time() * 1000),
            }

            result_data = {
                "value": "Image generation completed",
                "blocks": [final_image_block],
                "usage": result.usage,
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
                f"[{self.name}] Completed: task_id={task_id}, "
                f"images={len(image_urls)}, attachments={attachment_ids}"
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

    def _extract_reference_images(self, request: ExecutionRequest) -> List[str]:
        """Extract reference images from request attachments."""
        reference_images = []

        # Check if there are attachments in the request
        if request.attachments:
            for att in request.attachments:
                # Check if it's an image attachment
                if att.get("mime_type", "").startswith("image/"):
                    url = att.get("url") or att.get("content")
                    if url:
                        reference_images.append(url)

        return reference_images

    async def _emit_image_block(
        self,
        emitter: ResultEmitter,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        block_id: str,
        is_placeholder: bool,
        status: str,
        message: str = "",
        image_urls: Optional[List[str]] = None,
        attachment_ids: Optional[List[int]] = None,
    ) -> None:
        """Emit image block update."""
        image_block = {
            "id": block_id,
            "type": "image",
            "status": status,
            "is_placeholder": is_placeholder,
            "image_urls": image_urls or [],
            "image_attachment_ids": attachment_ids or [],
            "content": message,
            "timestamp": int(time.time() * 1000),
        }

        await emitter.emit(
            ExecutionEvent(
                type=EventType.CHUNK,
                task_id=task_id,
                subtask_id=subtask_id,
                content="",
                offset=0,
                result={"blocks": [image_block]},
                message_id=message_id,
            )
        )

    async def _upload_attachment(
        self,
        image_url: str,
        image_size: Optional[str],
        user_id: Optional[int],
        task_id: int,
        subtask_id: int,
        index: int = 0,
    ) -> int:
        """Upload image as attachment."""
        from .attachment_uploader import upload_image_attachment

        return await upload_image_attachment(
            image_url=image_url,
            image_size=image_size,
            user_id=user_id,
            task_id=task_id,
            subtask_id=subtask_id,
            index=index,
        )
