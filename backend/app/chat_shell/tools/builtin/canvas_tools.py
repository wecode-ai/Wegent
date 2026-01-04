# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canvas tools for AI to interact with canvas content."""

import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class UpdateCanvasInput(BaseModel):
    """Input for updating canvas content."""

    content: str = Field(..., description="The new content for the canvas")
    file_type: Optional[str] = Field(
        None, description="File type (python, javascript, markdown, etc.)"
    )
    title: Optional[str] = Field(None, description="Canvas title")
    explanation: Optional[str] = Field(None, description="Explanation of changes")


class UpdateCanvasTool(BaseTool):
    """Tool for AI to update the canvas content.

    When user asks to create or modify code/document, use this tool
    to update the shared canvas content.
    """

    name: str = "update_canvas"
    display_name: str = "更新画布"
    description: str = (
        "Update the shared canvas content. Use this when the user asks you to "
        "create, modify, or improve code or documents. The canvas is shared "
        "across the entire conversation."
    )
    args_schema: type[BaseModel] = UpdateCanvasInput

    # Injected at runtime
    task_id: int = 0
    db_session: Any = None
    ws_emitter: Any = None

    def _run(
        self,
        content: str,
        file_type: Optional[str] = None,
        title: Optional[str] = None,
        explanation: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("UpdateCanvasTool only supports async execution")

    async def _arun(
        self,
        content: str,
        file_type: Optional[str] = None,
        title: Optional[str] = None,
        explanation: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Update canvas content and emit WebSocket event.

        Args:
            content: New canvas content
            file_type: File type
            title: Canvas title
            explanation: Explanation of changes
            run_manager: Callback manager

        Returns:
            Success message
        """
        try:
            from app.services.canvas_service import CanvasService

            if not self.db_session:
                return json.dumps({"error": "Database session not available"})

            # Save to database
            service = CanvasService(self.db_session)
            await service.update_canvas(
                task_id=self.task_id,
                content=content,
                file_type=file_type,
                title=title,
            )

            # Emit WebSocket event for real-time sync
            if self.ws_emitter:
                await self.ws_emitter.emit_canvas_update(
                    task_id=self.task_id,
                    content=content,
                    file_type=file_type,
                    title=title,
                )

            message = f"Canvas updated successfully. {explanation or ''}"
            logger.info(f"Canvas updated for task {self.task_id}")
            return json.dumps({"success": True, "message": message})

        except Exception as e:
            logger.error(f"Error updating canvas: {e}")
            return json.dumps({"error": f"Failed to update canvas: {str(e)}"})


class EditCanvasSelectionInput(BaseModel):
    """Input for editing a selection in the canvas."""

    modified_content: str = Field(
        ..., description="The modified content for the selection"
    )
    explanation: Optional[str] = Field(None, description="Explanation of changes")


class EditCanvasSelectionTool(BaseTool):
    """Tool for AI to edit a specific selection in the canvas.

    When user selects text in the canvas and requests an edit,
    use this tool to modify only the selected portion.
    """

    name: str = "edit_canvas_selection"
    display_name: str = "编辑画布选中内容"
    description: str = (
        "Edit a specific selection in the canvas. Use this when the user "
        "selects text in the canvas and requests modifications like refactor, "
        "explain, polish, translate, or fix."
    )
    args_schema: type[BaseModel] = EditCanvasSelectionInput

    # Injected at runtime
    task_id: int = 0
    selection_start: int = 0
    selection_end: int = 0
    selection_text: str = ""
    ws_emitter: Any = None

    def _run(
        self,
        modified_content: str,
        explanation: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError(
            "EditCanvasSelectionTool only supports async execution"
        )

    async def _arun(
        self,
        modified_content: str,
        explanation: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Edit canvas selection and emit WebSocket event.

        Args:
            modified_content: Modified content for the selection
            explanation: Explanation of changes
            run_manager: Callback manager

        Returns:
            Success message
        """
        try:
            # Emit WebSocket event with the edit
            if self.ws_emitter:
                await self.ws_emitter.emit_canvas_selection_edit(
                    task_id=self.task_id,
                    selection_start=self.selection_start,
                    selection_end=self.selection_end,
                    modified_content=modified_content,
                    explanation=explanation,
                )

            message = f"Selection edited successfully. {explanation or ''}"
            logger.info(
                f"Canvas selection edited for task {self.task_id} (range: {self.selection_start}-{self.selection_end})"
            )
            return json.dumps({"success": True, "message": message})

        except Exception as e:
            logger.error(f"Error editing canvas selection: {e}")
            return json.dumps({"error": f"Failed to edit selection: {str(e)}"})
