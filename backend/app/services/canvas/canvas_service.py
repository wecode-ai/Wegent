# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas service for managing canvas documents.

Handles canvas creation, updates, version management, and rollback operations.
Uses SubtaskContext with context_type='canvas' for storage.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, SubtaskContext
from app.schemas.canvas import (
    CanvasCreateRequest,
    CanvasResponse,
    CanvasUpdateResult,
    CanvasVersionResponse,
    VersionInfo,
)

logger = logging.getLogger(__name__)

# Canvas context type constant
CANVAS_CONTEXT_TYPE = "canvas"


class CanvasNotFoundException(Exception):
    """Exception raised when a canvas is not found."""

    pass


class CanvasUpdateError(Exception):
    """Exception raised when canvas update fails."""

    pass


class CanvasService:
    """
    Canvas service for managing collaborative document editing.

    Uses SubtaskContext model with context_type='canvas' for storage.
    Supports version history and AI/user bidirectional editing.
    """

    def create_canvas(
        self,
        db: Session,
        user_id: int,
        subtask_id: int,
        filename: Optional[str] = None,
        content: Optional[str] = None,
    ) -> SubtaskContext:
        """
        Create a new canvas document.

        Args:
            db: Database session
            user_id: User ID
            subtask_id: Subtask ID to associate canvas with
            filename: Optional initial filename
            content: Optional initial content

        Returns:
            Created SubtaskContext record
        """
        now = datetime.now(timezone.utc).isoformat()
        filename = filename or "untitled.txt"
        content = content or ""

        # Initial version
        initial_version = {
            "version": 1,
            "content": content,
            "timestamp": now,
            "source": "user",
        }

        type_data = {
            "filename": filename,
            "content": content,
            "version": 1,
            "versions": [initial_version],
            "created_at": now,
            "updated_at": now,
        }

        context = SubtaskContext(
            subtask_id=subtask_id,
            user_id=user_id,
            context_type=CANVAS_CONTEXT_TYPE,
            name=filename,
            status=ContextStatus.READY.value,
            binary_data=b"",
            image_base64="",
            extracted_text=content,
            text_length=len(content),
            error_message="",
            type_data=type_data,
        )

        db.add(context)
        db.commit()
        db.refresh(context)

        logger.info(
            f"Canvas created: id={context.id}, subtask_id={subtask_id}, "
            f"filename={filename}"
        )

        return context

    def get_canvas(
        self,
        db: Session,
        canvas_id: int,
        user_id: Optional[int] = None,
    ) -> SubtaskContext:
        """
        Get canvas by ID.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            user_id: Optional user ID for ownership check

        Returns:
            SubtaskContext record

        Raises:
            CanvasNotFoundException: If canvas not found
        """
        query = db.query(SubtaskContext).filter(
            SubtaskContext.id == canvas_id,
            SubtaskContext.context_type == CANVAS_CONTEXT_TYPE,
        )

        if user_id is not None:
            query = query.filter(SubtaskContext.user_id == user_id)

        canvas = query.first()
        if not canvas:
            raise CanvasNotFoundException(f"Canvas {canvas_id} not found")

        return canvas

    def get_canvas_optional(
        self,
        db: Session,
        canvas_id: int,
        user_id: Optional[int] = None,
    ) -> Optional[SubtaskContext]:
        """
        Get canvas by ID, returning None if not found.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            user_id: Optional user ID for ownership check

        Returns:
            SubtaskContext record or None
        """
        try:
            return self.get_canvas(db, canvas_id, user_id)
        except CanvasNotFoundException:
            return None

    def get_canvas_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> Optional[SubtaskContext]:
        """
        Get canvas by subtask ID.

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            SubtaskContext record or None
        """
        return (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == CANVAS_CONTEXT_TYPE,
            )
            .first()
        )

    def update_canvas_user(
        self,
        db: Session,
        canvas_id: int,
        content: str,
        user_id: Optional[int] = None,
    ) -> SubtaskContext:
        """
        Update canvas content (user edit).

        Creates a new version entry and updates the current content.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            content: New document content
            user_id: Optional user ID for ownership check

        Returns:
            Updated SubtaskContext record

        Raises:
            CanvasNotFoundException: If canvas not found
        """
        canvas = self.get_canvas(db, canvas_id, user_id)
        type_data = canvas.type_data or {}
        now = datetime.now(timezone.utc).isoformat()

        # Create new version
        new_version_num = type_data.get("version", 0) + 1
        versions = type_data.get("versions", [])
        versions.append(
            {
                "version": new_version_num,
                "content": content,
                "timestamp": now,
                "source": "user",
            }
        )

        # Update type_data
        type_data.update(
            {
                "content": content,
                "version": new_version_num,
                "versions": versions,
                "updated_at": now,
            }
        )

        canvas.type_data = type_data
        canvas.extracted_text = content
        canvas.text_length = len(content)

        db.commit()
        db.refresh(canvas)

        logger.info(
            f"Canvas {canvas_id} updated by user: version={new_version_num}, "
            f"content_length={len(content)}"
        )

        return canvas

    def update_canvas_ai(
        self,
        db: Session,
        canvas_id: int,
        old_str: str,
        new_str: str,
    ) -> CanvasUpdateResult:
        """
        Update canvas content (AI edit) using string replacement.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            old_str: Text to replace (must uniquely match in document)
            new_str: Replacement text

        Returns:
            CanvasUpdateResult with success status and new content

        Raises:
            CanvasNotFoundException: If canvas not found
        """
        canvas = self.get_canvas(db, canvas_id)
        type_data = canvas.type_data or {}
        current_content = type_data.get("content", "")

        # Validate old_str uniqueness
        occurrences = current_content.count(old_str)
        if occurrences == 0:
            return CanvasUpdateResult(
                success=False,
                error=f"old_str not found in document",
            )
        if occurrences > 1:
            return CanvasUpdateResult(
                success=False,
                error=f"old_str matches {occurrences} locations, please provide more context",
            )

        # Execute replacement
        new_content = current_content.replace(old_str, new_str, 1)
        now = datetime.now(timezone.utc).isoformat()

        # Create new version
        new_version_num = type_data.get("version", 0) + 1
        versions = type_data.get("versions", [])
        versions.append(
            {
                "version": new_version_num,
                "content": new_content,
                "timestamp": now,
                "source": "ai",
                "old_str": old_str,
                "new_str": new_str,
            }
        )

        # Update type_data
        type_data.update(
            {
                "content": new_content,
                "version": new_version_num,
                "versions": versions,
                "updated_at": now,
            }
        )

        canvas.type_data = type_data
        canvas.extracted_text = new_content
        canvas.text_length = len(new_content)

        db.commit()
        db.refresh(canvas)

        logger.info(
            f"Canvas {canvas_id} updated by AI: version={new_version_num}, "
            f"old_str_len={len(old_str)}, new_str_len={len(new_str)}"
        )

        return CanvasUpdateResult(
            success=True,
            new_content=new_content,
            version=new_version_num,
            diff_info={
                "old_str": old_str,
                "new_str": new_str,
            },
        )

    def get_versions(
        self,
        db: Session,
        canvas_id: int,
        user_id: Optional[int] = None,
    ) -> List[VersionInfo]:
        """
        Get version history for a canvas.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            user_id: Optional user ID for ownership check

        Returns:
            List of VersionInfo objects

        Raises:
            CanvasNotFoundException: If canvas not found
        """
        canvas = self.get_canvas(db, canvas_id, user_id)
        type_data = canvas.type_data or {}
        versions_data = type_data.get("versions", [])

        return [VersionInfo(**v) for v in versions_data]

    def get_version(
        self,
        db: Session,
        canvas_id: int,
        version: int,
        user_id: Optional[int] = None,
    ) -> Optional[VersionInfo]:
        """
        Get a specific version.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            version: Version number
            user_id: Optional user ID for ownership check

        Returns:
            VersionInfo or None if version not found

        Raises:
            CanvasNotFoundException: If canvas not found
        """
        versions = self.get_versions(db, canvas_id, user_id)
        for v in versions:
            if v.version == version:
                return v
        return None

    def rollback_to_version(
        self,
        db: Session,
        canvas_id: int,
        version: int,
        user_id: Optional[int] = None,
    ) -> SubtaskContext:
        """
        Rollback canvas to a specific version.

        Creates a new version entry with the content from the target version.

        Args:
            db: Database session
            canvas_id: Canvas context ID
            version: Version number to rollback to
            user_id: Optional user ID for ownership check

        Returns:
            Updated SubtaskContext record

        Raises:
            CanvasNotFoundException: If canvas not found
            CanvasUpdateError: If version not found
        """
        canvas = self.get_canvas(db, canvas_id, user_id)
        type_data = canvas.type_data or {}
        versions = type_data.get("versions", [])

        # Find target version
        target_version = None
        for v in versions:
            if v.get("version") == version:
                target_version = v
                break

        if not target_version:
            raise CanvasUpdateError(f"Version {version} not found")

        target_content = target_version.get("content", "")
        now = datetime.now(timezone.utc).isoformat()

        # Create new version (rollback)
        new_version_num = type_data.get("version", 0) + 1
        versions.append(
            {
                "version": new_version_num,
                "content": target_content,
                "timestamp": now,
                "source": "user",
                "rollback_from": version,
            }
        )

        # Update type_data
        type_data.update(
            {
                "content": target_content,
                "version": new_version_num,
                "versions": versions,
                "updated_at": now,
            }
        )

        canvas.type_data = type_data
        canvas.extracted_text = target_content
        canvas.text_length = len(target_content)

        db.commit()
        db.refresh(canvas)

        logger.info(
            f"Canvas {canvas_id} rolled back to version {version}: "
            f"new_version={new_version_num}"
        )

        return canvas

    def to_response(self, canvas: SubtaskContext) -> CanvasResponse:
        """
        Convert SubtaskContext to CanvasResponse.

        Args:
            canvas: SubtaskContext record

        Returns:
            CanvasResponse object
        """
        type_data = canvas.type_data or {}
        return CanvasResponse(
            id=canvas.id,
            subtask_id=canvas.subtask_id,
            filename=type_data.get("filename", "untitled.txt"),
            content=type_data.get("content", ""),
            version=type_data.get("version", 1),
            created_at=canvas.created_at,
            updated_at=canvas.updated_at,
        )

    def build_canvas_prompt_context(
        self,
        canvas: SubtaskContext,
    ) -> str:
        """
        Build prompt context for LLM including canvas content.

        Adds line numbers for precise location reference.

        Args:
            canvas: SubtaskContext record

        Returns:
            Formatted context string
        """
        type_data = canvas.type_data or {}
        content = type_data.get("content", "")
        filename = type_data.get("filename", "untitled.txt")
        version = type_data.get("version", 1)

        # Add line numbers
        content_with_lines = "\n".join(
            f"{idx+1} | {line}" for idx, line in enumerate(content.split("\n"))
        )

        return f"""[Canvas Document Context]
Filename: {filename}
Version: {version}
Content:
```
{content_with_lines}
```
"""


# Global service instance
canvas_service = CanvasService()
