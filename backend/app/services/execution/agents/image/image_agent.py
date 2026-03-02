# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Image generation agent.

Handles image generation workflow:
1. Parse request and extract image config
2. Analyze intent for follow-up messages (using secondary LLM)
3. Call image generation provider (with optional reference image)
4. Upload result as attachment
5. Emit events via emitter
"""

import logging
import time
import uuid
from typing import List, Optional

from shared.models import EventType, ExecutionEvent, ExecutionRequest

from ...emitters import ResultEmitter
from ..base import PollingAgent
from .intent_analyzer import ImageIntentAnalyzer, ImageIntentResult
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
        2. Analyze intent for follow-ups (using secondary model)
        3. Call image generation provider (with reference image if follow-up)
        4. Upload result as attachment
        5. Emit DONE event with image result
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

            # Normalize prompt.
            # request.prompt can be either:
            # - str
            # - OpenAI Responses API vision content list:
            #   [{"type":"input_text","text":"..."}, {"type":"input_image","image_url":"data:..."}]
            prompt_text, prompt_images = self._normalize_prompt(request.prompt)

            # Step 1: Extract reference images explicitly provided by user (highest priority)
            # Sources:
            # 1) Attachments list (legacy)
            # 2) Vision content blocks in request.prompt
            user_reference_images = [
                *self._extract_reference_images(request),
                *prompt_images,
            ]

            prompt = prompt_text

            # Step 2: Run intent analysis for follow-up if no explicit user reference images
            # and there is prior task history to analyze.
            intent_result: ImageIntentResult | None = None
            if not user_reference_images and request.task_id:
                intent_result = await self._analyze_intent(request)
                final_prompt = (
                    intent_result.merged_prompt if intent_result.is_followup else prompt
                )

                # Use reference image from intent analysis when user didn't specify one
                reference_images = (
                    [intent_result.reference_image]
                    if intent_result.should_use_image and intent_result.reference_image
                    else []
                )
            else:
                # User explicitly provided attachments - skip intent analysis
                final_prompt = prompt
                reference_images = user_reference_images

            # Debug logs for prompt merge and provider params
            # Note: Do NOT log full base64 strings; only log a safe preview.
            prompt_preview = final_prompt.replace("\n", " ")
            if len(prompt_preview) > 500:
                prompt_preview = prompt_preview[:500] + "..."

            ref_previews: list[str] = []
            for ref in reference_images[:3]:
                if not isinstance(ref, str):
                    ref_previews.append(str(type(ref)))
                    continue
                if ref.startswith("data:"):
                    ref_previews.append("data_url")
                elif ref.startswith("http://") or ref.startswith("https://"):
                    ref_previews.append(ref[:120])
                else:
                    ref_previews.append(f"non_url:{ref[:120]}")

            logger.info(
                "[%s] Image generation request: task_id=%s, provider=%s, "
                "is_followup=%s, should_use_image=%s, user_ref_count=%d, ref_count=%d, "
                "image_config=%s, prompt_preview=%s, ref_previews=%s",
                self.name,
                task_id,
                provider.name,
                getattr(intent_result, "is_followup", False),
                getattr(intent_result, "should_use_image", False),
                len(user_reference_images),
                len(reference_images),
                model_config.get("imageConfig"),
                prompt_preview,
                ref_previews,
            )

            result = await provider.generate(
                prompt=final_prompt,
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
        """Extract reference images from request.attachments (legacy input).

        NOTE:
        - Newer chat flows may provide images via `request.prompt` vision blocks instead.
          Those are handled by `_normalize_prompt()`.
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
            return self._extract_user_question(prompt), []

        if not isinstance(prompt, list):
            # Defensive fallback
            return self._extract_user_question(str(prompt)), []

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
        combined_text = self._extract_user_question(combined_text)
        return combined_text, images

    def _extract_user_question(self, text: str) -> str:
        """Extract user-visible question from a context-wrapped prompt.

        The chat context preprocessor may build prompts like:
        "<attachment>...metadata...</attachment>\n\n[User Question]:\n<message>"

        Seedream applies sensitive-text filters; passing attachment metadata (URLs, paths)
        increases false positives. Prefer only the real user question if the marker exists.
        """
        if not isinstance(text, str):
            return str(text)

        marker = "[User Question]:"
        if marker in text:
            after = text.split(marker, 1)[1]
            return after.lstrip("\n").strip()

        return text.strip()

    async def _analyze_intent(self, request: ExecutionRequest) -> ImageIntentResult:
        """Run ImageIntentAnalyzer for multi-turn follow-up detection.

        Args:
            request: Execution request

        Returns:
            ImageIntentResult with merged_prompt, should_use_image, reference_image, is_followup
        """
        model_config = request.model_config or {}
        secondary_model_config = model_config.get("secondary_model_config")

        # Use normalized prompt text to avoid leaking attachment metadata into intent analysis.
        prompt_text, _prompt_images = self._normalize_prompt(request.prompt)
        current_prompt = prompt_text

        # Build exclusion list: current assistant subtask + user subtask
        exclude_ids = [
            sid for sid in [request.subtask_id, request.user_subtask_id] if sid
        ]

        analyzer = ImageIntentAnalyzer()
        return await analyzer.analyze(
            task_id=request.task_id,
            current_prompt=current_prompt,
            secondary_model_config=secondary_model_config,
            exclude_subtask_ids=exclude_ids,
        )

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
