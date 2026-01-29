# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skills API endpoints for managing Claude Code Skills
"""
import io
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

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
from app.services.git_skill_service import git_skill_service

router = APIRouter()


# Request/Response schemas for new endpoints
class PublicSkillCreate(BaseModel):
    """Schema for creating a public skill"""

    name: str
    description: str
    prompt: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None


class PublicSkillUpdate(BaseModel):
    """Schema for updating a public skill"""

    description: Optional[str] = None
    prompt: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None


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
    prompt: Optional[str] = None
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
        "If false, search with fallback: personal -> group -> public (for usage).",
    ),
    current_user: User = Depends(security.get_current_user),
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
      3. Public skill (user_id=0)
    """
    if name:
        if exact_match:
            # Exact match mode: only search in the specified namespace
            skill = skill_kinds_service.get_skill_by_name(
                db=db, name=name, namespace=namespace, user_id=current_user.id
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

        # 3. Public skill (user_id=0)
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
    Only public repositories are supported.

    Returns a list of skills found in the repository (directories containing SKILL.md).
    """
    skills = git_skill_service.scan_repository(repo_url)

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
    Only public repositories are supported.

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
    current_user: User = Depends(security.get_current_user),
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
    Only public repositories are supported.

    Returns a list of skills found in the repository (directories containing SKILL.md).
    """
    skills = git_skill_service.scan_repository(repo_url)

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
    Only public repositories are supported.

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
    from app.services.group_permission import get_user_groups

    user_skills = []
    user_skill_names = set()

    # Determine which namespaces to query based on scope
    if scope == "personal":
        # Personal scope: only query current user's skills in default namespace
        namespaces_to_query = [("default", True)]  # (namespace, filter_by_user)
    elif scope == "group":
        if group_name:
            # Group scope with specific group: query ALL skills in that namespace
            namespaces_to_query = [(group_name, False)]  # Don't filter by user
        else:
            # Query all user's groups (excluding default)
            user_groups = get_user_groups(db, current_user.id)
            namespaces_to_query = [(g, False) for g in user_groups if g != "default"]
    else:  # scope == "all"
        # Query personal + all user's groups
        user_groups = get_user_groups(db, current_user.id)
        namespaces_to_query = [("default", True)] + [
            (g, False) for g in user_groups if g != "default"
        ]

    # Query skills from all relevant namespaces
    for namespace_info in namespaces_to_query:
        namespace, filter_by_user = namespace_info

        if filter_by_user:
            # Personal namespace: filter by current user
            user_skills_list = skill_kinds_service.list_skills(
                db=db, user_id=current_user.id, skip=0, limit=1000, namespace=namespace
            )
        else:
            # Group namespace: get ALL skills in namespace (from any user)
            user_skills_list = skill_kinds_service.list_skills_in_namespace(
                db=db, namespace=namespace, skip=0, limit=1000
            )

        for skill in user_skills_list.items:
            if skill.metadata.name not in user_skill_names:
                user_skill_names.add(skill.metadata.name)
                # Extract source information if available
                source_info = None
                if hasattr(skill.spec, "source") and skill.spec.source:
                    source_info = {
                        "type": (
                            skill.spec.source.type
                            if hasattr(skill.spec.source, "type")
                            else "upload"
                        ),
                        "repo_url": (
                            skill.spec.source.repo_url
                            if hasattr(skill.spec.source, "repo_url")
                            else None
                        ),
                        "skill_path": (
                            skill.spec.source.skill_path
                            if hasattr(skill.spec.source, "skill_path")
                            else None
                        ),
                        "imported_at": (
                            skill.spec.source.imported_at
                            if hasattr(skill.spec.source, "imported_at")
                            else None
                        ),
                    }
                user_skills.append(
                    {
                        "id": int(skill.metadata.labels.get("id", 0)),
                        "name": skill.metadata.name,
                        "namespace": skill.metadata.namespace,
                        "description": skill.spec.description,
                        "displayName": getattr(skill.spec, "displayName", None),
                        "prompt": skill.spec.prompt,
                        "version": skill.spec.version,
                        "author": skill.spec.author,
                        "tags": skill.spec.tags,
                        "bindShells": skill.spec.bindShells,
                        "is_active": True,
                        "is_public": False,
                        "user_id": int(skill.metadata.labels.get("user_id", 0)),
                        "source": source_info,
                        "created_at": None,
                        "updated_at": None,
                    }
                )

    # Get public skills
    public_skills = public_skill_service.get_skills(db, skip=0, limit=1000)

    # Merge: public skills that don't exist in user's skills
    for skill in public_skills:
        if skill["name"] not in user_skill_names:
            user_skills.append(skill)

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
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Download Skill ZIP package.

    Used by Executor to download Skills for deployment.
    Search order:
    1. User's personal skill (user_id=current_user)
    2. Group skill in namespace (if namespace != 'default')
    3. Public skill (user_id=0)
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

    # 3. If still not found, search public skill (user_id=0)
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
    result = skill_kinds_service.remove_skill_references(
        db=db, skill_id=skill_id, user_id=current_user.id
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
    result = skill_kinds_service.remove_single_skill_reference(
        db=db, skill_id=skill_id, ghost_id=ghost_id, user_id=current_user.id
    )
    return result


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
    result = git_skill_service.update_skill_from_git(
        skill_id=skill_id,
        user_id=current_user.id,
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

    Permission rules:
    - Users can delete their own skills
    - Group Owners/Maintainers can delete any skill in their group
    - System admins can delete any skill

    Returns 400 error if the Skill is referenced by any Ghost.
    """
    from app.services.group_permission import get_effective_role_in_group

    # First, get the skill to check its namespace and owner
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

    # Check permissions
    can_delete = False

    # 1. User can delete their own skills
    if skill_kind.user_id == current_user.id:
        can_delete = True

    # 2. System admin can delete any skill
    elif current_user.role == "admin":
        can_delete = True

    # 3. Group admin (Owner/Maintainer) can delete any skill in their group
    elif skill_kind.namespace != "default":
        user_role = get_effective_role_in_group(
            db, current_user.id, skill_kind.namespace
        )
        if user_role in ["Owner", "Maintainer"]:
            can_delete = True

    if not can_delete:
        raise HTTPException(
            status_code=403,
            detail="You don't have permission to delete this skill",
        )

    # Use the original user_id for deletion to bypass the service-level check
    skill_kinds_service.delete_skill(
        db=db, skill_id=skill_id, user_id=skill_kind.user_id
    )
    return None
