# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Mermaid diagram rendering tool with frontend validation.

This tool sends mermaid code to the frontend for validation and rendering.
If the render fails, it automatically retries with AI-corrected code.
If all retries fail, it returns the error message so the AI can inform the user.

This module is part of the mermaid-diagram skill package and uses the
generic skill request/response infrastructure.
"""

import asyncio
import json
import logging
import uuid
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Maximum number of retry attempts for auto-correction
MAX_RETRIES = 3


class RenderMermaidInput(BaseModel):
    """Input schema for render_mermaid tool."""

    code: str = Field(..., description="Mermaid diagram code to render")
    diagram_type: Optional[str] = Field(
        default=None,
        description="Diagram type: flowchart, sequence, class, state, er, gantt, pie, mindmap, timeline, gitGraph, journey, quadrantChart, radar-beta",
    )
    title: Optional[str] = Field(
        default=None, description="Optional title for the diagram"
    )


class RenderMermaidTool(BaseTool):
    """Tool for rendering Mermaid diagrams with frontend validation.

    This tool sends mermaid code to the frontend for validation and rendering.
    If the render fails, it automatically retries with AI-corrected code.
    If all retries fail, it returns the error message so the AI can inform the user.

    This implementation uses the generic PendingRequestRegistry and emit_skill_request
    infrastructure instead of mermaid-specific code.
    """

    name: str = "render_mermaid"
    display_name: str = "渲染图表"
    description: str = """Render a Mermaid diagram. Use this tool when you need to create visual diagrams.
    
The tool will validate the mermaid syntax and return:
- On success: A confirmation that the diagram is rendered and visible to the user
- On failure: The error message with line number, so you can fix the syntax and retry

Supported diagram types:
- flowchart: Process flows, decision trees (use flowchart TD or flowchart LR)
- sequenceDiagram: Interaction sequences between components
- classDiagram: Class structures and relationships
- stateDiagram-v2: State machines and transitions
- erDiagram: Entity-relationship diagrams
- gantt: Project timelines
- pie: Proportional data
- mindmap: Hierarchical ideas
- timeline: Chronological events
- gitGraph: Git branch visualizations
- journey: User journeys
- quadrantChart: Strategic planning
- radar-beta: Radar/spider charts (experimental)

IMPORTANT syntax rules:
1. Use English for node IDs, wrap Chinese labels in quotes: A["中文标签"]
2. Avoid special characters in node IDs
3. Keep diagrams simple - split complex ones into multiple diagrams
"""

    args_schema: type[BaseModel] = RenderMermaidInput

    # Injected dependencies - these are set when creating the tool instance
    task_id: int = 0
    subtask_id: int = 0
    ws_emitter: Any = None

    # Configuration
    render_timeout: float = 30.0  # seconds

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        code: str,
        diagram_type: Optional[str] = None,
        title: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("RenderMermaidTool only supports async execution")

    async def _arun(
        self,
        code: str,
        diagram_type: Optional[str] = None,
        title: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute mermaid rendering asynchronously with auto-retry.

        Args:
            code: Mermaid diagram code
            diagram_type: Optional diagram type hint
            title: Optional diagram title
            run_manager: Callback manager

        Returns:
            JSON string with render result
        """
        # Import the generic pending request registry
        from app.chat_shell.tools.pending_requests import (
            get_pending_request_registry,
        )

        logger.info(
            f"[MermaidTool] Rendering diagram: task_id={self.task_id}, "
            f"subtask_id={self.subtask_id}, code_length={len(code)}"
        )

        if not self.ws_emitter:
            logger.error("[MermaidTool] WebSocket emitter not configured")
            return json.dumps(
                {
                    "success": False,
                    "error": "WebSocket emitter not configured. The diagram cannot be rendered at this time.",
                }
            )

        current_code = code
        last_error_response = None

        for attempt in range(MAX_RETRIES):
            logger.info(
                f"[MermaidTool] Render attempt {attempt + 1}/{MAX_RETRIES}: "
                f"task_id={self.task_id}, code_length={len(current_code)}"
            )

            # Send render request to frontend
            response = await self._send_render_request(
                current_code, diagram_type, title
            )

            if response.get("success"):
                logger.info(
                    f"[MermaidTool] Render success on attempt {attempt + 1}: "
                    f"task_id={self.task_id}"
                )
                return self._format_success(current_code)

            # Render failed, record error
            last_error_response = response
            error_info = self._format_error_for_ai(response, current_code)

            logger.warning(
                f"[MermaidTool] Render failed on attempt {attempt + 1}: "
                f"task_id={self.task_id}, error={error_info.get('error')}"
            )

            # If not the last attempt, try AI auto-correction
            if attempt < MAX_RETRIES - 1:
                corrected_code = await self._auto_correct_code(
                    original_code=current_code,
                    error_info=error_info,
                    attempt=attempt + 1,
                )

                if corrected_code and corrected_code.strip() != current_code.strip():
                    logger.info(
                        f"[MermaidTool] AI corrected code on attempt {attempt + 1}, "
                        f"will retry rendering"
                    )
                    current_code = corrected_code
                    continue
                else:
                    logger.warning(
                        f"[MermaidTool] AI could not correct code on attempt {attempt + 1}, "
                        f"stopping retries"
                    )
                    break

        # All retries failed, return final error
        logger.error(
            f"[MermaidTool] All {MAX_RETRIES} render attempts failed: "
            f"task_id={self.task_id}"
        )
        return self._format_final_error(last_error_response, code)

    async def _send_render_request(
        self,
        code: str,
        diagram_type: Optional[str],
        title: Optional[str],
    ) -> dict:
        """Send render request to frontend and wait for response.

        Args:
            code: Mermaid diagram code
            diagram_type: Optional diagram type hint
            title: Optional diagram title

        Returns:
            Response dict with success status and result/error
        """
        # Import the generic pending request registry
        from app.chat_shell.tools.pending_requests import (
            get_pending_request_registry,
        )

        # Generate unique request ID
        request_id = str(uuid.uuid4())

        # Get the global pending request registry (async to ensure Pub/Sub is started)
        registry = await get_pending_request_registry()

        try:
            # Register the pending request and get a future to await
            future = await registry.register(
                request_id=request_id,
                skill_name="mermaid-diagram",
                action="render",
                payload={
                    "code": code,
                    "diagram_type": diagram_type,
                    "title": title,
                },
                timeout_seconds=self.render_timeout,
            )

            # Emit skill request to frontend using the generic method
            logger.info(
                f"[MermaidTool] Emitting skill:request event: "
                f"request_id={request_id}, task_id={self.task_id}"
            )
            await self.ws_emitter.emit_skill_request(
                task_id=self.task_id,
                request_id=request_id,
                skill_name="mermaid-diagram",
                action="render",
                data={
                    "code": code,
                    "diagram_type": diagram_type,
                    "title": title,
                    "timeout_ms": int(self.render_timeout * 1000),
                },
            )

            # Wait for result with timeout
            try:
                response = await asyncio.wait_for(future, timeout=self.render_timeout)
                return response
            except asyncio.TimeoutError:
                logger.warning(f"[MermaidTool] Render timeout: request_id={request_id}")
                return {
                    "success": False,
                    "error": "Render timeout - frontend did not respond in time. The diagram may be too complex or the connection was lost.",
                }

        except Exception as e:
            logger.error(f"[MermaidTool] Unexpected error: {e}", exc_info=True)
            return {
                "success": False,
                "error": f"Unexpected error during rendering: {str(e)}",
            }

    async def _auto_correct_code(
        self,
        original_code: str,
        error_info: dict,
        attempt: int,
    ) -> Optional[str]:
        """Use AI to automatically correct mermaid code.

        Args:
            original_code: The original mermaid code that failed
            error_info: Error information from the failed render
            attempt: Current attempt number (1-based)

        Returns:
            Corrected mermaid code, or None if correction failed
        """
        logger.info(
            f"[MermaidTool] Attempting AI auto-correction: "
            f"task_id={self.task_id}, attempt={attempt}"
        )

        try:
            # Build correction prompt
            prompt = self._build_correction_prompt(original_code, error_info)

            # Call LLM for correction
            corrected_code = await self._call_llm_for_correction(prompt)

            if corrected_code:
                # Clean up the corrected code (remove markdown code blocks if present)
                corrected_code = self._clean_mermaid_code(corrected_code)
                logger.info(
                    f"[MermaidTool] AI correction successful: "
                    f"original_len={len(original_code)}, corrected_len={len(corrected_code)}"
                )
                return corrected_code
            else:
                logger.warning("[MermaidTool] AI returned empty correction")
                return None

        except Exception as e:
            logger.error(f"[MermaidTool] AI auto-correction failed: {e}", exc_info=True)
            return None

    def _build_correction_prompt(self, original_code: str, error_info: dict) -> str:
        """Build the prompt for AI correction.

        Args:
            original_code: The original mermaid code
            error_info: Error information dict

        Returns:
            Prompt string for the LLM
        """
        error_message = error_info.get("error", "Unknown error")
        error_line = error_info.get("error_line")
        error_line_content = error_info.get("error_line_content")
        suggestions = error_info.get("suggestions", [])

        prompt_parts = [
            "You are a Mermaid diagram syntax expert. The following Mermaid code has a syntax error.",
            "",
            "Original code:",
            "```mermaid",
            original_code,
            "```",
            "",
            f"Error message: {error_message}",
        ]

        if error_line:
            prompt_parts.append(f"Error at line: {error_line}")
        if error_line_content:
            prompt_parts.append(f"Error line content: {error_line_content}")

        if suggestions:
            prompt_parts.append("")
            prompt_parts.append("Suggestions:")
            for suggestion in suggestions:
                prompt_parts.append(f"- {suggestion}")

        prompt_parts.extend(
            [
                "",
                "Please fix the syntax error and return ONLY the corrected Mermaid code.",
                "Do not include any explanation, markdown code blocks, or other text.",
                "Just return the raw Mermaid code that can be rendered directly.",
            ]
        )

        return "\n".join(prompt_parts)

    async def _call_llm_for_correction(self, prompt: str) -> Optional[str]:
        """Call LLM to get corrected mermaid code.

        Args:
            prompt: The correction prompt

        Returns:
            Corrected code string, or None if failed
        """
        try:
            # Try to get model config from task context
            model_config = await self._get_model_config()

            if not model_config:
                logger.warning(
                    "[MermaidTool] Could not get model config, using default"
                )
                # Use a simple default config for correction
                # This should work with most OpenAI-compatible APIs
                model_config = self._get_default_model_config()

            if not model_config:
                logger.error("[MermaidTool] No model config available for correction")
                return None

            # Create LangChain model and invoke
            from app.chat_shell.models import LangChainModelFactory

            llm = LangChainModelFactory.create_from_config(
                model_config, streaming=False, temperature=0.3
            )

            # Simple invoke without tools
            response = await llm.ainvoke(prompt)

            if hasattr(response, "content"):
                return response.content
            return str(response)

        except Exception as e:
            logger.error(f"[MermaidTool] LLM call failed: {e}", exc_info=True)
            return None

    async def _get_model_config(self) -> Optional[dict]:
        """Get model configuration from task context.

        Returns:
            Model config dict, or None if not available
        """
        try:
            # Import required modules
            from app.db.session import SessionLocal
            from app.models.kind import Kind
            from app.models.task import TaskResource
            from app.schemas.kind import Bot, Task

            # Query task and get team/bot info
            db = SessionLocal()
            try:
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == self.task_id,
                        TaskResource.kind == "Task",
                        TaskResource.is_active == True,
                    )
                    .first()
                )

                if not task or not task.json:
                    logger.warning(
                        f"[MermaidTool] Task {self.task_id} not found or has no JSON"
                    )
                    return None

                task_crd = Task.model_validate(task.json)

                # Get team reference
                if not task_crd.spec or not task_crd.spec.teamRef:
                    logger.warning(f"[MermaidTool] Task {self.task_id} has no teamRef")
                    return None

                team_name = task_crd.spec.teamRef.name
                team_namespace = task_crd.spec.teamRef.namespace

                # Query team to get bot info
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Team",
                        Kind.name == team_name,
                        Kind.namespace == team_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not team or not team.json:
                    logger.warning(
                        f"[MermaidTool] Team {team_namespace}/{team_name} not found"
                    )
                    return None

                # Get first bot from team members
                team_spec = team.json.get("spec", {})
                members = team_spec.get("members", [])

                if not members:
                    logger.warning(
                        f"[MermaidTool] Team {team_namespace}/{team_name} has no members"
                    )
                    return None

                # Get first member's bot reference
                first_member = members[0]
                bot_ref = first_member.get("botRef", {})
                bot_name = bot_ref.get("name")
                bot_namespace = bot_ref.get("namespace", team_namespace)

                if not bot_name:
                    logger.warning("[MermaidTool] First team member has no botRef")
                    return None

                # Query bot
                bot = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Bot",
                        Kind.name == bot_name,
                        Kind.namespace == bot_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not bot:
                    logger.warning(
                        f"[MermaidTool] Bot {bot_namespace}/{bot_name} not found"
                    )
                    return None

                # Get model config for bot
                from app.chat_shell.models import get_model_config_for_bot

                model_config = get_model_config_for_bot(
                    db,
                    bot,
                    task.user_id,
                    override_model_name=None,
                    force_override=False,
                )

                logger.info(
                    f"[MermaidTool] Got model config: model_id={model_config.get('model_id')}"
                )
                return model_config

            finally:
                db.close()

        except Exception as e:
            logger.error(
                f"[MermaidTool] Failed to get model config: {e}", exc_info=True
            )
            return None

    def _get_default_model_config(self) -> Optional[dict]:
        """Get a default model configuration for correction.

        Returns:
            Default model config dict, or None if not available
        """
        import os

        # Try to get from environment variables
        api_key = os.environ.get("OPENAI_API_KEY", "")
        base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        model_id = os.environ.get("OPENAI_MODEL_ID", "gpt-4o-mini")

        if not api_key:
            # Try alternative env vars
            api_key = os.environ.get("WECODE_API_KEY", "")

        if not api_key:
            logger.warning("[MermaidTool] No API key found for default model config")
            return None

        return {
            "api_key": api_key,
            "base_url": base_url,
            "model_id": model_id,
            "model": "openai",
        }

    def _clean_mermaid_code(self, code: str) -> str:
        """Clean up mermaid code by removing markdown code blocks.

        Args:
            code: Raw code that may contain markdown formatting

        Returns:
            Clean mermaid code
        """
        code = code.strip()

        # Remove markdown code blocks
        if code.startswith("```mermaid"):
            code = code[len("```mermaid") :].strip()
        elif code.startswith("```"):
            code = code[3:].strip()

        if code.endswith("```"):
            code = code[:-3].strip()

        return code

    def _format_success(self, code: str) -> str:
        """Format success response.

        Args:
            code: The successfully rendered mermaid code

        Returns:
            JSON string with success message
        """
        success_message = (
            "Mermaid diagram rendered successfully!\n\n"
            "Now output the following mermaid code block in your response "
            "so it will be displayed to the user:\n\n"
            "```mermaid\n"
            f"{code}\n"
            "```\n\n"
            "This will ensure the diagram is saved in the conversation history "
            "and can be referenced later."
        )
        return json.dumps({"success": True, "message": success_message})

    def _format_error_for_ai(self, result: dict, original_code: str) -> dict:
        """Format error message for AI to understand and fix.

        Args:
            result: Error result from frontend. The 'error' field can be:
                    - A dict with 'message', 'line', 'column', 'details' (structured error)
                    - A string (legacy format)
                    - None
            original_code: The original mermaid code

        Returns:
            Formatted error dictionary
        """
        # Extract error information - handle both structured and string formats
        error_data = result.get("error")

        if isinstance(error_data, dict):
            # Structured error format from frontend
            error_message = error_data.get("message", "Unknown render error")
            error_line = error_data.get("line")
            error_column = error_data.get("column")
            error_details = error_data.get("details")
        else:
            # Legacy string format or None
            error_message = error_data if error_data else "Unknown render error"
            error_line = result.get("error_line")
            error_column = None
            error_details = result.get("error_details")

        error_info = {
            "success": False,
            "error": error_message,
        }

        if error_line:
            error_info["error_line"] = error_line
            # Add context around the error line
            lines = original_code.split("\n")
            if 0 < error_line <= len(lines):
                error_info["error_line_content"] = lines[error_line - 1]

        if error_column:
            error_info["error_column"] = error_column

        if error_details:
            error_info["error_details"] = error_details

        # Add fix suggestions based on error type
        suggestions = self._get_fix_suggestions(error_message.lower())
        if suggestions:
            error_info["suggestions"] = suggestions

        error_info["hint"] = (
            "Please fix the syntax error and call render_mermaid again with the corrected code."
        )

        return error_info

    def _format_final_error(self, error_response: dict, original_code: str) -> str:
        """Format final error message after all retries failed.

        This method returns an error message that explicitly instructs the AI
        NOT to output any mermaid code block, since all rendering attempts failed.

        Args:
            error_response: The last error response from frontend
            original_code: The original mermaid code

        Returns:
            JSON string with error info and final instruction
        """
        error_info = self._format_error_for_ai(error_response or {}, original_code)

        # Add critical instruction to prevent AI from outputting broken mermaid code
        error_info["final_instruction"] = (
            "CRITICAL: All automatic correction attempts have failed. "
            "DO NOT output any mermaid code block in your response. "
            "Instead, explain to the user that the diagram could not be rendered "
            "due to syntax errors, and show them the error details so they can help fix it. "
            "You may describe what the diagram was supposed to show in plain text."
        )

        error_info["original_code"] = original_code
        error_info["retry_count"] = MAX_RETRIES

        return json.dumps(error_info, ensure_ascii=False, indent=2)

    def _get_fix_suggestions(self, error_msg: str) -> list:
        """Get fix suggestions based on error type.

        Args:
            error_msg: The error message (lowercase)

        Returns:
            List of suggestion strings
        """
        suggestions = []

        if "unexpected token" in error_msg or "parse error" in error_msg:
            suggestions.append(
                "Check for missing arrows (-->), unclosed brackets, or special characters"
            )
            suggestions.append(
                "Verify the diagram type declaration (e.g., flowchart TD, sequenceDiagram)"
            )

        if "syntax error" in error_msg:
            suggestions.append(
                "Review the mermaid syntax for the specific diagram type"
            )
            suggestions.append(
                "Ensure all node IDs use alphanumeric characters and underscores only"
            )

        if "timeout" in error_msg:
            suggestions.append(
                "The diagram may be too complex - try splitting into smaller diagrams"
            )

        if "chinese" in error_msg or "unicode" in error_msg or "character" in error_msg:
            suggestions.append(
                'Use English for node IDs and wrap Chinese labels in quotes: A["中文标签"]'
            )

        if not suggestions:
            suggestions.append("Review the mermaid syntax documentation")
            suggestions.append("Ensure proper indentation and formatting")

        return suggestions
