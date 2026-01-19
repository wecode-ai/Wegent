# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canvas document editing tool for AI-assisted document modification.

This tool allows AI agents to modify canvas documents using string replacement.
The actual execution is handled by the Backend, which validates the replacement
and updates the canvas content.
"""

import json
import logging
from typing import Any, Dict, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class UpdateCanvasInput(BaseModel):
    """Input schema for update_canvas tool."""

    old_str: str = Field(
        description="The text to replace. Must uniquely match content in the document. "
        "Provide sufficient surrounding context to ensure unique matching."
    )
    new_str: str = Field(
        description="The replacement text. Use empty string to delete content."
    )


class UpdateCanvasTool(BaseTool):
    """Canvas document editing tool for AI agents.

    This tool allows AI to modify canvas documents by specifying:
    - old_str: The exact text to replace (must uniquely match in document)
    - new_str: The replacement text

    The replacement is atomic and creates a new version in the document history.
    If old_str matches multiple locations, the operation fails and asks for more context.

    The tool execution is delegated to the Backend, which:
    1. Validates old_str uniqueness
    2. Performs the string replacement
    3. Creates a new version entry
    4. Emits WebSocket event for real-time updates

    This tool should only be registered when a canvas is active in the conversation.
    """

    name: str = "update_canvas"
    display_name: str = "编辑画布文档"
    description: str = (
        "Modify the canvas document content using string replacement. "
        "Use this tool when the user asks you to edit, update, add, or delete content in the canvas. "
        "Parameters:\n"
        "- old_str: The exact text to replace. Must uniquely match in the document. "
        "Include enough surrounding context (a few lines before and after) to ensure uniqueness.\n"
        "- new_str: The replacement text. Use empty string '' to delete content.\n"
        "\n"
        "Examples:\n"
        "- To insert text: Set old_str to the line after which you want to insert, "
        "and new_str to that line plus the new content.\n"
        "- To delete text: Set old_str to the text to delete, and new_str to empty string ''.\n"
        "- To modify text: Set old_str to the original text, and new_str to the modified version.\n"
        "\n"
        "IMPORTANT: The old_str must exactly match the document content, including whitespace and newlines."
    )
    args_schema: type[BaseModel] = UpdateCanvasInput

    # Canvas context ID (set when creating the tool)
    canvas_id: int = 0

    # Subtask ID for context
    subtask_id: int = 0

    # Task ID for WebSocket events
    task_id: int = 0

    # Callback to execute the update (set by Backend when creating tool)
    # This callback handles the actual database update and WebSocket emission
    execute_callback: Optional[Any] = None

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        old_str: str,
        new_str: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute canvas update synchronously.

        Args:
            old_str: Text to replace
            new_str: Replacement text
            run_manager: Callback manager

        Returns:
            JSON string with operation result
        """
        try:
            if not self.canvas_id:
                return json.dumps(
                    {
                        "success": False,
                        "error": "No canvas is currently active. Please open a canvas first.",
                    }
                )

            # Validate inputs
            if not old_str:
                return json.dumps(
                    {
                        "success": False,
                        "error": "old_str cannot be empty. Please provide the text to replace.",
                    }
                )

            logger.info(
                f"[UpdateCanvasTool] Updating canvas {self.canvas_id}: "
                f"old_str_len={len(old_str)}, new_str_len={len(new_str)}"
            )

            # If callback is set, use it for execution
            if self.execute_callback:
                result = self.execute_callback(
                    canvas_id=self.canvas_id,
                    old_str=old_str,
                    new_str=new_str,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                )
                return json.dumps(result, ensure_ascii=False)

            # Fallback: Return tool call info for Backend to execute
            # This happens when tool is invoked without callback (e.g., in planning mode)
            return json.dumps(
                {
                    "success": True,
                    "message": "Canvas update request prepared. "
                    "The actual update will be executed by the Backend.",
                    "canvas_id": self.canvas_id,
                    "old_str_preview": old_str[:100] + "..." if len(old_str) > 100 else old_str,
                    "new_str_preview": new_str[:100] + "..." if len(new_str) > 100 else new_str,
                },
                ensure_ascii=False,
            )

        except Exception as e:
            logger.error(f"[UpdateCanvasTool] Error: {e}", exc_info=True)
            return json.dumps(
                {
                    "success": False,
                    "error": f"Canvas update failed: {str(e)}",
                }
            )

    async def _arun(
        self,
        old_str: str,
        new_str: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute canvas update asynchronously.

        Delegates to sync version as database operations are handled by Backend.
        """
        return self._run(old_str, new_str, run_manager)


def create_canvas_tool(
    canvas_id: int,
    task_id: int,
    subtask_id: int,
    execute_callback: Optional[Any] = None,
) -> UpdateCanvasTool:
    """Factory function to create a configured UpdateCanvasTool.

    Args:
        canvas_id: Canvas context ID
        task_id: Task ID for WebSocket events
        subtask_id: Subtask ID for context
        execute_callback: Optional callback for executing updates

    Returns:
        Configured UpdateCanvasTool instance
    """
    return UpdateCanvasTool(
        canvas_id=canvas_id,
        task_id=task_id,
        subtask_id=subtask_id,
        execute_callback=execute_callback,
    )
