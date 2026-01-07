# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Correction Service - Evaluates and corrects AI responses using tool calling.

This service uses LangGraph agent workflow to conduct an impartial audit
of AI responses. It leverages:
- LangGraph for multi-step reasoning (Search -> Evaluate).
- Structured Output via `submit_evaluation_result` tool.
- Grounding via external tools (e.g., Web Search) if provided.
- Real-time progress updates via WebSocket callbacks.
"""

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from chat_shell.agents import LangGraphAgentBuilder
from chat_shell.messages import MessageConverter
from chat_shell.models import LangChainModelFactory
from chat_shell.tools import ToolRegistry
from chat_shell.tools.builtin import SubmitEvaluationResultTool
from langchain_core.messages import AIMessage
from langchain_core.tools import BaseTool
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

# Type aliases for progress callbacks
ProgressCallback = Callable[[str, str | None], Awaitable[None]]
ChunkCallback = Callable[[str, str, int], Awaitable[None]]

logger = logging.getLogger(__name__)


# -------------------------------------------------------------------------
# PROMPTS (Industrial Standard v2.0)
# -------------------------------------------------------------------------

CORRECTION_SYSTEM_PROMPT = """# Role
You are an impartial, expert AI Quality Auditor. Your job is to verify the quality of an AI response based on provided context and ground truth.

# Context & Input
You will receive:
1. **User Context**: Information about the user (if available).
2. **Conversation History**: Previous turns for context resolution.
3. **Current Turn**: The specific User Question and AI Response to evaluate.
4. **Tools**: You may have access to search tools. Use them to verify facts if the response contains claims that need grounding.

# Evaluation Protocol (Step-by-Step)

## Step 1: Fact Verification (CRITICAL)
- If you have search tools, USE THEM to verify specific claims (dates, versions, events).
- Compare the AI Response against your internal knowledge or search results.
- If the AI claims X, and reality is Y -> This is a **Critical Fact Error**.

## Step 2: Intent & Context Check
- Does the response address the specific user intent found in the History?
- Did it miss a follow-up constraint? (e.g., User asked for "Python code" previously).

## Step 3: The "Objective Audit" (Anti-Bias Rule)
**Users sometimes flag good responses incorrectly.**
- **Do NOT** assume the response is bad.
- If the response is accurate (>90% correct) and helpful, rate it highly (Score 9-10) and return an EMPTY `issues` list.
- **Do NOT** nitpick on style/tone unless it violates the User Context (e.g., using jargon for a child).

## Step 4: Constructing the Output
Call the `submit_evaluation_result` tool to finalize your report.
- **Language Constraint**: Detect the language of the **User Question**. ALL text fields in the tool (`description`, `suggestion`, `summary`, `improved_answer`) **MUST** use this language.
- **Superset Rule**: When generating `improved_answer`:
    1. You represent the "Perfect Version".
    2. You MUST RETAIN all correct, detailed, and relevant information from the original response.
    3. **Do NOT summarize** or shorten the content.
    4. Surgical-fix the errors and add missing critical info only.

# Tone
Objective, Professional, Analytical.
"""

# -------------------------------------------------------------------------
# SERVICE IMPLEMENTATION
# -------------------------------------------------------------------------


class CorrectionService:
    """Service for evaluating and correcting AI responses using LangGraph agent."""

    @trace_async(
        span_name="correction.evaluate_response",
        tracer_name="backend.services.correction",
        extract_attributes=lambda self, original_question, original_answer, model_config, history=None, tools=None: {
            "correction.model_id": model_config.get("model_id", "unknown"),
            "correction.provider": model_config.get("provider", "unknown"),
            "correction.has_history": bool(history),
            "correction.history_length": len(history) if history else 0,
            "correction.tool_count": len(tools) if tools else 0,
            "correction.question_length": len(original_question),
        },
    )
    async def evaluate_response(
        self,
        original_question: str,
        original_answer: str,
        model_config: dict[str, Any],
        history: list[dict[str, str]] | None = None,
        tools: list[BaseTool] | None = None,
        user_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Evaluate an AI response and provide corrections if needed.

        Uses LangGraph agent workflow to obtain structured results,
        consistent with chat_shell service implementation.

        Args:
            original_question: The user's original question
            original_answer: The AI's original answer
            model_config: Model configuration for the correction model
            history: Optional chat history
            tools: Optional list of Tool instances (e.g., Web Search) for fact-checking
            user_context: Optional dictionary containing user profile/settings

        Returns:
            Dictionary with scores, corrections, summary, improved_answer, and is_correct
        """
        try:
            # 1. Initialize Model (consistent with chat_shell)
            llm = LangChainModelFactory.create_from_config(
                model_config, streaming=False
            )

            # 2. Register Tools
            tool_registry = ToolRegistry()

            # Register the mandatory output tool
            evaluation_tool = SubmitEvaluationResultTool()
            tool_registry.register(evaluation_tool)

            # Register optional fact-checking tools (e.g., Search)
            # This enables the agent to search BEFORE evaluating
            if tools:
                for tool in tools:
                    tool_registry.register(tool)

            # 3. Build Agent (consistent with chat_shell)
            agent = LangGraphAgentBuilder(
                llm=llm,
                tool_registry=tool_registry,
                # Increase iterations to allow: Search -> Read -> Search -> Evaluate
                max_iterations=12,
                enable_checkpointing=False,
            )

            # 4. Construct Payload (Structured Input)
            chat_history = self._build_history(history)
            user_prompt = self._build_audit_payload(
                original_question,
                original_answer,
                history=history,
                user_context=user_context,
            )

            messages = MessageConverter.build_messages(
                history=[],  # History is embedded in the prompt payload for the Auditor context
                current_message=user_prompt,
                system_prompt=CORRECTION_SYSTEM_PROMPT,
            )

            # 5. Execute
            set_span_attribute("correction.message_count", len(messages))
            add_span_event("correction.invoking_agent")

            result = await agent.execute(messages)

            add_span_event("correction.agent_completed")

            # 6. Extract Result
            return self._extract_evaluation_result(result)

        except Exception as e:
            logger.exception("Correction evaluation error: %s", e)
            add_span_event("correction.error", {"error": str(e)})
            return self._default_result()

    async def evaluate_response_with_progress(
        self,
        original_question: str,
        original_answer: str,
        model_config: dict[str, Any],
        history: list[dict[str, str]] | None = None,
        tools: list[BaseTool] | None = None,
        user_context: dict[str, Any] | None = None,
        on_progress: ProgressCallback | None = None,
        on_chunk: ChunkCallback | None = None,
    ) -> dict[str, Any]:
        """
        Evaluate an AI response with real-time progress updates and streaming output.

        This method uses astream_events to:
        1. Capture tool events for progress updates (search, evaluation)
        2. Stream the evaluation result fields (summary, improved_answer) in real-time
        3. Return the final structured result

        Args:
            original_question: The user's original question
            original_answer: The AI's original answer
            model_config: Model configuration for the correction model
            history: Optional chat history
            tools: Optional list of Tool instances (e.g., Web Search) for fact-checking
            user_context: Optional dictionary containing user profile/settings
            on_progress: Callback for progress updates (stage, tool_name)
                        Stages: "evaluating", "verifying_facts", "generating_improvement"
            on_chunk: Callback for streaming content (field, content, offset)
                     Fields: "summary", "improved_answer"

        Returns:
            Dictionary with scores, corrections, summary, improved_answer, and is_correct
        """
        import asyncio

        try:
            # 1. Initialize Model (enable streaming for progress tracking)
            llm = LangChainModelFactory.create_from_config(model_config, streaming=True)

            # 2. Register Tools
            tool_registry = ToolRegistry()

            # Register the mandatory output tool
            evaluation_tool = SubmitEvaluationResultTool()
            tool_registry.register(evaluation_tool)

            # Register optional fact-checking tools (e.g., Search)
            if tools:
                for tool in tools:
                    tool_registry.register(tool)

            # 3. Build Agent
            agent = LangGraphAgentBuilder(
                llm=llm,
                tool_registry=tool_registry,
                max_iterations=12,
                enable_checkpointing=False,
            )

            # 4. Construct Payload
            user_prompt = self._build_audit_payload(
                original_question,
                original_answer,
                history=history,
                user_context=user_context,
            )

            messages = MessageConverter.build_messages(
                history=[],
                current_message=user_prompt,
                system_prompt=CORRECTION_SYSTEM_PROMPT,
            )

            # 5. Emit initial progress
            if on_progress:
                await on_progress("evaluating", None)

            # 6. Define tool event handler for progress updates
            def handle_tool_event(kind: str, data: dict) -> None:
                """Handle tool events for progress updates."""
                tool_name = data.get("name", "unknown")

                if kind == "tool_start":
                    # Determine stage based on tool name
                    if "search" in tool_name.lower():
                        # Schedule progress callback (non-blocking)
                        if on_progress:
                            asyncio.create_task(
                                on_progress("verifying_facts", tool_name)
                            )
                    elif tool_name == "submit_evaluation_result":
                        if on_progress:
                            asyncio.create_task(
                                on_progress("generating_improvement", tool_name)
                            )

            # 7. Execute with streaming events to capture tool events and final state
            final_state, all_events = await agent.stream_events_with_state(
                messages, on_tool_event=handle_tool_event
            )

            add_span_event("correction.agent_completed")

            # 8. Extract Result from final state
            if not final_state:
                logger.warning("No final state from stream_events_with_state")
                return self._default_result()

            final_result = self._extract_evaluation_result(final_state)

            # 9. Stream the result fields if on_chunk callback is provided
            if on_chunk and final_result:
                # Stream summary field
                summary = final_result.get("summary", "")
                if summary:
                    chunk_size = 20  # Characters per chunk
                    for i in range(0, len(summary), chunk_size):
                        chunk = summary[i : i + chunk_size]
                        await on_chunk("summary", chunk, i)
                        await asyncio.sleep(0.02)  # 20ms delay for typing effect

                # Stream improved_answer field
                improved_answer = final_result.get("improved_answer", "")
                if improved_answer:
                    chunk_size = 30  # Slightly larger chunks for longer content
                    for i in range(0, len(improved_answer), chunk_size):
                        chunk = improved_answer[i : i + chunk_size]
                        await on_chunk("improved_answer", chunk, i)
                        await asyncio.sleep(0.02)  # 20ms delay for typing effect

            return final_result

        except Exception as e:
            logger.exception("Correction evaluation error: %s", e)
            add_span_event("correction.error", {"error": str(e)})
            return self._default_result()

    def _build_history(
        self,
        history: list[dict[str, str]] | None = None,
    ) -> list[dict[str, str]]:
        """Build chat history in OpenAI format."""
        if not history:
            return []
        return [
            {"role": m.get("role", "user"), "content": m.get("content", "")}
            for m in history
        ]

    def _build_audit_payload(
        self,
        original_question: str,
        original_answer: str,
        history: list[dict[str, str]] | None = None,
        user_context: dict[str, Any] | None = None,
    ) -> str:
        """
        Constructs a structured audit payload.
        Instead of a simple string, we dump sections to help the model separate
        Context from Current Turn.
        """
        payload_sections = []

        # Section 1: User Context (if any)
        if user_context:
            payload_sections.append(
                f"--- USER PROFILE/CONTEXT ---\n{json.dumps(user_context, ensure_ascii=False, indent=2)}"
            )

        # Section 2: History (for resolving references)
        if history:
            # Limit history length to prevent token overflow if needed, or rely on model window
            history_text = json.dumps(history[-10:], ensure_ascii=False, indent=2)
            payload_sections.append(f"--- CONVERSATION HISTORY ---\n{history_text}")

        # Section 3: The Target (What to evaluate)
        target_content = (
            f"""User Question: {original_question}\nAI Response: {original_answer}"""
        )
        payload_sections.append(f"--- CURRENT TURN TO EVALUATE ---\n{target_content}")

        # Section 4: Trigger
        payload_sections.append(
            "\nINSTRUCTIONS: Please perform the impartial audit now. Use search tools if facts need verification."
        )

        return "\n\n".join(payload_sections)

    def _extract_evaluation_result(self, result: dict[str, Any]) -> dict[str, Any]:
        """Extract evaluation result from agent execution result."""
        messages = result.get("messages", [])

        # Iterate backwards to find the last successful submission
        for msg in reversed(messages):
            if isinstance(msg, AIMessage) and hasattr(msg, "tool_calls"):
                tool_calls = msg.tool_calls
                if tool_calls:
                    for tool_call in tool_calls:
                        if tool_call.get("name") == "submit_evaluation_result":
                            args = tool_call.get("args", {})

                            # Telemetry
                            set_span_attribute("correction.tool_called", True)
                            meta = args.get("meta", {})
                            set_span_attribute(
                                "correction.detected_language",
                                meta.get("detected_language", "unknown"),
                            )
                            set_span_attribute(
                                "correction.eval_status",
                                meta.get("evaluation_status", "unknown"),
                            )

                            return self._format_result(args)

        logger.warning("Agent did not call evaluation tool in any message")
        set_span_attribute("correction.tool_called", False)
        return self._default_result()

    def _format_result(self, args: dict[str, Any]) -> dict[str, Any]:
        """Format tool call arguments into API response format."""
        scores = args.get("scores", {})
        issues = args.get("issues", [])

        # Determine is_correct/is_pass
        # Prioritize explicit boolean if available, otherwise check issues list or status
        is_pass = args.get("is_pass")
        if is_pass is None:
            # Fallback logic if tool schema uses 'evaluation_status'
            status = args.get("meta", {}).get("evaluation_status", "")
            is_pass = status in ["perfect", "acceptable"] and not issues

        return {
            "scores": {
                "accuracy": self._clamp_score(scores.get("accuracy", 5)),
                "logic": self._clamp_score(scores.get("logic", 5)),
                "completeness": self._clamp_score(scores.get("completeness", 5)),
            },
            "corrections": [
                {
                    "issue": issue.get("description", ""),
                    "category": issue.get("category", "other"),
                    "suggestion": issue.get("suggestion", ""),
                }
                for issue in issues
            ],
            "summary": args.get("summary", ""),
            "improved_answer": args.get("improved_answer", ""),
            "is_correct": bool(is_pass),
        }

    def _default_result(self) -> dict[str, Any]:
        return {
            "scores": {"accuracy": 5, "logic": 5, "completeness": 5},
            "corrections": [],
            "summary": "Unable to evaluate response due to an internal error.",
            "improved_answer": "",
            "is_correct": True,  # Fail open (assume correct) to avoid disrupting user flow
        }

    def _clamp_score(self, score: Any) -> int:
        try:
            return max(1, min(10, int(score)))
        except (ValueError, TypeError):
            return 5


# Global correction service instance
correction_service = CorrectionService()
