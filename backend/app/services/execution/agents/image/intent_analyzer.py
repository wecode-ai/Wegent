# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Image intent analyzer for follow-up messages.

Analyzes user intent in multi-turn image generation conversations
to merge prompts and determine whether to pass a reference image.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from app.services.chat.storage.db import run_sync_in_executor

from ..base_intent_analyzer import BaseIntentAnalyzer

logger = logging.getLogger(__name__)


@dataclass
class ImageIntentResult:
    """Result of image intent analysis."""

    merged_prompt: str
    should_use_image: bool
    reference_image: Optional[str] = None
    is_followup: bool = False


@dataclass(frozen=True)
class _ImageIntentHistory:
    previous_prompt: str
    reference_image: Optional[str]


def _load_image_intent_history(
    task_id: int,
    exclude_subtask_ids: Optional[list],
) -> _ImageIntentHistory | None:
    """Load and detach the previous image turn in a worker-owned session."""
    from app.db.session import SessionLocal
    from app.models.subtask import SubtaskRole
    from app.stores.tasks import subtask_store

    db = SessionLocal()
    try:
        subtasks = subtask_store.list_by_task_ordered(
            db,
            task_id=task_id,
            exclude_subtask_ids=exclude_subtask_ids,
        )
        if len(subtasks) < 2:
            return None

        previous_user = None
        previous_assistant = None
        for subtask in reversed(subtasks):
            if subtask.role == SubtaskRole.ASSISTANT and previous_assistant is None:
                previous_assistant = subtask
            elif subtask.role == SubtaskRole.USER and previous_user is None:
                previous_user = subtask
            if previous_user is not None and previous_assistant is not None:
                break
        if previous_user is None or previous_assistant is None:
            return None

        previous_result = previous_assistant.result or {}
        reference_image = ImageIntentAnalyzer()._extract_reference_image_url(
            previous_result
        )
        return _ImageIntentHistory(
            previous_prompt=previous_user.prompt or "",
            reference_image=reference_image,
        )
    finally:
        db.close()


INTENT_PROMPT = """You are an image generation intent analysis assistant. The user is in a multi-turn image generation conversation.

Previous user prompt: {previous_prompt}
Current user prompt: {current_prompt}
Has reference image from previous turn: {has_image}

Please analyze the user intent and output JSON:
{{
    "merged_prompt": "Merged and optimized image generation prompt",
    "should_use_image": true/false
}}

Rules:
- merged_prompt: Merge the two prompts into a complete, coherent image generation description. If the user is modifying the previous image, incorporate the modification clearly.
- should_use_image: Set to true only when has_image=true AND the user's intent implies modifying or building upon the previous image (e.g., changing colors, style, elements). Set to false when the user is describing an entirely new image.

Output JSON only."""


class ImageIntentAnalyzer(BaseIntentAnalyzer):
    """Analyzes image generation intent for follow-up messages."""

    async def analyze(
        self,
        task_id: int,
        current_prompt: str,
        secondary_model_config: Optional[dict],
        exclude_subtask_ids: Optional[list] = None,
    ) -> ImageIntentResult:
        """
        Analyze intent for follow-up image generation message.

        Args:
            task_id: Task ID
            current_prompt: Current user prompt
            secondary_model_config: LLM config for intent analysis
            exclude_subtask_ids: Subtask IDs to exclude from history

        Returns:
            ImageIntentResult with merged prompt and reference image info
        """
        history = await run_sync_in_executor(
            _load_image_intent_history,
            task_id,
            exclude_subtask_ids,
        )
        if history is None or history.reference_image is None:
            return ImageIntentResult(
                merged_prompt=current_prompt,
                should_use_image=False,
                is_followup=False,
            )

        if not secondary_model_config:
            return ImageIntentResult(
                merged_prompt=f"{history.previous_prompt}\n\n{current_prompt}",
                should_use_image=True,
                reference_image=history.reference_image,
                is_followup=True,
            )

        intent = await self._analyze_with_llm(
            prev_prompt=history.previous_prompt,
            current_prompt=current_prompt,
            has_image=True,
            model_config=secondary_model_config,
        )
        if intent.should_use_image:
            intent.reference_image = history.reference_image
        intent.is_followup = True
        return intent

    def _extract_reference_image_url(self, prev_result: dict) -> Optional[str]:
        """Extract a usable image reference from the previous assistant result.

        Priority:
        1) Prefer data URL built from stored `image_base64` in SubtaskContext.
           This is the most compatible format for Seedream (avoids external URL fetch).
        2) Fallback to relative download URL ("/api/attachments/{id}/download").
        3) Fallback to `image_urls[0]` in the message block.

        Args:
            prev_result: result dict from previous assistant subtask

        Returns:
            Image reference string (data URL or URL) or None.
        """
        from app.db.session import SessionLocal
        from app.services.context.context_service import context_service

        blocks = prev_result.get("blocks", [])
        if not isinstance(blocks, list):
            logger.debug(
                "[ImageIntentAnalyzer] prev_result.blocks is not a list: type=%s",
                type(blocks),
            )
            return None

        image_blocks_found = 0
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "image":
                continue

            image_blocks_found += 1

            attachment_ids = block.get("image_attachment_ids", [])
            if attachment_ids:
                attachment_id = attachment_ids[0]
                db = SessionLocal()
                try:
                    context = context_service.get_context_optional(
                        db=db, context_id=attachment_id
                    )
                    if not context:
                        logger.info(
                            "[ImageIntentAnalyzer] Attachment context not found: id=%s",
                            attachment_id,
                        )
                        continue

                    logger.info(
                        "[ImageIntentAnalyzer] Attachment context loaded: id=%s, status=%s, mime_type=%s, has_image_base64=%s",
                        attachment_id,
                        getattr(context, "status", None),
                        getattr(context, "mime_type", None),
                        bool(getattr(context, "image_base64", None)),
                    )

                    if context.status == "ready":
                        # Prefer embedding image as data URL.
                        # NOTE: Do NOT log full base64 string.
                        if getattr(context, "image_base64", None) and getattr(
                            context, "mime_type", None
                        ):
                            return f"data:{context.mime_type};base64,{context.image_base64}"

                        # Fallback 1: Use stored external URL if available (e.g., TOS signed URL).
                        # This is typically more compatible for third-party providers than a relative backend URL.
                        type_data = getattr(context, "type_data", None) or {}
                        if isinstance(type_data, dict):
                            image_meta = type_data.get("image_metadata") or {}
                            if isinstance(image_meta, dict):
                                image_url = image_meta.get("image_url")
                                if isinstance(image_url, str) and image_url.startswith(
                                    ("http://", "https://")
                                ):
                                    logger.info(
                                        "[ImageIntentAnalyzer] Using image_metadata.image_url as reference: %s",
                                        image_url[:120],
                                    )
                                    return image_url

                        # Fallback 2: relative URL (caller may need to make it absolute).
                        return context_service.build_attachment_url(attachment_id)

                    logger.info(
                        "[ImageIntentAnalyzer] Attachment context not ready for reference: id=%s, status=%s",
                        attachment_id,
                        getattr(context, "status", None),
                    )
                except Exception as e:
                    logger.warning(
                        "[ImageIntentAnalyzer] Failed to resolve reference image for id=%s: %s",
                        attachment_id,
                        e,
                    )
                finally:
                    db.close()

            # Fallback: try image_urls list from block
            image_urls = block.get("image_urls", [])
            if image_urls:
                return image_urls[0]

        if image_blocks_found == 0:
            logger.info(
                "[ImageIntentAnalyzer] No image blocks found in prev_result.blocks"
            )
        else:
            logger.info(
                "[ImageIntentAnalyzer] Found image blocks but no usable reference image"
            )

        return None

    async def _analyze_with_llm(
        self,
        prev_prompt: str,
        current_prompt: str,
        has_image: bool,
        model_config: dict,
    ) -> ImageIntentResult:
        """Call secondary LLM to analyze user intent.

        Args:
            prev_prompt: Previous user prompt
            current_prompt: Current user prompt
            has_image: Whether previous response has an image
            model_config: LLM configuration

        Returns:
            ImageIntentResult from LLM analysis
        """
        prompt = INTENT_PROMPT.format(
            previous_prompt=prev_prompt,
            current_prompt=current_prompt,
            has_image=str(has_image).lower(),
        )

        result = await self._call_llm_json(prompt, model_config)

        if result is None:
            # Fallback on LLM failure
            return ImageIntentResult(
                merged_prompt=f"{prev_prompt}\n\n{current_prompt}",
                should_use_image=has_image,
            )

        return ImageIntentResult(
            merged_prompt=result.get("merged_prompt", current_prompt),
            should_use_image=result.get("should_use_image", False),
        )
