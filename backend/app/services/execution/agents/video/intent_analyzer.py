# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Video intent analyzer for follow-up messages.

Analyzes user intent in multi-turn video generation conversations
to merge prompts and determine image usage.
"""

import logging
from dataclasses import dataclass
from typing import Literal, Optional

from app.services.chat.storage.db import run_sync_in_executor

from ..base_intent_analyzer import BaseIntentAnalyzer

logger = logging.getLogger(__name__)


@dataclass
class VideoIntentResult:
    """Result of video intent analysis."""

    merged_prompt: str
    should_use_image: bool
    image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None
    reference_image: Optional[str] = None


@dataclass(frozen=True)
class _VideoIntentHistory:
    prev_prompt: str
    prev_image: Optional[str]


def _load_video_intent_history(
    task_id: int,
    exclude_subtask_ids: Optional[list],
) -> _VideoIntentHistory | None:
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

        prev_user, prev_ai = None, None
        for subtask in reversed(subtasks):
            if subtask.role == SubtaskRole.ASSISTANT and not prev_ai:
                prev_ai = subtask
            elif subtask.role == SubtaskRole.USER and not prev_user:
                prev_user = subtask
            if prev_user and prev_ai:
                break
        if not prev_user or not prev_ai:
            return None

        prev_result = prev_ai.result or {}
        prev_image = prev_result.get("image") if isinstance(prev_result, dict) else None
        return _VideoIntentHistory(
            prev_prompt=prev_user.prompt or "",
            prev_image=prev_image if isinstance(prev_image, str) else None,
        )
    finally:
        db.close()


INTENT_PROMPT = """You are a video generation intent analysis assistant. The user is in a multi-turn video generation conversation.

Previous user prompt: {previous_prompt}
Current user prompt: {current_prompt}
Has reference image from previous turn: {has_image}

Please analyze the user intent and output JSON:
{{
    "merged_prompt": "Merged and optimized video generation prompt",
    "should_use_image": true/false,
    "image_mode": "first_frame" | "last_frame" | "reference" | null
}}

Rules:
- merged_prompt: Merge the two prompts into a complete, coherent video generation description
- should_use_image: Only true when has_image=true AND user intent implies using the image
- image_mode:
  - "first_frame": Video starts from this image
  - "last_frame": Video ends with this image
  - "reference": Reference the style/content of this image

Output JSON only."""


class VideoIntentAnalyzer(BaseIntentAnalyzer):
    """Analyzes video generation intent for follow-up messages."""

    async def analyze(
        self,
        task_id: int,
        current_prompt: str,
        secondary_model_config: Optional[dict],
        exclude_subtask_ids: Optional[list] = None,
    ) -> VideoIntentResult:
        """
        Analyze intent for follow-up message.

        Args:
            task_id: Task ID
            current_prompt: Current user prompt
            secondary_model_config: LLM config for intent analysis
            exclude_subtask_ids: Subtask IDs to exclude from history (current user + assistant)

        Returns:
            VideoIntentResult with merged prompt and image info
        """
        history = await run_sync_in_executor(
            _load_video_intent_history,
            task_id,
            exclude_subtask_ids,
        )
        if history is None:
            return VideoIntentResult(
                merged_prompt=current_prompt,
                should_use_image=False,
            )

        has_image = history.prev_image is not None
        if not secondary_model_config:
            logger.warning(
                "[VideoIntentAnalyzer] No secondary model, using simple merge"
            )
            return VideoIntentResult(
                merged_prompt=f"{history.prev_prompt}\n\n{current_prompt}",
                should_use_image=has_image,
                image_mode="reference" if has_image else None,
                reference_image=history.prev_image,
            )

        intent = await self._call_llm(
            history.prev_prompt,
            current_prompt,
            has_image,
            secondary_model_config,
        )
        if intent.should_use_image and has_image:
            intent.reference_image = history.prev_image

        return intent

    async def _call_llm(
        self,
        prev_prompt: str,
        current_prompt: str,
        has_image: bool,
        model_config: dict,
    ) -> VideoIntentResult:
        """Call secondary LLM for intent analysis.

        Args:
            prev_prompt: Previous user prompt
            current_prompt: Current user prompt
            has_image: Whether previous response has an image
            model_config: LLM configuration

        Returns:
            VideoIntentResult from LLM analysis
        """
        prompt = INTENT_PROMPT.format(
            previous_prompt=prev_prompt,
            current_prompt=current_prompt,
            has_image=str(has_image).lower(),
        )

        result = await self._call_llm_json(prompt, model_config)

        if result is None:
            return VideoIntentResult(
                merged_prompt=f"{prev_prompt}\n\n{current_prompt}",
                should_use_image=has_image,
                image_mode="reference" if has_image else None,
            )

        return VideoIntentResult(
            merged_prompt=result.get("merged_prompt", current_prompt),
            should_use_image=result.get("should_use_image", False),
            image_mode=(
                result.get("image_mode")
                if result.get("image_mode")
                in ("first_frame", "last_frame", "reference")
                else None
            ),
        )
