# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas service for managing canvas content in tasks.
"""
import logging
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.task import TaskResource

logger = logging.getLogger(__name__)


class CanvasService:
    """Service for managing canvas content."""

    def __init__(self, db: Session):
        self.db = db

    async def enable_canvas(
        self,
        task_id: int,
        initial_content: str = "",
        file_type: str = "text",
        title: str = "Untitled",
    ) -> dict[str, Any]:
        """Enable canvas mode for a task.

        Args:
            task_id: Task ID to enable canvas for
            initial_content: Initial canvas content
            file_type: File type (python, javascript, markdown, etc.)
            title: Canvas title

        Returns:
            Dictionary containing canvas state

        Raises:
            ValueError: If task not found
        """
        task = self.db.query(TaskResource).filter(TaskResource.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")

        task.canvas_enabled = True
        task.canvas_content = initial_content
        task.canvas_file_type = file_type
        task.canvas_title = title
        task.canvas_updated_at = datetime.now()
        self.db.commit()

        logger.info(f"Canvas enabled for task {task_id}")
        return {
            "enabled": True,
            "content": initial_content,
            "file_type": file_type,
            "title": title,
        }

    async def update_canvas(
        self,
        task_id: int,
        content: str,
        file_type: Optional[str] = None,
        title: Optional[str] = None,
    ) -> dict[str, Any]:
        """Update canvas content.

        Args:
            task_id: Task ID to update canvas for
            content: New canvas content
            file_type: Optional new file type
            title: Optional new title

        Returns:
            Dictionary containing updated canvas state

        Raises:
            ValueError: If task not found
        """
        task = self.db.query(TaskResource).filter(TaskResource.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")

        task.canvas_content = content
        task.canvas_updated_at = datetime.now()
        if file_type is not None:
            task.canvas_file_type = file_type
        if title is not None:
            task.canvas_title = title
        self.db.commit()

        logger.debug(f"Canvas updated for task {task_id}")
        return {
            "content": content,
            "file_type": task.canvas_file_type,
            "title": task.canvas_title,
        }

    async def get_canvas(self, task_id: int) -> dict[str, Any]:
        """Get canvas content for a task.

        Args:
            task_id: Task ID to get canvas for

        Returns:
            Dictionary containing canvas state

        Raises:
            ValueError: If task not found
        """
        task = self.db.query(TaskResource).filter(TaskResource.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")

        return {
            "enabled": task.canvas_enabled,
            "content": task.canvas_content or "",
            "file_type": task.canvas_file_type or "text",
            "title": task.canvas_title or "Untitled",
        }

    async def disable_canvas(self, task_id: int) -> dict[str, Any]:
        """Disable canvas mode for a task.

        Args:
            task_id: Task ID to disable canvas for

        Returns:
            Dictionary containing disabled state

        Raises:
            ValueError: If task not found
        """
        task = self.db.query(TaskResource).filter(TaskResource.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")

        task.canvas_enabled = False
        self.db.commit()

        logger.info(f"Canvas disabled for task {task_id}")
        return {"enabled": False}
