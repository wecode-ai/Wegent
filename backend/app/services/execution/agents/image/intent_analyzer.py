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

from ..base_intent_analyzer import BaseIntentAnalyzer

logger = logging.getLogger(__name__)


@dataclass
class ImageIntentResult:
    """Result of image intent analysis."""

    merged_prompt: str
    should_use_image: bool
    reference_image: Optional[str] = None
    is_followup: bool = False


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
        from app.db.session import SessionLocal
        from app.models.subtask import Subtask, SubtaskRole

        db = SessionLocal()
        try:
            # Retrieve relevant subtask history
            query = db.query(Subtask).filter(Subtask.task_id == task_id)
            if exclude_subtask_ids:
                query = query.filter(Subtask.id.notin_(exclude_subtask_ids))
            subtasks = query.order_by(Subtask.message_id.asc()).all()

            if len(subtasks) < 2:
                # Not enough history - this is the first message
                return ImageIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                    is_followup=False,
                )

            # Find most recent user + AI subtask pair
            prev_user, prev_ai = None, None
            for st in reversed(subtasks):
                if st.role == SubtaskRole.ASSISTANT and not prev_ai:
                    prev_ai = st
                elif st.role == SubtaskRole.USER and not prev_user:
                    prev_user = st
                if prev_user and prev_ai:
                    break

            if not prev_user or not prev_ai:
                return ImageIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                    is_followup=False,
                )

            prev_prompt = prev_user.prompt or ""
            prev_result = prev_ai.result or {}

            # Check if previous AI result contains image attachment IDs
            reference_image_url = self._extract_reference_image_url(prev_result)
            has_image = reference_image_url is not None

            # No previous image result means this is a brand-new generation
            if not has_image:
                return ImageIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                    is_followup=False,
                )

            # This is a follow-up (previous turn had an image result)
            # If no secondary model is configured, use simple merge with image
            if not secondary_model_config:
                logger.warning(
                    "[ImageIntentAnalyzer] No secondary model, using simple merge"
                )
                return ImageIntentResult(
                    merged_prompt=f"{prev_prompt}\n\n{current_prompt}",
                    should_use_image=True,
                    reference_image=reference_image_url,
                    is_followup=True,
                )

            # Use secondary LLM for intelligent intent analysis
            intent = await self._analyze_with_llm(
                prev_prompt=prev_prompt,
                current_prompt=current_prompt,
                has_image=has_image,
                model_config=secondary_model_config,
            )

            if intent.should_use_image and has_image:
                intent.reference_image = reference_image_url
            intent.is_followup = True

            return intent

        finally:
            db.close()

    def _extract_reference_image_url(self, prev_result: dict) -> Optional[str]:
        """Extract a usable image URL from the previous AI subtask result.

        Looks for image_attachment_ids inside blocks, then resolves the URL
        via context_service.

        Args:
            prev_result: result dict from previous assistant subtask

        Returns:
            Image URL string or None
        """
        from app.db.session import SessionLocal
        from app.services.context.context_service import context_service

        blocks = prev_result.get("blocks", [])
        for block in blocks:
            if block.get("type") == "image":
                attachment_ids = block.get("image_attachment_ids", [])
                if attachment_ids:
                    attachment_id = attachment_ids[0]
                    db = SessionLocal()
                    try:
                        context = context_service.get_context_optional(
                            db=db, context_id=attachment_id
                        )
                        if context and context.status == "ready":
                            return context_service.build_attachment_url(attachment_id)
                    except Exception as e:
                        logger.warning(
                            f"[ImageIntentAnalyzer] Failed to build attachment URL "
                            f"for id={attachment_id}: {e}"
                        )
                        return None
                    finally:
                        db.close()

                # Fallback: try image_urls list from block
                image_urls = block.get("image_urls", [])
                if image_urls:
                    return image_urls[0]

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
