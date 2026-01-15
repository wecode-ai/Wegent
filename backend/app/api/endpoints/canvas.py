# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas API endpoints for artifact management.

Artifacts are stored in TaskResource.json["canvas"] with the following structure:
{
    "canvas": {
        "enabled": true,
        "artifact": {
            "id": "unique-id",
            "artifact_type": "code" | "text",
            "title": "Artifact Title",
            "content": "current content...",
            "language": "python",  # for code type
            "version": 3
        },
        "history": [
            {"version": 1, "diff": null, "created_at": "..."},
            {"version": 2, "diff": "@@ -1,3 +1,3 @@...", "created_at": "..."},
            {"version": 3, "diff": "@@ -1,3 +1,4 @@...", "created_at": "..."}
        ]
    }
}

Storage efficiency: Using diff-based history reduces storage by ~75% compared
to storing full content for each version.
"""

import logging
import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.dependencies import get_db
from app.core import security
from app.models.task import TaskResource
from app.models.user import User
from app.services.task_member_service import task_member_service
from app.utils import create_diff, get_version_content

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================
# Pydantic Models for Canvas API
# ============================================


class ArtifactVersion(BaseModel):
    """A single version entry in history (diff-based)."""

    version: int
    diff: Optional[str] = None  # null for initial version
    created_at: str


class Artifact(BaseModel):
    """Main artifact model (current state)."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    artifact_type: Literal["code", "text"]
    title: str
    content: str  # Current content only
    language: Optional[str] = None
    version: int = 1


class ArtifactWithHistory(Artifact):
    """Artifact with version history for API responses."""

    versions: list[ArtifactVersion] = []


class CreateArtifactRequest(BaseModel):
    """Request to create a new artifact."""

    artifact_type: Literal["code", "text"]
    title: str
    content: str
    language: Optional[str] = None


class UpdateArtifactRequest(BaseModel):
    """Request to update an artifact."""

    content: str
    title: Optional[str] = None
    create_version: bool = True  # Whether to create a new version


class ArtifactResponse(BaseModel):
    """Response containing artifact data."""

    artifact: ArtifactWithHistory
    task_id: int


class CanvasSettingsRequest(BaseModel):
    """Request to update Canvas settings for a task."""

    canvas_enabled: bool = True
    auto_open: bool = True  # Auto-open canvas when artifact is generated


class CanvasSettingsResponse(BaseModel):
    """Response with Canvas settings."""

    canvas_enabled: bool
    auto_open: bool


class VersionContentResponse(BaseModel):
    """Response containing content for a specific version."""

    version: int
    content: str


# ============================================
# Helper Functions
# ============================================


def check_task_access(db: Session, task_id: int, user_id: int) -> TaskResource:
    """Check if user has access to the task."""
    task = db.query(TaskResource).filter(
        TaskResource.id == task_id,
        TaskResource.kind == "Task",
        TaskResource.is_active.is_(True),
    ).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check if user is owner or member
    if task.user_id != user_id:
        is_member = task_member_service.is_member(db, task_id, user_id)
        if not is_member:
            raise HTTPException(status_code=403, detail="Access denied")

    return task


def get_canvas_data(task: TaskResource) -> dict[str, Any]:
    """Get canvas data from task.json, initializing if needed."""
    if not task.json:
        task.json = {}
    if "canvas" not in task.json:
        task.json["canvas"] = {"enabled": True, "artifact": None, "history": []}
    return task.json["canvas"]


def save_canvas_data(db: Session, task: TaskResource, canvas_data: dict[str, Any]) -> None:
    """Save canvas data to task.json."""
    if task.json is None:
        task.json = {}
    task.json["canvas"] = canvas_data
    flag_modified(task, "json")
    db.commit()
    db.refresh(task)


def artifact_to_response(artifact_data: dict[str, Any], history: list[dict], task_id: int) -> ArtifactResponse:
    """Convert stored artifact data to API response."""
    if not artifact_data:
        raise HTTPException(status_code=404, detail="No artifact found")

    # Build versions list from history
    versions = [
        ArtifactVersion(
            version=h["version"],
            diff=h.get("diff"),
            created_at=h.get("created_at", ""),
        )
        for h in history
    ]

    artifact = ArtifactWithHistory(
        id=artifact_data.get("id", ""),
        artifact_type=artifact_data.get("artifact_type", "text"),
        title=artifact_data.get("title", "Untitled"),
        content=artifact_data.get("content", ""),
        language=artifact_data.get("language"),
        version=artifact_data.get("version", 1),
        versions=versions,
    )

    return ArtifactResponse(artifact=artifact, task_id=task_id)


# ============================================
# Canvas API Endpoints
# ============================================


@router.get("/tasks/{task_id}/artifact", response_model=ArtifactResponse)
def get_task_artifact(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get the current artifact for a task.
    Artifacts are stored in TaskResource.json["canvas"].
    """
    task = check_task_access(db, task_id, current_user.id)
    canvas_data = get_canvas_data(task)

    artifact_data = canvas_data.get("artifact")
    if not artifact_data:
        raise HTTPException(status_code=404, detail="No artifact found for this task")

    history = canvas_data.get("history", [])
    return artifact_to_response(artifact_data, history, task_id)


@router.post("/tasks/{task_id}/artifact", response_model=ArtifactResponse)
def create_task_artifact(
    task_id: int,
    request: CreateArtifactRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new artifact for a task.
    """
    task = check_task_access(db, task_id, current_user.id)
    canvas_data = get_canvas_data(task)

    # Check if artifact already exists
    if canvas_data.get("artifact"):
        raise HTTPException(
            status_code=400, detail="Artifact already exists. Use PUT to update."
        )

    # Create artifact
    now = datetime.utcnow().isoformat()
    artifact_data = {
        "id": str(uuid.uuid4()),
        "artifact_type": request.artifact_type,
        "title": request.title,
        "content": request.content,
        "version": 1,
    }

    if request.language and request.artifact_type == "code":
        artifact_data["language"] = request.language

    # Initialize history with first version (no diff for initial)
    history = [{"version": 1, "diff": None, "created_at": now}]

    # Save to task.json
    canvas_data["artifact"] = artifact_data
    canvas_data["history"] = history
    canvas_data["enabled"] = True
    save_canvas_data(db, task, canvas_data)

    return artifact_to_response(artifact_data, history, task_id)


@router.put("/tasks/{task_id}/artifact", response_model=ArtifactResponse)
def update_task_artifact(
    task_id: int,
    request: UpdateArtifactRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update an existing artifact.
    Creates a new version with diff if create_version is True.
    """
    task = check_task_access(db, task_id, current_user.id)
    canvas_data = get_canvas_data(task)

    artifact_data = canvas_data.get("artifact")
    if not artifact_data:
        raise HTTPException(status_code=404, detail="No artifact found to update")

    history = canvas_data.get("history", [])
    now = datetime.utcnow().isoformat()

    if request.create_version:
        # Create diff from old to new content
        old_content = artifact_data.get("content", "")
        diff = create_diff(old_content, request.content)

        # Create new version entry
        new_version_num = artifact_data.get("version", 1) + 1
        history.append({
            "version": new_version_num,
            "diff": diff,
            "created_at": now,
        })
        artifact_data["version"] = new_version_num

        logger.debug(
            "[Canvas] Created version %d for task %d, diff_len=%d",
            new_version_num,
            task_id,
            len(diff) if diff else 0,
        )

    # Update content
    artifact_data["content"] = request.content
    if request.title:
        artifact_data["title"] = request.title

    # Save to task.json
    canvas_data["artifact"] = artifact_data
    canvas_data["history"] = history
    save_canvas_data(db, task, canvas_data)

    return artifact_to_response(artifact_data, history, task_id)


@router.post("/tasks/{task_id}/artifact/revert/{version}", response_model=ArtifactResponse)
def revert_artifact_version(
    task_id: int,
    version: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Revert artifact to a previous version.
    Creates a new version with the content from the specified version.
    """
    task = check_task_access(db, task_id, current_user.id)
    canvas_data = get_canvas_data(task)

    artifact_data = canvas_data.get("artifact")
    if not artifact_data:
        raise HTTPException(status_code=404, detail="No artifact found")

    history = canvas_data.get("history", [])
    current_content = artifact_data.get("content", "")
    current_version = artifact_data.get("version", 1)

    if version > current_version:
        raise HTTPException(status_code=404, detail=f"Version {version} not found")

    if version == current_version:
        # Already at this version
        return artifact_to_response(artifact_data, history, task_id)

    # Reconstruct content for target version using diffs
    target_content = get_version_content(current_content, history, version)
    if target_content is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to reconstruct content for version {version}"
        )

    # Create new version with reverted content
    now = datetime.utcnow().isoformat()
    new_version_num = current_version + 1
    diff = create_diff(current_content, target_content)

    history.append({
        "version": new_version_num,
        "diff": diff,
        "created_at": now,
    })

    artifact_data["content"] = target_content
    artifact_data["version"] = new_version_num

    logger.debug(
        "[Canvas] Reverted to version %d, created version %d for task %d",
        version,
        new_version_num,
        task_id,
    )

    # Save to task.json
    canvas_data["artifact"] = artifact_data
    canvas_data["history"] = history
    save_canvas_data(db, task, canvas_data)

    return artifact_to_response(artifact_data, history, task_id)


@router.get("/tasks/{task_id}/artifact/version/{version}", response_model=VersionContentResponse)
def get_artifact_version_content(
    task_id: int,
    version: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get the content of a specific version.
    Reconstructs content by applying diffs in reverse.
    """
    task = check_task_access(db, task_id, current_user.id)
    canvas_data = get_canvas_data(task)

    artifact_data = canvas_data.get("artifact")
    if not artifact_data:
        raise HTTPException(status_code=404, detail="No artifact found")

    history = canvas_data.get("history", [])
    current_content = artifact_data.get("content", "")
    current_version = artifact_data.get("version", 1)

    if version > current_version:
        raise HTTPException(status_code=404, detail=f"Version {version} not found")

    if version == current_version:
        return VersionContentResponse(version=version, content=current_content)

    # Reconstruct content for target version
    target_content = get_version_content(current_content, history, version)
    if target_content is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to reconstruct content for version {version}"
        )

    return VersionContentResponse(version=version, content=target_content)


@router.get("/tasks/{task_id}/canvas-settings", response_model=CanvasSettingsResponse)
def get_canvas_settings(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get Canvas settings for a task.
    Settings are stored in TaskResource.json field under 'canvas' key.
    """
    task = check_task_access(db, task_id, current_user.id)

    if not task.json:
        return CanvasSettingsResponse(canvas_enabled=False, auto_open=True)

    canvas_settings = task.json.get("canvas", {})
    return CanvasSettingsResponse(
        canvas_enabled=canvas_settings.get("enabled", False),
        auto_open=canvas_settings.get("auto_open", True),
    )


@router.put("/tasks/{task_id}/canvas-settings", response_model=CanvasSettingsResponse)
def update_canvas_settings(
    task_id: int,
    request: CanvasSettingsRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update Canvas settings for a task.
    Settings are stored in TaskResource.json field under 'canvas' key.
    """
    task = check_task_access(db, task_id, current_user.id)
    canvas_data = get_canvas_data(task)

    canvas_data["enabled"] = request.canvas_enabled
    canvas_data["auto_open"] = request.auto_open

    save_canvas_data(db, task, canvas_data)

    return CanvasSettingsResponse(
        canvas_enabled=request.canvas_enabled,
        auto_open=request.auto_open,
    )
