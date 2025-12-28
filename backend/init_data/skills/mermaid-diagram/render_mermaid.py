# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Mermaid diagram rendering tool with frontend validation.

This tool sends mermaid code to the frontend for validation and rendering.
If the render fails, it returns the error message so the AI can fix the syntax.
If successful, the diagram is displayed to the user.

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
    If the render fails, it returns the error message so the AI can fix the syntax.
    If successful, the diagram is displayed to the user.

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
        """Execute mermaid rendering asynchronously.

        Args:
            code: Mermaid diagram code
            diagram_type: Optional diagram type hint
            title: Optional diagram title
            run_manager: Callback manager

        Returns:
            JSON string with render result
        """
        # Import the generic pending request registry
        from app.services.chat_v2.tools.pending_requests import (
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
            except asyncio.TimeoutError:
                logger.warning(f"[MermaidTool] Render timeout: request_id={request_id}")
                return json.dumps(
                    {
                        "success": False,
                        "error": "Render timeout - frontend did not respond in time. The diagram may be too complex or the connection was lost.",
                        "hint": "Try simplifying the diagram or splitting it into smaller parts.",
                    }
                )

            # Response format: { success: bool, result: any, error: any }
            # This is the complete response built by on_skill_response
            success = response.get("success", False)
            result_data = response.get("result")
            error_data = response.get("error")

            if success:
                logger.info(f"[MermaidTool] Render success: request_id={request_id}")
                # Build success message instructing AI to output mermaid code block
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
            else:
                # Return error for AI to fix
                # Build a result dict compatible with _format_error_for_ai
                error_result = {"error": error_data}
                error_info = self._format_error_for_ai(error_result, code)
                logger.info(
                    f"[MermaidTool] Render failed: request_id={request_id}, "
                    f"error={error_data}"
                )
                return json.dumps(error_info)

        except Exception as e:
            logger.error(f"[MermaidTool] Unexpected error: {e}", exc_info=True)
            return json.dumps(
                {
                    "success": False,
                    "error": f"Unexpected error during rendering: {str(e)}",
                }
            )

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
