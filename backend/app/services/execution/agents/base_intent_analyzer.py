# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base intent analyzer for follow-up messages.

Provides shared LLM-call infrastructure for image and video intent analysis
in multi-turn generation conversations.
"""

import json
import logging
from typing import Optional

from app.core.payload_codec import run_payload_codec

logger = logging.getLogger(__name__)


class BaseIntentAnalyzer:
    """Shared LLM infrastructure for generation intent analysis."""

    async def _call_llm_json(
        self,
        prompt: str,
        model_config: dict,
    ) -> Optional[dict]:
        """Call secondary LLM and return parsed JSON result.

        Args:
            prompt: Full prompt string to send to LLM
            model_config: LLM configuration (api_key, base_url, model_id)

        Returns:
            Parsed JSON dict from LLM, or None on failure
        """
        from openai import AsyncOpenAI

        async with AsyncOpenAI(
            api_key=model_config.get("api_key"),
            base_url=model_config.get("base_url"),
        ) as client:
            try:
                response = await client.chat.completions.create(
                    model=model_config.get("model_id", "gpt-4o-mini"),
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0,
                    response_format={"type": "json_object"},
                )
                content = response.choices[0].message.content
                return await run_payload_codec(
                    json.loads,
                    content,
                    payload_hint=content,
                )
            except Exception as e:
                logger.exception(f"[{self.__class__.__name__}] LLM call failed: {e}")
                return None
