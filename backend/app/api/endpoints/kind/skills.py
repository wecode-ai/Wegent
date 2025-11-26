# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skills API endpoints for Claude Code Skills management
"""
from fastapi import APIRouter, Depends, UploadFile, File, Form, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import io

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.kind import Skill, SkillList
from app.services.skill_service import SkillService

router = APIRouter()


@router.post("/upload", response_model=Skill, status_code=status.HTTP_201_CREATED)
async def upload_skill(
    file: UploadFile = File(...),
    name: str = Form(...),
    namespace: str = Form("default"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Upload and create a new Skill

    - **file**: ZIP package containing SKILL.md (max 10MB)
    - **name**: Unique Skill name
    - **namespace**: Namespace (default: "default")
    """
    # Validate file type
    if not file.filename.endswith('.zip'):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="File must be a ZIP archive")

    # Read file content
    file_content = await file.read()

    # Create skill
    skill = SkillService.create_skill(
        db=db,
        user_id=current_user.id,
        name=name.strip(),
        namespace=namespace,
        file_content=file_content
    )

    return skill


@router.get("", response_model=SkillList)
def list_skills(
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    List all Skills for the current user

    - **skip**: Number of items to skip (for pagination)
    - **limit**: Maximum number of items to return
    """
    return SkillService.list_skills(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit
    )


@router.get("/{skill_id}", response_model=Skill)
def get_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get Skill details by ID
    """
    return SkillService.get_skill(
        db=db,
        user_id=current_user.id,
        skill_id=skill_id
    )


@router.get("/{skill_id}/download")
def download_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Download Skill ZIP package

    Used by Executor to download Skills for deployment
    """
    binary_data = SkillService.get_skill_binary(
        db=db,
        user_id=current_user.id,
        skill_id=skill_id
    )

    # Get skill name for filename
    skill = SkillService.get_skill(
        db=db,
        user_id=current_user.id,
        skill_id=skill_id
    )

    return StreamingResponse(
        io.BytesIO(binary_data),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename={skill.metadata.name}.zip"
        }
    )


@router.put("/{skill_id}", response_model=Skill)
async def update_skill(
    skill_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update Skill with new ZIP package

    - **file**: New ZIP package containing SKILL.md (max 10MB)
    """
    # Validate file type
    if not file.filename.endswith('.zip'):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="File must be a ZIP archive")

    # Read file content
    file_content = await file.read()

    # Update skill
    skill = SkillService.update_skill(
        db=db,
        user_id=current_user.id,
        skill_id=skill_id,
        file_content=file_content
    )

    return skill


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete Skill

    Will check if Skill is referenced by any Ghost.
    If referenced, deletion will be rejected.
    """
    SkillService.delete_skill(
        db=db,
        user_id=current_user.id,
        skill_id=skill_id
    )

    return None
