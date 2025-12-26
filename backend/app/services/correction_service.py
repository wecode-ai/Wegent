# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Correction Service - Evaluates and corrects AI responses using tool calling.

This service uses LangChain's tool calling mechanism to obtain structured
evaluation results instead of parsing JSON from free-form text.

Key features:
- Tool-based structured output (no JSON parsing needed)
- Chat history context for better understanding
- Web search tool for fact verification
- Fallback to default response on errors
"""

import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

from app.services.chat.tools.base import Tool
from app.services.chat_v2.models import LangChainModelFactory
from app.services.chat_v2.tools.builtin import SubmitEvaluationResultTool

logger = logging.getLogger(__name__)


# System prompt for evaluation using tool calling
CORRECTION_SYSTEM_PROMPT = """# Role
You are an expert AI Evaluator using the `submit_evaluation_result` tool.

# Task
Analyze the User Question and AI Response based on the provided Context/References.

# Workflow
1. **Analyze**: Check for factual errors, missing information, and logic flaws.
2. **Language Check**: Identify the language of the User Question. You MUST use this language for all text fields in the tool (description, suggestion, summary, improved_answer).
3. **Construct Output**:
   - If the original response is >90% good, do not invent issues.
   - For `improved_answer`: Apply the **Superset Rule**. Keep all good parts of the original text, only fix errors and add missing info. Do NOT output a shortened summary.
4. **Call Tool**: Execute `submit_evaluation_result` with your analysis.

# Important
- You MUST call the `submit_evaluation_result` tool to submit your evaluation.
- All text fields must be in the same language as the User Question.
- Focus on CRITICAL missing information or factual errors, not minor style issues.
"""


# User prompt template with context
CORRECTION_USER_PROMPT_WITH_CONTEXT = """The user is not satisfied with the following AI response. Please analyze the reasons.

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
"""


# User prompt template without context
CORRECTION_USER_PROMPT_NO_CONTEXT = """The user is not satisfied with the following AI response. Please analyze the reasons.

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
"""


class CorrectionService:
    """Service for evaluating and correcting AI responses using tool calling."""

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

        Uses LangChain's tool calling mechanism to obtain structured results.

        Args:
            original_question: The user's original question
            original_answer: The AI's original answer
            model_config: Model configuration for the correction model
            history: Optional chat history (list of {"role": str, "content": str})
            tools: Optional list of Tool instances (e.g., web search) - NOT USED YET

        Returns:
            Dictionary with scores, corrections, summary, improved_answer, and is_correct
        """
        try:
            # Create LangChain model from config
            llm = LangChainModelFactory.create_from_config(
                model_config, streaming=False
            )

            # Create evaluation tool
            evaluation_tool = SubmitEvaluationResultTool()

            # Bind tool with forced tool choice
            llm_with_tool = llm.bind_tools(
                [evaluation_tool], tool_choice="submit_evaluation_result"
            )

            # Build messages
            messages = self._build_messages(original_question, original_answer, history)

            # Invoke model
            set_span_attribute("correction.message_count", len(messages))
            add_span_event("correction.invoking_model")

            response = await llm_with_tool.ainvoke(messages)

            add_span_event("correction.model_invoked")

            # Extract tool call arguments
            if response.tool_calls and len(response.tool_calls) > 0:
                tool_call = response.tool_calls[0]
                args = tool_call["args"]

                set_span_attribute("correction.tool_called", True)
                set_span_attribute(
                    "correction.detected_language",
                    args.get("meta", {}).get("detected_language", "unknown"),
                )

                return self._format_result(args)

            # Fallback: no tool call (should not happen with tool_choice)
            logger.warning(
                "Model did not call evaluation tool despite tool_choice setting"
            )
            set_span_attribute("correction.tool_called", False)
            return self._default_result()

        except Exception as e:
            logger.exception("Correction evaluation error: %s", e)
            add_span_event("correction.error", {"error": str(e)})
            return self._default_result()

    def _build_messages(
        self,
        original_question: str,
        original_answer: str,
        history: list[dict[str, str]] | None = None,
    ) -> list[SystemMessage | HumanMessage]:
        """Build messages for the LLM.

        Args:
            original_question: User's question
            original_answer: AI's answer
            history: Optional chat history

        Returns:
            List of LangChain messages
        """
        messages = []

        # System message
        messages.append(SystemMessage(content=CORRECTION_SYSTEM_PROMPT))

        # Add history if provided
        if history:
            for msg in history:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                if role == "user":
                    messages.append(HumanMessage(content=content))
                elif role == "assistant":
                    # Use HumanMessage for simplicity (we just need context)
                    messages.append(HumanMessage(content=f"Assistant: {content}"))

        # User prompt with question and answer
        if history:
            user_prompt = CORRECTION_USER_PROMPT_WITH_CONTEXT.format(
                original_question=original_question, original_answer=original_answer
            )
        else:
            user_prompt = CORRECTION_USER_PROMPT_NO_CONTEXT.format(
                original_question=original_question, original_answer=original_answer
            )

        messages.append(HumanMessage(content=user_prompt))

        return messages

    def _format_result(self, args: dict[str, Any]) -> dict[str, Any]:
        """Format tool call arguments into API response format.

        Args:
            args: Tool call arguments from model

        Returns:
            Formatted result dictionary
        """
        scores = args.get("scores", {})
        issues = args.get("issues", [])

        return {
            "scores": {
                "accuracy": self._clamp_score(scores.get("accuracy", 5)),
                "logic": self._clamp_score(scores.get("logic", 5)),
                "completeness": self._clamp_score(scores.get("completeness", 5)),
            },
            "corrections": [
                {
                    "issue": issue.get("description", ""),
                    "category": issue.get("category", ""),
                    "suggestion": issue.get("suggestion", ""),
                }
                for issue in issues
            ],
            "summary": args.get("summary", ""),
            "improved_answer": args.get("improved_answer", ""),
            "is_correct": args.get("is_pass", False),
        }

    def _default_result(self) -> dict[str, Any]:
        """Return default result when evaluation fails.

        Returns:
            Default evaluation result
        """
        return {
            "scores": {"accuracy": 5, "logic": 5, "completeness": 5},
            "corrections": [],
            "summary": "Unable to evaluate response",
            "improved_answer": "",
            "is_correct": True,
        }

    def _clamp_score(self, score: Any) -> int:
        """Clamp score to valid range 1-10.

        Args:
            score: Score value to clamp

        Returns:
            Clamped score between 1 and 10
        """
        try:
            score_int = int(score)
            return max(1, min(10, score_int))
        except (ValueError, TypeError):
            return 5


# Global correction service instance
correction_service = CorrectionService()
