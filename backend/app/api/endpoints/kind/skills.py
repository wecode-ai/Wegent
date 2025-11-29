# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skills API endpoints for managing Claude Code Skills
"""
import io

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.kind import Skill, SkillList
from app.services.adapters.skill_kinds import skill_kinds_service

router = APIRouter()


@router.post("/upload", response_model=Skill, status_code=201)
async def upload_skill(
    file: UploadFile = File(..., description="Skill ZIP package (max 10MB)"),
    name: str = Form(..., description="Skill name (unique)"),
    namespace: str = Form("default", description="Namespace"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Upload and create a new Skill.

    The ZIP package must contain a skill folder as root directory with the following structure:
    ```
    my-skill.zip
      └── my-skill/
          ├── SKILL.md
          └── resources/
    ```

    The SKILL.md file must contain YAML frontmatter:
    ```
    ---
    description: "Skill description"
    version: "1.0.0"
    author: "Author name"
    tags: ["tag1", "tag2"]
    ---
    ```

    Requirements:
    - ZIP file must contain exactly one skill folder as root directory
    - Skill folder name must match the ZIP file name (without .zip extension)
    - SKILL.md must be located inside the skill folder
    """
    # Validate file type
    if not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a ZIP package (.zip)")

    # Read file content
    file_content = await file.read()

    # Create skill using service
    skill = skill_kinds_service.create_skill(
        db=db,
        name=name.strip(),
        namespace=namespace,
        file_content=file_content,
        file_name=file.filename,
        user_id=current_user.id,
    )

    return skill


@router.get("", response_model=SkillList)
def list_skills(
    skip: int = Query(0, ge=0, description="Number of items to skip"),
    limit: int = Query(100, ge=1, le=100, description="Number of items to return"),
    namespace: str = Query("default", description="Namespace filter"),
    name: str = Query(None, description="Filter by skill name"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get current user's Skill list.

    If 'name' parameter is provided, returns only the skill with that name.
    """
    if name:
        # Query by name
        skill = skill_kinds_service.get_skill_by_name(
            db=db, name=name, namespace=namespace, user_id=current_user.id
        )
        return SkillList(items=[skill] if skill else [])

    # List all skills
    skills = skill_kinds_service.list_skills(
        db=db, user_id=current_user.id, skip=skip, limit=limit, namespace=namespace
    )
    return skills


@router.get("/{skill_id}", response_model=Skill)
def get_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get Skill details by ID"""
    skill = skill_kinds_service.get_skill_by_id(
        db=db, skill_id=skill_id, user_id=current_user.id
    )
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@router.get("/{skill_id}/download")
def download_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Download Skill ZIP package.

    Used by Executor to download Skills for deployment.
    """
    # Get skill metadata
    skill = skill_kinds_service.get_skill_by_id(
        db=db, skill_id=skill_id, user_id=current_user.id
    )
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")

    # Get binary data
    binary_data = skill_kinds_service.get_skill_binary(
        db=db, skill_id=skill_id, user_id=current_user.id
    )
    if not binary_data:
        raise HTTPException(status_code=404, detail="Skill binary not found")

    # Return as streaming response
    return StreamingResponse(
        io.BytesIO(binary_data),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename={skill.metadata.name}.zip"
        },
    )


@router.put("/{skill_id}", response_model=Skill)
async def update_skill(
    skill_id: int,
    file: UploadFile = File(..., description="New Skill ZIP package (max 10MB)"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update Skill by uploading a new ZIP package.

    The ZIP package must contain a skill folder as root directory with the following structure:
    ```
    my-skill.zip
      └── my-skill/
          ├── SKILL.md
          └── resources/
    ```

    The Skill name and namespace cannot be changed.
    """
    # Validate file type
    if not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a ZIP package (.zip)")

    # Read file content
    file_content = await file.read()

    # Update skill
    skill = skill_kinds_service.update_skill(
        db=db,
        skill_id=skill_id,
        user_id=current_user.id,
        file_content=file_content,
        file_name=file.filename,
    )

    return skill


@router.delete("/{skill_id}", status_code=204)
def delete_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete Skill.

    Returns 400 error if the Skill is referenced by any Ghost.
    """
    skill_kinds_service.delete_skill(db=db, skill_id=skill_id, user_id=current_user.id)
    return None
