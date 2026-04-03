# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skills API endpoints for managing Claude Code Skills
"""

import io
import logging
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import (
    GitBatchUpdateRequest,
    GitBatchUpdateResponse,
    GitImportRequest,
    GitImportResponse,
    GitScanResponse,
    Skill,
    SkillList,
)
from app.services.adapters.public_skill import public_skill_service
from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.git_skill import git_skill_service

router = APIRouter()


def _resolve_manageable_skill(
    db: Session, skill_id: int, current_user: User, action: str
) -> Kind:
    """
    Resolve a skill for management operations with unified permission checks.

    Permission rules:
    - Skill owner can manage
    - System admin can manage any skill
    - Group Owner/Maintainer can manage any skill in their group namespace
    """
    from app.services.group_permission import get_effective_role_in_group

    skill_kind = (
        db.query(Kind)
        .filter(
            Kind.id == skill_id,
            Kind.kind == "Skill",
            Kind.is_active == True,
        )
        .first()
    )

    if not skill_kind:
        raise HTTPException(status_code=404, detail="Skill not found")

    if skill_kind.user_id == current_user.id:
        return skill_kind

    if current_user.role == "admin":
        return skill_kind

    if skill_kind.namespace != "default":
        user_role = get_effective_role_in_group(
            db, current_user.id, skill_kind.namespace
        )
        if user_role and user_role.value in {"Owner", "Maintainer"}:
            return skill_kind

    raise HTTPException(
        status_code=403,
        detail=f"You don't have permission to {action} this skill",
    )


# Request/Response schemas for new endpoints
class PublicSkillCreate(BaseModel):
    """Schema for creating a public skill"""

    name: str
    description: str
    prompt: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, v):
        """Convert float/int version to string to handle YAML parsing."""
        if v is None:
            return v
        return str(v)


class PublicSkillUpdate(BaseModel):
    """Schema for updating a public skill"""

    description: Optional[str] = None
    prompt: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, v):
        """Convert float/int version to string to handle YAML parsing."""
        if v is None:
            return v
        return str(v)


class InvokeSkillRequest(BaseModel):
    """Schema for invoking a skill"""

    skill_name: str


class InvokeSkillResponse(BaseModel):
    """Schema for invoke skill response"""

    prompt: str


class SkillSourceResponse(BaseModel):
    """Schema for skill source information"""

    type: str = "upload"  # 'upload' or 'git'
    repo_url: Optional[str] = None
    skill_path: Optional[str] = None
    imported_at: Optional[str] = None


class UnifiedSkillResponse(BaseModel):
    """Schema for unified skill list item"""

    id: int
    name: str
    namespace: str
    description: str
    displayName: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None
    bindShells: Optional[List[str]] = None  # Shell types this skill is compatible with
    is_active: bool
    is_public: bool
    user_id: int  # ID of the user who uploaded this skill
    source: Optional[SkillSourceResponse] = (
        None  # Source information for git-imported skills
    )
    created_at: Any
    updated_at: Any

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, v):
        """Convert float/int version to string to handle YAML parsing."""
        if v is None:
            return v
        return str(v)


class ReferencedGhostResponse(BaseModel):
    """Schema for a Ghost that references a Skill."""

    id: int
    name: str
    namespace: str


class SkillReferencesResponse(BaseModel):
    """Schema for queried Skill references."""

    skill_id: int
    skill_name: str
    referenced_ghosts: List[ReferencedGhostResponse]


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
    namespace: str = Query(
        "default", description="Namespace filter (team namespace for group skills)"
    ),
    name: str = Query(None, description="Filter by skill name"),
    exact_match: bool = Query(
        False,
        description="If true, only search in the specified namespace (for upload check). "
        "If false, search with fallback: personal -> group -> task_owner -> public (for usage).",
    ),
    task_id: int = Query(
        None,
        description="Task ID for task-based authorization. "
        "If provided, also searches skills owned by the task owner.",
    ),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
    db: Session = Depends(get_db),
):
    """
    Get current user's Skill list.

    If 'name' parameter is provided, returns only the skill with that name.

    Search behavior depends on 'exact_match':
    - exact_match=true: Only search in the specified namespace (used for upload duplicate check)
    - exact_match=false (default): Search with fallback order (used for skill usage):
      1. User's skill in default namespace (personal)
      2. Group-level skill in specified namespace (any user in that group, if namespace != 'default')
      3. Task owner's skill (if task_id provided and user is task member)
      4. Public skill (user_id=0)

    Task-based authorization:
    When task_id is provided, the API will also search for skills owned by the
    task owner. This enables shared team scenarios where user B executes a task
    using user A's team, and needs to find user A's private skills.
    Authorization is verified by checking if current_user is a member of the task.
    """
    if name:
        logger.info(
            f"[list_skills] Searching for skill: name={name}, namespace={namespace}, exact_match={exact_match}, user_id={current_user.id}"
        )
        if exact_match:
            # Exact match mode: only search in the specified namespace
            skill = skill_kinds_service.get_skill_by_name(
                db=db, name=name, namespace=namespace, user_id=current_user.id
            )
            logger.info(
                f"[list_skills] Exact match result: skill={skill.metadata.name if skill else None}"
            )
            return SkillList(items=[skill] if skill else [])

        # Fallback mode: search with priority order
        # 1. User's personal skill (default namespace)
        skill = skill_kinds_service.get_skill_by_name(
            db=db, name=name, namespace="default", user_id=current_user.id
        )

        # 2. Group-level skill (if namespace is not default)
        # Search ALL skills in the group namespace, not just current user's
        if not skill and namespace != "default":
            skill = skill_kinds_service.get_skill_by_name_in_namespace(
                db=db, name=name, namespace=namespace
            )

        # 3. Team owner's skill (if task_id provided)
        # This enables shared team scenarios where executor queries skills
        # owned by the original team owner
        if not skill and task_id:
            from app.models.task import TaskResource
            from app.schemas.kind import Task
            from app.services.task_member_service import task_member_service

            # Verify current user is a member of the task (owner or group member)
            if task_member_service.is_member(db, task_id, current_user.id):
                # Get task to find the team owner
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == task_id,
                        TaskResource.kind == "Task",
                        TaskResource.is_active.in_(TaskResource.is_active_query()),
                    )
                    .first()
                )
                if task:
                    # Get team owner user_id from task's teamRef
                    task_crd = Task.model_validate(task.json)
                    team_owner_user_id = task_crd.spec.teamRef.user_id

                    # If teamRef.user_id is set and different from current user,
                    # search skill owned by team owner
                    if team_owner_user_id and team_owner_user_id != current_user.id:
                        skill = skill_kinds_service.get_skill_by_name(
                            db=db,
                            name=name,
                            namespace="default",
                            user_id=team_owner_user_id,
                        )

        # 4. Public skill (user_id=0)
        if not skill:
            skill = skill_kinds_service.get_skill_by_name(
                db=db, name=name, namespace="default", user_id=0
            )

        return SkillList(items=[skill] if skill else [])

    # List all skills
    skills = skill_kinds_service.list_skills(
        db=db, user_id=current_user.id, skip=skip, limit=limit, namespace=namespace
    )
    return skills


# ============================================================================
# Git Repository Import Endpoints (Personal Skills)
# NOTE: Static routes must be defined BEFORE dynamic routes like /{skill_id}
# ============================================================================


@router.get("/git/scan", response_model=GitScanResponse)
def scan_git_repository(
    repo_url: str = Query(..., description="Git repository URL"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Scan a Git repository for skills.

    Supports GitHub, GitLab, Gitee, and Gitea platforms.
    Supports both public and private repositories via:
    - URL embedded credentials (e.g., https://token@github.com/owner/repo)
    - Platform integration tokens configured in Settings

    Returns a list of skills found in the repository (directories containing SKILL.md)
    along with repository authentication information.
    """
    skills = git_skill_service.scan_repository(repo_url, user_id=current_user.id, db=db)

    return GitScanResponse(
        repo_url=repo_url,
        skills=[
            {
                "path": s.path,
                "name": s.name,
                "description": s.description,
                "version": s.version,
                "author": s.author,
                "display_name": s.display_name,
                "tags": s.tags,
            }
            for s in skills
        ],
        total_count=len(skills),
    )


@router.post("/git/import", response_model=GitImportResponse)
def import_from_git_repository(
    request: GitImportRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Import selected skills from a Git repository.

    Supports GitHub, GitLab, Gitee, and Gitea platforms.
    Supports both public and private repositories via:
    - URL embedded credentials (e.g., https://token@github.com/owner/repo)
    - Platform integration tokens configured in Settings

    Skills are imported to the user's personal namespace by default.
    If a skill with the same name already exists:
    - If the name is in overwrite_names, the existing skill will be updated
    - Otherwise, the skill will be skipped
    """
    result = git_skill_service.import_skills(
        repo_url=request.repo_url,
        skill_paths=request.skill_paths,
        namespace=request.namespace,
        user_id=current_user.id,
        overwrite_names=request.overwrite_names,
        db=db,
    )

    return GitImportResponse(
        success=[
            {
                "name": s["name"],
                "path": s["path"],
                "id": s["id"],
                "action": s["action"],
            }
            for s in result.success
        ],
        skipped=[
            {
                "name": s["name"],
                "path": s["path"],
                "reason": s["reason"],
            }
            for s in result.skipped
        ],
        failed=[
            {
                "name": s["name"],
                "path": s["path"],
                "error": s["error"],
            }
            for s in result.failed
        ],
        total_success=len(result.success),
        total_skipped=len(result.skipped),
        total_failed=len(result.failed),
    )


@router.post("/git/batch-update", response_model=GitBatchUpdateResponse)
def batch_update_skills_from_git(
    request: GitBatchUpdateRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch update multiple skills from their original Git repository sources.

    This endpoint optimizes the update process by:
    1. Grouping skills by their source repository
    2. Downloading each repository only once
    3. Updating all skills from the same repository in a single pass

    This is more efficient than calling update-from-git for each skill individually,
    especially when multiple skills come from the same repository.

    Supports both public and private repositories via:
    - URL embedded credentials in the original repo_url
    - Platform integration tokens configured in Settings

    Only skills that were imported from Git (source.type === 'git') can be updated.
    Skills that don't exist, are not from Git, or have incomplete source info will be skipped.

    Returns:
        GitBatchUpdateResponse with success, skipped, and failed lists
    """
    result = git_skill_service.batch_update_skills_from_git(
        skill_ids=request.skill_ids,
        user_id=current_user.id,
        db=db,
    )

    return GitBatchUpdateResponse(
        success=[
            {
                "id": s["id"],
                "name": s["name"],
                "version": s.get("version"),
                "source": s.get("source"),
            }
            for s in result.success
        ],
        skipped=[
            {
                "id": s["id"],
                "name": s.get("name"),
                "reason": s["reason"],
            }
            for s in result.skipped
        ],
        failed=[
            {
                "id": s["id"],
                "name": s.get("name"),
                "error": s["error"],
            }
            for s in result.failed
        ],
        total_success=len(result.success),
        total_skipped=len(result.skipped),
        total_failed=len(result.failed),
    )


# ============================================================================
# Public Skill Endpoints (System-level skills, admin only)
# NOTE: Static routes must be defined BEFORE dynamic routes like /{skill_id}
# ============================================================================


@router.get("/public/list", response_model=List[Dict[str, Any]])
def list_public_skills(
    skip: int = Query(0, ge=0, description="Number of items to skip"),
    limit: int = Query(100, ge=1, le=100, description="Number of items to return"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """List all public (system-level) skills."""
    return public_skill_service.get_skills(db, skip=skip, limit=limit)


@router.post("/public", response_model=Dict[str, Any], status_code=201)
def create_public_skill(
    skill_in: PublicSkillCreate,
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """Create a public skill (admin only)."""
    return public_skill_service.create_skill(
        db,
        name=skill_in.name,
        description=skill_in.description,
        prompt=skill_in.prompt,
        version=skill_in.version,
        author=skill_in.author,
        tags=skill_in.tags,
    )


@router.put("/public/{skill_id}", response_model=Dict[str, Any])
def update_public_skill(
    skill_id: int,
    skill_in: PublicSkillUpdate,
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """Update a public skill (admin only)."""
    return public_skill_service.update_skill(
        db,
        skill_id=skill_id,
        description=skill_in.description,
        prompt=skill_in.prompt,
        version=skill_in.version,
        author=skill_in.author,
        tags=skill_in.tags,
    )


@router.delete("/public/{skill_id}", status_code=204)
def delete_public_skill(
    skill_id: int,
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """Delete a public skill (admin only)."""
    public_skill_service.delete_skill(db, skill_id=skill_id)
    return None


@router.post("/public/upload", response_model=Dict[str, Any], status_code=201)
async def upload_public_skill(
    file: UploadFile = File(..., description="Skill ZIP package (max 10MB)"),
    name: str = Form(..., description="Skill name (unique)"),
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """
    Upload and create a new public Skill ZIP package (admin only).

    Uses user_id=0 to indicate a public/system-level skill.
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
    """
    # Validate file type
    if not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a ZIP package (.zip)")

    # Read file content
    file_content = await file.read()

    # Create public skill using service with user_id=0
    skill = skill_kinds_service.create_skill(
        db=db,
        name=name.strip(),
        namespace="default",
        file_content=file_content,
        file_name=file.filename,
        user_id=0,  # Public skill
    )

    # Convert to dict format for consistency with other public skill endpoints
    return {
        "id": int(skill.metadata.labels.get("id", 0)),
        "name": skill.metadata.name,
        "namespace": skill.metadata.namespace,
        "description": skill.spec.description,
        "prompt": skill.spec.prompt,
        "version": skill.spec.version,
        "author": skill.spec.author,
        "tags": skill.spec.tags,
        "bindShells": skill.spec.bindShells,
        "is_active": True,
        "is_public": True,
        "created_at": None,
        "updated_at": None,
    }


@router.put("/public/{skill_id}/upload", response_model=Dict[str, Any])
async def update_public_skill_with_upload(
    skill_id: int,
    file: UploadFile = File(..., description="New Skill ZIP package (max 10MB)"),
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """
    Update a public Skill by uploading a new ZIP package (admin only).

    Validates that the skill_id corresponds to a public skill (user_id=0).
    The ZIP package must contain a skill folder as root directory with the following structure:
    ```
    my-skill.zip
      └── my-skill/
          ├── SKILL.md
          └── resources/
    ```

    The Skill name and namespace cannot be changed.
    """
    # Verify this is a public skill (user_id=0)
    existing_skill = (
        db.query(Kind)
        .filter(
            Kind.id == skill_id,
            Kind.user_id == 0,
            Kind.kind == "Skill",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not existing_skill:
        raise HTTPException(status_code=404, detail="Public skill not found")

    # Validate file type
    if not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a ZIP package (.zip)")

    # Read file content
    file_content = await file.read()

    # Update public skill using service with user_id=0
    skill = skill_kinds_service.update_skill(
        db=db,
        skill_id=skill_id,
        user_id=0,  # Public skill
        file_content=file_content,
        file_name=file.filename,
    )

    # Convert to dict format for consistency with other public skill endpoints
    return {
        "id": int(skill.metadata.labels.get("id", 0)),
        "name": skill.metadata.name,
        "namespace": skill.metadata.namespace,
        "description": skill.spec.description,
        "prompt": skill.spec.prompt,
        "version": skill.spec.version,
        "author": skill.spec.author,
        "tags": skill.spec.tags,
        "bindShells": skill.spec.bindShells,
        "is_active": True,
        "is_public": True,
        "created_at": None,
        "updated_at": None,
    }


@router.get("/public/{skill_id}/download")
def download_public_skill(
    skill_id: int,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
    db: Session = Depends(get_db),
):
    """
    Download a public Skill ckage.

    Validates that the skill_id corresponds to a public skill (user_id=0).
    Any authenticated user can download public skills.
    """
    # Verify this is a public skill (user_id=0)
    skill = (
        db.query(Kind)
        .filter(
            Kind.id == skill_id,
            Kind.user_id == 0,
            Kind.kind == "Skill",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not skill:
        raise HTTPException(status_code=404, detail="Public skill not found")

    # Get binary data using service with user_id=0
    binary_data = skill_kinds_service.get_skill_binary(
        db=db, skill_id=skill_id, user_id=0
    )
    if not binary_data:
        raise HTTPException(status_code=404, detail="Public skill binary not found")

    # Return as streaming response
    return StreamingResponse(
        io.BytesIO(binary_data),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={skill.name}.zip"},
    )


@router.get("/public/{skill_id}/content", response_model=Dict[str, str])
def get_public_skill_content(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get the SKILL.md content from a public Skill ckage.

    Validates that the skill_id corresponds to a public skill (user_id=0).
    Any authenticated user can view public skill content.

    Returns:
        {"content": "SKILL.md raw content"}
    """
    # Verify this is a public skill (user_id=0)
    skill = (
        db.query(Kind)
        .filter(
            Kind.id == skill_id,
            Kind.user_id == 0,
            Kind.kind == "Skill",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not skill:
        raise HTTPException(status_code=404, detail="Public skill not found")

    # Get binary data using service with user_id=0
    binary_data = skill_kinds_service.get_skill_binary(
        db=db, skill_id=skill_id, user_id=0
    )
    if not binary_data:
        raise HTTPException(status_code=404, detail="Public skill binary not found")

    # Extract SKILL.md content from ZIP
    try:
        with zipfile.ZipFile(io.BytesIO(binary_data), "r") as zip_file:
            # Find SKILL.md file
            skill_md_content = None
            for file_info in zip_file.filelist:
                # Skip directory entries
                if file_info.filename.endswith("/"):
                    continue
                # Check if this is SKILL.md (in format: skill-folder/SKILL.md)
                if file_info.filename.endswith("SKILL.md"):
                    path_parts = file_info.filename.split("/")
                    # SKILL.md must be in a subdirectory (skill-folder/SKILL.md)
                    if len(path_parts) == 2:
                        with zip_file.open(file_info) as f:
                            skill_md_content = f.read().decode("utf-8", errors="ignore")
                        break

            if not skill_md_content:
                raise HTTPException(
                    status_code=404, detail="SKILL.md not found in skill package"
                )

            return {"content": skill_md_content}

    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Corrupted ZIP file")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to read SKILL.md: {str(e)}"
        )


# ============================================================================
# Public Skill Git Import Endpoints (Admin only)
# ============================================================================


@router.get("/public/git/scan", response_model=GitScanResponse)
def scan_git_repository_for_public(
    repo_url: str = Query(..., description="Git repository URL"),
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """
    Scan a Git repository for skills (admin only, for public skill import).

    Supports GitHub, GitLab, Gitee, and Gitea platforms.
    Supports both public and private repositories via:
    - URL embedded credentials (e.g., https://token@github.com/owner/repo)
    - Platform integration tokens configured in Settings

    Returns a list of skills found in the repository (directories containing SKILL.md)
    along with repository authentication information.
    """
    skills = git_skill_service.scan_repository(repo_url, user_id=current_user.id, db=db)

    return GitScanResponse(
        repo_url=repo_url,
        skills=[
            {
                "path": s.path,
                "name": s.name,
                "description": s.description,
                "version": s.version,
                "author": s.author,
                "display_name": s.display_name,
                "tags": s.tags,
            }
            for s in skills
        ],
        total_count=len(skills),
    )


@router.post("/public/git/import", response_model=GitImportResponse)
def import_from_git_repository_for_public(
    request: GitImportRequest,
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """
    Import selected skills from a Git repository as public skills (admin only).

    Supports GitHub, GitLab, Gitee, and Gitea platforms.
    Supports both public and private repositories via:
    - URL embedded credentials (e.g., https://token@github.com/owner/repo)
    - Platform integration tokens configured in Settings

    Skills are imported as public skills (user_id=0).
    If a skill with the same name already exists:
    - If the name is in overwrite_names, the existing skill will be updated
    - Otherwise, the skill will be skipped
    """
    result = git_skill_service.import_skills(
        repo_url=request.repo_url,
        skill_paths=request.skill_paths,
        namespace="default",  # Public skills always use default namespace
        user_id=0,  # Public skill
        overwrite_names=request.overwrite_names,
        db=db,
    )

    return GitImportResponse(
        success=[
            {
                "name": s["name"],
                "path": s["path"],
                "id": s["id"],
                "action": s["action"],
            }
            for s in result.success
        ],
        skipped=[
            {
                "name": s["name"],
                "path": s["path"],
                "reason": s["reason"],
            }
            for s in result.skipped
        ],
        failed=[
            {
                "name": s["name"],
                "path": s["path"],
                "error": s["error"],
            }
            for s in result.failed
        ],
        total_success=len(result.success),
        total_skipped=len(result.skipped),
        total_failed=len(result.failed),
    )


# ============================================================================
# Unified Skill Endpoints (User + Public)
# NOTE: Static routes must be defined BEFORE dynamic routes like /{skill_id}
# ============================================================================


@router.get("/unified", response_model=List[UnifiedSkillResponse])
def list_unified_skills(
    skip: int = Query(0, ge=0, description="Number of items to skip"),
    limit: int = Query(100, ge=1, le=100, description="Number of items to return"),
    scope: str = Query(
        "personal",
        description="Query scope: 'personal' (default), 'group', or 'all'",
    ),
    group_name: Optional[str] = Query(
        None, description="Group name (required when scope='group')"
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List all skills (user's/group's + public).

    Scope behavior:
    - scope='personal' (default): personal skills (current user only) + public skills
    - scope='group': ALL group skills in namespace (from any user) + public skills (requires group_name)
    - scope='all': personal + public + all user's groups

    Returns combined list with user/group skills first, then public skills.
    User/group skills with same name take precedence over public skills.
    """
    from sqlalchemy import or_

    from app.services.group_permission import get_user_groups

    user_skills = []
    user_skill_names = set()

    # Build optimized query based on scope
    if scope == "personal":
        # Personal scope: only query current user's skills in default namespace
        skill_kinds = (
            db.query(Kind)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Skill",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
    elif scope == "group":
        if group_name:
            # Group scope with specific group: query ALL skills in that namespace
            skill_kinds = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Skill",
                    Kind.namespace == group_name,
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .all()
            )
        else:
            # Query all user's groups (excluding default)
            user_groups = get_user_groups(db, current_user.id)
            group_namespaces = [g for g in user_groups if g != "default"]
            if group_namespaces:
                skill_kinds = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Skill",
                        Kind.namespace.in_(group_namespaces),
                        Kind.is_active == True,
                    )
                    .order_by(Kind.created_at.desc())
                    .all()
                )
            else:
                skill_kinds = []
    else:  # scope == "all"
        # Query personal + all user's groups in a single query
        user_groups = get_user_groups(db, current_user.id)
        group_namespaces = [g for g in user_groups if g != "default"]

        # Build OR conditions for optimized single query
        conditions = [
            # Personal skills in default namespace
            (Kind.user_id == current_user.id)
            & (Kind.namespace == "default")
        ]
        if group_namespaces:
            # Group skills in any of user's groups
            conditions.append(Kind.namespace.in_(group_namespaces))

        skill_kinds = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.is_active == True,
                or_(*conditions),
            )
            .order_by(Kind.created_at.desc())
            .all()
        )

    # Convert Kind objects to response format
    for kind in skill_kinds:
        if kind.name not in user_skill_names:
            user_skill_names.add(kind.name)
            spec = kind.json.get("spec", {})

            # Extract source information if available
            source_data = spec.get("source")
            source_info = None
            if source_data:
                source_info = {
                    "type": source_data.get("type", "upload"),
                    "repo_url": source_data.get("repo_url"),
                    "skill_path": source_data.get("skill_path"),
                    "imported_at": source_data.get("imported_at"),
                }

            user_skills.append(
                {
                    "id": kind.id,
                    "name": kind.name,
                    "namespace": kind.namespace,
                    "description": spec.get("description", ""),
                    "displayName": spec.get("displayName"),
                    "version": spec.get("version"),
                    "author": spec.get("author"),
                    "tags": spec.get("tags"),
                    "bindShells": spec.get("bindShells"),
                    "is_active": True,
                    "is_public": False,
                    "user_id": kind.user_id,
                    "source": source_info,
                    "created_at": kind.created_at,
                    "updated_at": kind.updated_at,
                }
            )

    # Get public skills (user_id=0) - single query
    public_skill_kinds = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Skill",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .order_by(Kind.created_at.desc())
        .all()
    )

    # Merge: public skills that don't exist in user's skills
    for kind in public_skill_kinds:
        if kind.name not in user_skill_names:
            spec = kind.json.get("spec", {})
            user_skills.append(
                {
                    "id": kind.id,
                    "name": kind.name,
                    "namespace": kind.namespace,
                    "description": spec.get("description", ""),
                    "displayName": spec.get("displayName"),
                    "version": spec.get("version"),
                    "author": spec.get("author"),
                    "tags": spec.get("tags"),
                    "bindShells": spec.get("bindShells"),
                    "is_active": True,
                    "is_public": True,
                    "user_id": kind.user_id,
                    "source": None,
                    "created_at": kind.created_at,
                    "updated_at": kind.updated_at,
                }
            )

    # Apply pagination
    return user_skills[skip : skip + limit]


# ============================================================================
# Invoke Skill Endpoint
# NOTE: Static routes must be defined BEFORE dynamic routes like /{skill_id}
# ============================================================================


@router.post("/invoke", response_model=InvokeSkillResponse)
def invoke_skill(
    request: InvokeSkillRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get skill prompt content for runtime expansion.

    Searches user's skills first, then public skills.
    """
    # Search user's skill first
    skill = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Skill",
            Kind.name == request.skill_name,
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    # Then search public skill
    if not skill:
        skill = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name == request.skill_name,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

    if not skill:
        raise HTTPException(404, f"Skill '{request.skill_name}' not found")

    skill_crd = Skill.model_validate(skill.json)
    if not skill_crd.spec.prompt:
        raise HTTPException(400, f"Skill '{request.skill_name}' has no prompt content")

    return InvokeSkillResponse(prompt=skill_crd.spec.prompt)


# ============================================================================
# Dynamic Skill Endpoints (with path parameter)
# NOTE: These routes MUST be defined AFTER all static routes to avoid
# path parameter matching static route names like "unified", "public", "invoke"
# ============================================================================


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
    namespace: str = Query("default", description="Namespace for group skill lookup"),
    task_id: int = Query(
        None,
        description="Task ID for task-based authorization. "
        "If provided, allows downloading skills owned by the task owner.",
    ),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
    db: Session = Depends(get_db),
):
    """
    Download Skill ZIP package.

    Used by Executor to download Skills for deployment.
    Search order:
    1. User's personal skill (user_id=current_user)
    2. Group skill in namespace (if namespace != 'default')
    3. Task owner's skill (if task_id provided and user is task member)
    4. Public skill (user_id=0)

    Task-based authorization:
    When task_id is provided, the API will also search for skills owned by the
    task owner. This enables shared team scenarios where user B executes a task
    using user A's team, and needs to download user A's private skills.
    Authorization is verified by checking if current_user is a member of the task.
    """
    # 1. Search user's personal skill first
    skill = skill_kinds_service.get_skill_by_id(
        db=db, skill_id=skill_id, user_id=current_user.id
    )
    binary_data = None

    if skill:
        binary_data = skill_kinds_service.get_skill_binary(
            db=db, skill_id=skill_id, user_id=current_user.id
        )

    # 2. If not found and namespace is not default, search group skill
    if not skill and namespace != "default":
        skill = skill_kinds_service.get_skill_by_id_in_namespace(
            db=db, skill_id=skill_id, namespace=namespace
        )
        if skill:
            binary_data = skill_kinds_service.get_skill_binary_in_namespace(
                db=db, skill_id=skill_id, namespace=namespace
            )

    # 3. If not found and task_id provided, search team owner's skill
    # This enables shared team scenarios where executor downloads skills
    # owned by the original team owner
    if not skill and task_id:
        from app.models.task import TaskResource
        from app.schemas.kind import Task
        from app.services.task_member_service import task_member_service

        # Verify current user is a member of the task (owner or group member)
        if task_member_service.is_member(db, task_id, current_user.id):
            # Get task to find the team owner
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == task_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active.in_(TaskResource.is_active_query()),
                )
                .first()
            )
            if task:
                # Get team owner user_id from task's teamRef
                task_crd = Task.model_validate(task.json)
                team_owner_user_id = task_crd.spec.teamRef.user_id

                # If teamRef.user_id is set and different from current user,
                # search skill owned by team owner
                if team_owner_user_id and team_owner_user_id != current_user.id:
                    skill = skill_kinds_service.get_skill_by_id(
                        db=db, skill_id=skill_id, user_id=team_owner_user_id
                    )
                    if skill:
                        binary_data = skill_kinds_service.get_skill_binary(
                            db=db, skill_id=skill_id, user_id=team_owner_user_id
                        )

    # 4. If still not found, search public skill (user_id=0)
    if not skill:
        skill = skill_kinds_service.get_skill_by_id(db=db, skill_id=skill_id, user_id=0)
        if skill:
            binary_data = skill_kinds_service.get_skill_binary(
                db=db, skill_id=skill_id, user_id=0
            )

    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")

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


@router.post("/{skill_id}/remove-references", response_model=Dict[str, Any])
def remove_skill_references(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove all Ghost references to this Skill.

    This allows the Skill to be deleted afterwards.
    Returns the count of removed references and affected Ghost names.
    """
    skill_kind = _resolve_manageable_skill(
        db=db,
        skill_id=skill_id,
        current_user=current_user,
        action="remove references from",
    )

    result = skill_kinds_service.remove_skill_references(
        db=db, skill_id=skill_id, user_id=skill_kind.user_id
    )
    return result


@router.post("/{skill_id}/remove-reference/{ghost_id}", response_model=Dict[str, Any])
def remove_single_skill_reference(
    skill_id: int,
    ghost_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove a Skill reference from a single Ghost.

    Returns success status and the affected Ghost name.
    """
    skill_kind = _resolve_manageable_skill(
        db=db,
        skill_id=skill_id,
        current_user=current_user,
        action="remove references from",
    )

    result = skill_kinds_service.remove_single_skill_reference(
        db=db, skill_id=skill_id, ghost_id=ghost_id, user_id=skill_kind.user_id
    )
    return result


@router.get("/{skill_id}/references", response_model=SkillReferencesResponse)
def get_skill_references(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Query Ghost references for a Skill without deleting it.

    Permission rules are the same as other skill management operations.
    """
    skill_kind = _resolve_manageable_skill(
        db=db,
        skill_id=skill_id,
        current_user=current_user,
        action="inspect references for",
    )

    return skill_kinds_service.get_skill_references(
        db=db, skill_id=skill_id, user_id=skill_kind.user_id
    )


@router.post("/{skill_id}/update-from-git", response_model=Dict[str, Any])
def update_skill_from_git(
    skill_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update a skill from its original Git repository source.

    This endpoint is only available for skills that were imported from a Git repository.
    It will re-download the skill from the original repository and update the local copy.

    Returns:
        Dict with updated skill info including id, name, version, and source
    """
    skill_kind = _resolve_manageable_skill(
        db=db,
        skill_id=skill_id,
        current_user=current_user,
        action="update",
    )

    result = git_skill_service.update_skill_from_git(
        skill_id=skill_id,
        user_id=skill_kind.user_id,
        db=db,
    )
    return result


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
    skill_kind = _resolve_manageable_skill(
        db=db,
        skill_id=skill_id,
        current_user=current_user,
        action="update",
    )

    skill = skill_kinds_service.update_skill(
        db=db,
        skill_id=skill_id,
        user_id=skill_kind.user_id,
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

    Permission rules:
    - Users can delete their own skills
    - Group Owners/Maintainers can delete any skill in their group
    - System admins can delete any skill

    Returns 400 error if the Skill is referenced by any Ghost.
    """
    skill_kind = _resolve_manageable_skill(
        db=db,
        skill_id=skill_id,
        current_user=current_user,
        action="delete",
    )

    # Use the original user_id for deletion to bypass the service-level check
    skill_kinds_service.delete_skill(
        db=db, skill_id=skill_id, user_id=skill_kind.user_id
    )
    return None
