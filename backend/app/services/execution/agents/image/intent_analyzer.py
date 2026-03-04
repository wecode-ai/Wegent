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

            # Debug: show basic history snapshot for follow-up detection
            # Note: keep logs minimal and avoid leaking user content.
            logger.info(
                "[ImageIntentAnalyzer] History loaded: task_id=%s, total_subtasks=%d, exclude_ids=%s",
                task_id,
                len(subtasks),
                exclude_subtask_ids or [],
            )

            if len(subtasks) < 2:
                # Not enough history - this is the first message
                logger.info(
                    "[ImageIntentAnalyzer] Not enough history for follow-up: task_id=%s",
                    task_id,
                )
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
                logger.info(
                    "[ImageIntentAnalyzer] Cannot find (prev_user, prev_ai) pair: task_id=%s, prev_user=%s, prev_ai=%s",
                    task_id,
                    getattr(prev_user, "id", None),
                    getattr(prev_ai, "id", None),
                )
                return ImageIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                    is_followup=False,
                )

            logger.info(
                "[ImageIntentAnalyzer] Selected prev pair: task_id=%s, prev_user_id=%s(msg_id=%s), prev_ai_id=%s(msg_id=%s)",
                task_id,
                prev_user.id,
                getattr(prev_user, "message_id", None),
                prev_ai.id,
                getattr(prev_ai, "message_id", None),
            )

            prev_prompt = prev_user.prompt or ""
            prev_result = prev_ai.result or {}

            # Debug: summarize previous AI result blocks
            try:
                blocks = (
                    prev_result.get("blocks", [])
                    if isinstance(prev_result, dict)
                    else []
                )
                block_types = []
                for b in blocks[:10]:
                    if isinstance(b, dict):
                        block_types.append(b.get("type"))
                logger.info(
                    "[ImageIntentAnalyzer] Prev AI result summary: task_id=%s, prev_ai_id=%s, blocks_count=%d, block_types=%s",
                    task_id,
                    prev_ai.id,
                    len(blocks),
                    block_types,
                )
            except Exception as e:
                logger.debug(
                    "[ImageIntentAnalyzer] Failed to summarize prev_ai.result: task_id=%s, err=%s",
                    task_id,
                    e,
                )

            # Check if previous AI result contains image attachment IDs
            reference_image_url = self._extract_reference_image_url(prev_result)
            has_image = reference_image_url is not None

            if has_image and reference_image_url:
                safe_preview = (
                    "data_url"
                    if reference_image_url.startswith("data:")
                    else reference_image_url[:120]
                )
                logger.info(
                    "[ImageIntentAnalyzer] Resolved reference image for task=%s: %s",
                    task_id,
                    safe_preview,
                )

            # No previous image result means this is a brand-new generation
            if not has_image:
                logger.info(
                    "[ImageIntentAnalyzer] No usable previous image found: task_id=%s, prev_ai_id=%s (treat as non-followup)",
                    task_id,
                    prev_ai.id,
                )
                return ImageIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                    is_followup=False,
                )

            logger.info(
                "[ImageIntentAnalyzer] has_image=true, proceed intent analysis: task_id=%s, prev_ai_id=%s",
                task_id,
                prev_ai.id,
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
            logger.info(
                "[ImageIntentAnalyzer] Calling secondary LLM for intent: task_id=%s, has_image=%s",
                task_id,
                has_image,
            )
            intent = await self._analyze_with_llm(
                prev_prompt=prev_prompt,
                current_prompt=current_prompt,
                has_image=has_image,
                model_config=secondary_model_config,
            )
            logger.info(
                "[ImageIntentAnalyzer] Secondary LLM result: task_id=%s, should_use_image=%s, merged_prompt_len=%d",
                task_id,
                intent.should_use_image,
                len(intent.merged_prompt or ""),
            )

            if intent.should_use_image and has_image:
                intent.reference_image = reference_image_url
            intent.is_followup = True

            return intent

        finally:
            db.close()

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
