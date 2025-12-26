# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Correction Service - Evaluates and corrects AI responses.

This service supports:
- Chat history context for better understanding of conversation flow
- Web search tool for fact verification
- Tool calling flow with request count and time limiting
"""

import asyncio
import json
import logging
import re
import time
from typing import Any

from app.core.config import settings
from app.services.chat.base import get_http_client
from app.services.chat.message_builder import message_builder
from app.services.chat.providers import get_provider
from app.services.chat.providers.base import ChunkType
from app.services.chat.tool_handler import ToolCallAccumulator, ToolHandler
from app.services.chat.tools.base import Tool
from shared.telemetry.decorators import trace_async, add_span_event, set_span_attribute

logger = logging.getLogger(__name__)


CORRECTION_PROMPT_TEMPLATE = """The user is not satisfied with the following AI response. Please analyze the reasons.

## Conversation Context
The above messages show the conversation history leading up to this response.

## User Question (Current)
{original_question}

## AI Response (User Not Satisfied)
{original_answer}

## Analysis Requirements
Please analyze from the following perspectives:

1. **Context Relevance**: Does the response properly address the conversation context?

2. **Why might the user be dissatisfied?** - Focus on **missing CRITICAL information** (key concepts, specific details) or **factual errors**.
   - **DO NOT** criticize the structure if it is already clear (e.g., bullet points are usually good).
   - **DO NOT** be overly pedantic. If the original answer is 90% good, only flag the 10% missing.

3. **Fact verification**: Verify all factual claims. **Use the search tool if available** to verify facts.

4. **Logic errors**: Check for fallacies or contradictions.

5. **Missing considerations**: Identify truly important missing perspectives.

## Language Constraint (CRITICAL)
**You MUST detect the language of the `{original_question}`.** **ALL content within the JSON values (including "summary", "issue", "suggestion", and "improved_answer") MUST be written in that SAME detected language.** (e.g., if the question is Chinese, the entire JSON content must be Chinese).

## Output Format (JSON)
You MUST respond with ONLY a valid JSON object:
{{
  "scores": {{
    "accuracy": <1-10>,
    "logic": <1-10>,
    "completeness": <1-10>
  }},
  "corrections": [
    {{
      "issue": "Brief description of the problem in the detected language", 
      "category": "context_mismatch|fact_error|logic_error|missing_point", 
      "suggestion": "How to fix it in the detected language"
    }}
  ],
  "summary": "Summary of why user is dissatisfied (2-3 sentences) in the detected language",
  "improved_answer": "Provide the COMPLETE corrected answer in the detected language. IMPORTANT: This answer must INTEGRATE the corrections while RETAINING all correct and relevant details from the original response. Do NOT summarize or shorten the original content unless it was repetitive.",
  "is_correct": <true/false>
}}"""


# Prompt template without context (for backward compatibility when no history)
CORRECTION_PROMPT_TEMPLATE_NO_CONTEXT = """The user is not satisfied with the following AI response. Please analyze the reasons.

## User Question
{original_question}

## AI Response (User Not Satisfied)
{original_answer}

## Analysis Requirements
Please analyze from the following perspectives:

1. **Why might the user be dissatisfied?** - Focus on **missing CRITICAL information** (key concepts, specific details) or **factual errors**.
   - **DO NOT** criticize the structure if it is already clear (e.g., bullet points are usually good).
   - **DO NOT** be overly pedantic. If the original answer is 90% good, only flag the 10% missing.

2. **Fact verification**: Verify all factual claims. **Use the search tool if available** to verify facts.

3. **Logic errors**: Check for fallacies or contradictions.

4. **Missing considerations**: Identify truly important missing perspectives.

## Language Constraint (CRITICAL)
**You MUST detect the language of the `{original_question}`.** **ALL content within the JSON values (including "summary", "issue", "suggestion", and "improved_answer") MUST be written in that SAME detected language.** (e.g., if the question is Chinese, the entire JSON content must be Chinese).

## Output Format (JSON)
You MUST respond with ONLY a valid JSON object:
{{
  "scores": {{
    "accuracy": <1-10>,
    "logic": <1-10>,
    "completeness": <1-10>
  }},
  "corrections": [
    {{
      "issue": "Brief description of the problem in the detected language", 
      "category": "dissatisfaction|fact_error|logic_error|missing_point", 
      "suggestion": "How to fix it in the detected language"
    }}
  ],
  "summary": "Summary of why user is dissatisfied (2-3 sentences) in the detected language",
  "improved_answer": "Provide the COMPLETE corrected answer in the detected language. IMPORTANT: This answer must INTEGRATE the corrections while RETAINING all correct and relevant details from the original response. Do NOT summarize or shorten the original content unless it was repetitive.",
  "is_correct": <true/false>
}}"""


# Configuration for tool calling limits
CORRECTION_TOOL_MAX_REQUESTS = 3  # Maximum tool calling iterations
CORRECTION_TOOL_MAX_TIME_SECONDS = 30  # Maximum time for tool calling flow

class CorrectionService:
    """Service for evaluating and correcting AI responses."""

    @trace_async(
        span_name="correction.evaluate_response",
        tracer_name="backend.services.correction",
        extract_attributes=lambda self, original_question, original_answer, model_config, history=None, tools=None: {
            "correction.model_id": model_config.get("model_id", "unknown"),
            "correction.provider": model_config.get("provider", "unknown"),
            "correction.has_history": history is not None and len(history) > 0,
            "correction.history_length": len(history) if history else 0,
            "correction.has_tools": tools is not None and len(tools) > 0,
            "correction.question_length": len(original_question),
            "correction.answer_length": len(original_answer),
        },
    )
    async def evaluate_response(
        self,
        original_question: str,
        original_answer: str,
        model_config: dict[str, Any],
        history: list[dict[str, str]] | None = None,
        tools: list[Tool] | None = None,
    ) -> dict[str, Any]:
        """
        Evaluate an AI response and provide corrections if needed.

        Args:
            original_question: The user's original question
            original_answer: The AI's original answer
            model_config: Model configuration for the correction model
            history: Optional chat history (list of {"role": str, "content": str})
            tools: Optional list of Tool instances (e.g., web search)

        Returns:
            Dictionary with scores, corrections, summary, improved_answer, and is_correct
        """
        # Choose prompt template based on whether history is provided
        if history:
            prompt = CORRECTION_PROMPT_TEMPLATE.format(
                original_question=original_question, original_answer=original_answer
            )
        else:
            prompt = CORRECTION_PROMPT_TEMPLATE_NO_CONTEXT.format(
                original_question=original_question, original_answer=original_answer
            )

        # Build messages for the LLM
        messages = message_builder.build_messages(
            history=history or [],
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
            if tools:
                # Use tool calling flow
                tool_handler = ToolHandler(tools)
                async for chunk in self._handle_tool_calling_flow(
                    provider, messages, tool_handler, cancel_event
                ):
                    if chunk.type == ChunkType.CONTENT and chunk.content:
                        accumulated_content += chunk.content
                    elif chunk.type == ChunkType.ERROR:
                        raise ValueError(chunk.error or "Unknown error from LLM")
            else:
                # Simple streaming without tools
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

    async def _handle_tool_calling_flow(
        self,
        provider,
        messages: list[dict[str, Any]],
        tool_handler: ToolHandler,
        cancel_event: asyncio.Event,
    ):
        """
        Handle tool calling flow with request count and time limiting.

        The flow suppresses all intermediate content and only outputs the final
        response after tool execution is complete.

        Args:
            provider: LLM provider instance
            messages: Conversation messages
            tool_handler: Tool handler instance
            cancel_event: Cancellation event

        Yields:
            StreamChunk objects for the final response only
        """
        max_requests = CORRECTION_TOOL_MAX_REQUESTS
        max_time_seconds = CORRECTION_TOOL_MAX_TIME_SECONDS

        tools = tool_handler.format_for_provider(provider.provider_name)
        start_time = time.monotonic()
        request_count = 0
        all_tool_results: list[dict[str, Any]] = []

        # Extract original question content for summary request
        original_question = messages[-1]

        while request_count < max_requests:
            # Check time limit
            elapsed = time.monotonic() - start_time
            if elapsed >= max_time_seconds:
                logger.warning(
                    "Correction tool calling flow exceeded time limit: %.1fs >= %.1fs",
                    elapsed,
                    max_time_seconds,
                )
                break

            # Check cancellation
            if cancel_event.is_set():
                return

            request_count += 1
            logger.debug(
                "Correction tool calling request %d/%d, elapsed %.1fs/%.1fs",
                request_count,
                max_requests,
                elapsed,
                max_time_seconds,
            )
            accumulator = ToolCallAccumulator()

            async for chunk in provider.stream_chat(
                messages, cancel_event, tools=tools
            ):
                if chunk.type == ChunkType.TOOL_CALL and chunk.tool_call:
                    # Pass thought_signature for Gemini 3 Pro function calling support
                    accumulator.add_chunk(chunk.tool_call, chunk.thought_signature)

            # No tool calls - exit loop to generate final response
            if not accumulator.has_calls():
                break

            # Execute tool calls (suppress intermediate content)
            tool_calls = accumulator.get_calls()
            # Add assistant message with tool calls
            messages.append(ToolHandler.build_assistant_message(None, tool_calls))
            # Execute tools and collect results
            tool_results = await tool_handler.execute_all(tool_calls)
            messages.extend(tool_results)
            all_tool_results.extend(tool_results)

            logger.info(
                "Correction executed %d tool calls in step %d",
                len(tool_calls),
                request_count,
            )

        logger.info(
            "Correction tool calling flow completed (requests=%d, time=%.1fs, tool_calls=%d), "
            "generating final response",
            request_count,
            time.monotonic() - start_time,
            len(all_tool_results),
        )

        # If tool execution occurred, add summary request
        if all_tool_results:
            summary_request = (
                "Based on the tool execution results above, provide your final correction analysis. "
                "Remember to output ONLY valid JSON in the required format."
            )
            messages.append({"role": "user", "content": summary_request})
            messages.append(original_question)

        # Final request without tools to get the response
        async for chunk in provider.stream_chat(messages, cancel_event, tools=None):
            yield chunk

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
            logger.error(
                f"Failed to parse correction response: {e}, response: {response[:500]}"
            )
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
