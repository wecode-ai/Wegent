# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas API endpoints for artifact management.

Artifacts are stored in SubTask.result field with the following structure:
{
    "type": "artifact",
    "artifact": {
        "id": "unique-id",
        "artifact_type": "code" | "text",
        "title": "Artifact Title",
        "content": "...",
        "language": "python",  # for code type
        "version": 1,
        "versions": [
            {"version": 1, "content": "...", "created_at": "..."}
        ]
    }
}
"""

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.services.task_member_service import task_member_service

router = APIRouter()


# ============================================
# Pydantic Models for Canvas API
# ============================================


class ArtifactVersion(BaseModel):
    """A single version of an artifact"""

    version: int
    content: str
    created_at: str


class Artifact(BaseModel):
    """Main artifact model"""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    artifact_type: Literal["code", "text"]
    title: str
    content: str
    language: Optional[str] = None
    version: int = 1
    versions: list[ArtifactVersion] = []


class ArtifactResult(BaseModel):
    """Wrapper for artifact in SubTask.result"""

    type: Literal["artifact"] = "artifact"
    artifact: Artifact


class CreateArtifactRequest(BaseModel):
    """Request to create a new artifact"""

    artifact_type: Literal["code", "text"]
    title: str
    content: str
    language: Optional[str] = None


class UpdateArtifactRequest(BaseModel):
    """Request to update an artifact"""

    content: str
    title: Optional[str] = None
    create_version: bool = True  # Whether to create a new version


class ArtifactResponse(BaseModel):
    """Response containing artifact data"""

    artifact: Artifact
    subtask_id: int


class CanvasSettingsRequest(BaseModel):
    """Request to update Canvas settings for a task"""

    canvas_enabled: bool = True
    auto_open: bool = True  # Auto-open canvas when artifact is generated


class CanvasSettingsResponse(BaseModel):
    """Response with Canvas settings"""

    canvas_enabled: bool
    auto_open: bool


# ============================================
# Helper Functions
# ============================================


def check_task_access(db: Session, task_id: int, user_id: int) -> TaskResource:
    """Check if user has access to the task"""
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


def get_subtask_with_artifact(db: Session, subtask_id: int, user_id: int) -> Subtask:
    """Get subtask and verify it has an artifact"""
    subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Check task access
    check_task_access(db, subtask.task_id, user_id)

    return subtask


def extract_artifact_from_result(result: Optional[dict[str, Any]]) -> Optional[Artifact]:
    """Extract artifact from SubTask.result"""
    if not result:
        return None
    if result.get("type") != "artifact":
        return None
    artifact_data = result.get("artifact")
    if not artifact_data:
        return None
    return Artifact(**artifact_data)


# ============================================
# Canvas API Endpoints
# ============================================


@router.get("/tasks/{task_id}/artifacts", response_model=list[ArtifactResponse])
def list_task_artifacts(
    task_id: int,
    limit: int = Query(10, ge=1, le=50),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List all artifacts in a task.
    Returns subtasks that have artifact type results.
    """
    check_task_access(db, task_id, current_user.id)

    # Get subtasks with artifact results
    subtasks = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.result.isnot(None),
        )
        .order_by(Subtask.id.desc())
        .limit(limit)
        .all()
    )

    artifacts = []
    for subtask in subtasks:
        artifact = extract_artifact_from_result(subtask.result)
        if artifact:
            artifacts.append(ArtifactResponse(artifact=artifact, subtask_id=subtask.id))

    return artifacts


@router.get("/subtasks/{subtask_id}/artifact", response_model=ArtifactResponse)
def get_artifact(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get artifact from a specific subtask.
    """
    subtask = get_subtask_with_artifact(db, subtask_id, current_user.id)

    artifact = extract_artifact_from_result(subtask.result)
    if not artifact:
        raise HTTPException(status_code=404, detail="No artifact found in this subtask")

    return ArtifactResponse(artifact=artifact, subtask_id=subtask.id)


@router.post("/subtasks/{subtask_id}/artifact", response_model=ArtifactResponse)
def create_artifact(
    subtask_id: int,
    request: CreateArtifactRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new artifact for a subtask.
    """
    subtask = get_subtask_with_artifact(db, subtask_id, current_user.id)

    # Check if artifact already exists
    if subtask.result and subtask.result.get("type") == "artifact":
        raise HTTPException(
            status_code=400, detail="Artifact already exists. Use PUT to update."
        )

    # Create artifact
    now = datetime.utcnow().isoformat()
    artifact = Artifact(
        artifact_type=request.artifact_type,
        title=request.title,
        content=request.content,
        language=request.language,
        version=1,
        versions=[ArtifactVersion(version=1, content=request.content, created_at=now)],
    )

    # Store in subtask result
    artifact_result = ArtifactResult(artifact=artifact)
    subtask.result = artifact_result.model_dump()
    db.commit()
    db.refresh(subtask)

    return ArtifactResponse(artifact=artifact, subtask_id=subtask.id)


@router.put("/subtasks/{subtask_id}/artifact", response_model=ArtifactResponse)
def update_artifact(
    subtask_id: int,
    request: UpdateArtifactRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update an existing artifact.
    Creates a new version if create_version is True.
    """
    subtask = get_subtask_with_artifact(db, subtask_id, current_user.id)

    # Get existing artifact
    artifact = extract_artifact_from_result(subtask.result)
    if not artifact:
        raise HTTPException(status_code=404, detail="No artifact found to update")

    now = datetime.utcnow().isoformat()

    if request.create_version:
        # Create new version
        new_version_num = artifact.version + 1
        new_version = ArtifactVersion(
            version=new_version_num, content=request.content, created_at=now
        )
        artifact.versions.append(new_version)
        artifact.version = new_version_num

    # Update content
    artifact.content = request.content
    if request.title:
        artifact.title = request.title

    # Store updated artifact
    artifact_result = ArtifactResult(artifact=artifact)
    subtask.result = artifact_result.model_dump()
    db.commit()
    db.refresh(subtask)

    return ArtifactResponse(artifact=artifact, subtask_id=subtask.id)


@router.post("/subtasks/{subtask_id}/artifact/revert/{version}", response_model=ArtifactResponse)
def revert_artifact_version(
    subtask_id: int,
    version: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Revert artifact to a previous version.
    Creates a new version with the content from the specified version.
    """
    subtask = get_subtask_with_artifact(db, subtask_id, current_user.id)

    artifact = extract_artifact_from_result(subtask.result)
    if not artifact:
        raise HTTPException(status_code=404, detail="No artifact found")

    # Find target version
    target_version = None
    for v in artifact.versions:
        if v.version == version:
            target_version = v
            break

    if not target_version:
        raise HTTPException(status_code=404, detail=f"Version {version} not found")

    # Create new version with reverted content
    now = datetime.utcnow().isoformat()
    new_version_num = artifact.version + 1
    new_version = ArtifactVersion(
        version=new_version_num, content=target_version.content, created_at=now
    )
    artifact.versions.append(new_version)
    artifact.version = new_version_num
    artifact.content = target_version.content

    # Store updated artifact
    artifact_result = ArtifactResult(artifact=artifact)
    subtask.result = artifact_result.model_dump()
    db.commit()
    db.refresh(subtask)

    return ArtifactResponse(artifact=artifact, subtask_id=subtask.id)


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
    from sqlalchemy.orm.attributes import flag_modified

    task = check_task_access(db, task_id, current_user.id)

    # Update canvas settings in task.json
    if task.json is None:
        task.json = {}

    task.json["canvas"] = {
        "enabled": request.canvas_enabled,
        "auto_open": request.auto_open,
    }

    # Mark json field as modified for SQLAlchemy to detect the change
    flag_modified(task, "json")
    db.commit()
    db.refresh(task)

    return CanvasSettingsResponse(
        canvas_enabled=request.canvas_enabled,
        auto_open=request.auto_open,
    )
