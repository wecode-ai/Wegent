# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Correction Service - Evaluates and corrects AI responses.
"""

import asyncio
import json
import logging
import re
from typing import Any

from app.services.chat.base import get_http_client
from app.services.chat.message_builder import message_builder
from app.services.chat.providers import get_provider
from app.services.chat.providers.base import ChunkType

logger = logging.getLogger(__name__)


CORRECTION_PROMPT_TEMPLATE = """You are a professional AI response reviewer. Please evaluate the following AI response.

## User Question
{original_question}

## AI Response
{original_answer}

## Evaluation Requirements
Please evaluate from the following dimensions (1-10 score for each):
1. **Accuracy**: Are the facts in the response correct?
2. **Logic**: Is the reasoning process reasonable and consistent?
3. **Completeness**: Does it fully answer the user's question?

## Output Format (JSON)
You MUST respond with ONLY a valid JSON object, no markdown code blocks, no explanations before or after. The JSON must follow this exact structure:
{{
  "scores": {{
    "accuracy": <1-10>,
    "logic": <1-10>,
    "completeness": <1-10>
  }},
  "corrections": [
    {{"issue": "description of the issue", "suggestion": "correction suggestion"}}
  ],
  "summary": "overall evaluation (2-3 sentences)",
  "improved_answer": "if there are issues, provide the improved complete answer; if no issues, return empty string",
  "is_correct": <true/false>
}}

Important:
- If the response is correct and complete, set is_correct to true and leave improved_answer as empty string
- If there are issues, set is_correct to false and provide improved_answer
- The corrections array should be empty if is_correct is true
- Respond in the same language as the original question"""


class CorrectionService:
    """Service for evaluating and correcting AI responses."""

    async def evaluate_response(
        self,
        original_question: str,
        original_answer: str,
        model_config: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Evaluate an AI response and provide corrections if needed.

        Args:
            original_question: The user's original question
            original_answer: The AI's original answer
            model_config: Model configuration for the correction model

        Returns:
            Dictionary with scores, corrections, summary, improved_answer, and is_correct
        """
        # Build the correction prompt
        prompt = CORRECTION_PROMPT_TEMPLATE.format(
            original_question=original_question, original_answer=original_answer
        )

        # Build messages for the LLM
        messages = message_builder.build_messages(
            history=[],
            current_message=prompt,
            system_prompt="You are a professional AI response reviewer. Always respond with valid JSON only.",
        )

        # Get provider and make request
        client = await get_http_client()
        provider = get_provider(model_config, client)
        if not provider:
            raise ValueError("Failed to create provider from model config")

        # Collect response
        cancel_event = asyncio.Event()
        accumulated_content = ""

        try:
            async for chunk in provider.stream_chat(messages, cancel_event):
                if chunk.type == ChunkType.CONTENT and chunk.content:
                    accumulated_content += chunk.content
                elif chunk.type == ChunkType.ERROR:
                    raise ValueError(chunk.error or "Unknown error from LLM")
        except Exception as e:
            logger.error(f"Correction evaluation error: {e}")
            raise

        # Parse JSON response
        return self._parse_correction_response(accumulated_content)

    def _parse_correction_response(self, response: str) -> dict[str, Any]:
        """Parse the correction response JSON."""
        # Try to extract JSON from the response
        # Handle cases where LLM wraps JSON in markdown code blocks
        json_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", response)
        if json_match:
            json_str = json_match.group(1)
        else:
            # Try to find JSON object directly
            json_match = re.search(r"\{[\s\S]*\}", response)
            if json_match:
                json_str = json_match.group(0)
            else:
                json_str = response

        try:
            result = json.loads(json_str)

            # Validate and normalize the response
            scores = result.get("scores", {})
            return {
                "scores": {
                    "accuracy": self._clamp_score(scores.get("accuracy", 5)),
                    "logic": self._clamp_score(scores.get("logic", 5)),
                    "completeness": self._clamp_score(scores.get("completeness", 5)),
                },
                "corrections": result.get("corrections", []),
                "summary": result.get("summary", ""),
                "improved_answer": result.get("improved_answer", ""),
                "is_correct": result.get("is_correct", False),
            }
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse correction response: {e}, response: {response[:500]}")
            # Return default response on parse error
            return {
                "scores": {"accuracy": 5, "logic": 5, "completeness": 5},
                "corrections": [],
                "summary": "Unable to parse correction response",
                "improved_answer": "",
                "is_correct": True,
            }

    def _clamp_score(self, score: Any) -> int:
        """Clamp score to valid range 1-10."""
        try:
            score_int = int(score)
            return max(1, min(10, score_int))
        except (ValueError, TypeError):
            return 5


# Global correction service instance
correction_service = CorrectionService()
