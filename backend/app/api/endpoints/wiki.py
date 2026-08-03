# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.wiki_config import wiki_settings
from app.db.session import get_wiki_db
from app.models.user import User
from app.models.wiki import WikiGeneration
from app.schemas.wiki import (
    WikiContentInDB,
    WikiContentWriteRequest,
    WikiGenerationCreate,
    WikiGenerationDetail,
    WikiGenerationInDB,
    WikiGenerationListResponse,
    WikiPageRead,
    WikiProjectDetail,
    WikiProjectInDB,
    WikiProjectListResponse,
)
from app.services.user import user_service
from app.services.wiki_service import wiki_service

logger = logging.getLogger(__name__)

router = APIRouter()
internal_router = APIRouter()


def _verify_internal_token(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> None:
    """
    Verify authorization token for internal content writer.

    Supports two authentication methods:
    1. Internal API token (legacy): Fixed token from wiki_settings.INTERNAL_API_TOKEN
    2. User JWT token (recommended): Standard JWT token from task execution context

    The user JWT token is automatically available in the executor container via
    TASK_INFO environment variable, making it the preferred method for wiki_submit skill.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    token = authorization[7:].strip()

    # First, try internal API token (legacy method)
    if token == wiki_settings.INTERNAL_API_TOKEN:
        logger.debug("Wiki content write authenticated via internal API token")
        return

    # Second, try user JWT token (recommended method)
    try:
        # Verify JWT token and get user
        user = security.get_current_user_from_token(token, db)
        if user and user.is_active:
            logger.debug(
                f"Wiki content write authenticated via JWT token for user {user.id}"
            )
            return
    except Exception as e:
        logger.debug(f"JWT token verification failed: {e}")
        pass

    # Third, a skill identity token. This is what a skill running inside an executor
    # actually holds: the task token it is also given carries no `sub`, so the user
    # lookup above rejects it. Without this the write API is reachable only with the
    # fixed operator token, which no executor is issued.
    if _user_from_skill_identity(token, db) is not None:
        return

    # If neither method works, reject the request
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Invalid authorization token. Use either internal API token or valid user JWT token.",
    )


def _user_from_skill_identity(token: str, db: Session) -> Optional[User]:
    """The user a skill identity token stands for, or ``None``.

    Same shape as the skill download endpoints use, so a skill authenticates the
    same way wherever it calls back to.
    """
    from app.services.auth import verify_skill_identity_token

    token_info = verify_skill_identity_token(token)
    if not token_info:
        return None
    user = db.query(User).filter(User.id == token_info.user_id).first()
    if not user or not user.is_active or user.user_name != token_info.user_name:
        return None
    return user


def _internal_caller(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Authenticate an internal caller and say which user it is, if any.

    ``None`` means the fixed internal token was used, which is a trusted operator
    rather than a person and is not scoped to one generation.
    """
    _verify_internal_token(authorization=authorization, db=db)
    token = authorization[7:].strip()
    if token == wiki_settings.INTERNAL_API_TOKEN:
        return None
    try:
        return security.get_current_user_from_token(token, db)
    except Exception:  # pragma: no cover - _verify_internal_token already accepted it
        return _user_from_skill_identity(token, db)


def _assert_caller_owns_generation(
    wiki_db: Session, caller: Optional[User], generation_id: int
) -> None:
    """Refuse a caller asking about a generation that is not theirs.

    Authenticating a JWT says who is asking, not what they may ask about. Without
    this any signed-in user could read any generation's pages, which is a different
    thing from the documented "your own version" — and that version is a copy of a
    wiki whose repository they may have no access to at all.
    """
    if caller is None:
        return

    generation = (
        wiki_db.query(WikiGeneration).filter(WikiGeneration.id == generation_id).first()
    )
    if generation is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    if generation.user_id != caller.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This generation belongs to another account",
        )


def _resolve_user_id(
    account_id: Optional[int], current_user: User, main_db: Session
) -> int:
    """Resolve effective user ID, allowing admin override when account_id is provided."""
    if account_id is None or account_id == current_user.id:
        return current_user.id

    if current_user.user_name != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admin users can override account_id",
        )

    override_user = user_service.get_user_by_id(main_db, account_id)
    if not override_user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"User with id {account_id} is inactive",
        )
    return override_user.id


# ========== Generation Endpoints ==========
@router.post(
    "/generations",
    response_model=WikiGenerationInDB,
    status_code=status.HTTP_201_CREATED,
)
def create_wiki_generation(
    generation_create: WikiGenerationCreate,
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Create wiki document generation task.

    Verifies that the current user has access to the repository before creating
    the wiki generation task. This ensures users can only generate wikis for
    repositories they have read access to.
    """
    user_id = _resolve_user_id(account_id, current_user, main_db)

    # Get the latest user info from main_db to ensure we have current git_info
    user_for_access_check = (
        main_db.query(User).filter(User.id == current_user.id).first()
    )

    return wiki_service.create_wiki_generation(
        wiki_db=wiki_db,
        obj_in=generation_create,
        user_id=user_id,
        current_user=user_for_access_check,
    )


@router.get("/generations", response_model=WikiGenerationListResponse)
def get_wiki_generations(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    project_id: int = Query(None, description="Filter by project ID"),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Get wiki generation task list.

    Always uses system-bound user ID (WIKI_DEFAULT_USER_ID) for querying generations.
    - When WIKI_DEFAULT_USER_ID > 0: returns system-bound user's generations
    - When WIKI_DEFAULT_USER_ID = 0: returns all users' generations (legacy behavior)
    """
    skip = (page - 1) * limit

    # Always use system-bound user ID for querying generations
    # When WIKI_DEFAULT_USER_ID = 0, pass user_id=0 to query all users' generations (legacy behavior)
    user_id = wiki_settings.DEFAULT_USER_ID  # 0 means query all users (legacy)

    items, total = wiki_service.get_generations(
        db=wiki_db, user_id=user_id, project_id=project_id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/generations/{generation_id}", response_model=WikiGenerationDetail)
def get_wiki_generation(
    generation_id: int,
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Get wiki generation task detail.

    Always uses system-bound user ID (WIKI_DEFAULT_USER_ID) for querying generation details.
    - When WIKI_DEFAULT_USER_ID > 0: returns system-bound user's generation
    - When WIKI_DEFAULT_USER_ID = 0: returns generation for all users (legacy behavior)
    """
    # Always use system-bound user ID for querying generation details
    # When WIKI_DEFAULT_USER_ID = 0, pass user_id=0 to query all users' generation details (legacy behavior)
    user_id = wiki_settings.DEFAULT_USER_ID  # 0 means query all users (legacy)

    generation = wiki_service.get_generation_detail(
        db=wiki_db, generation_id=generation_id, user_id=user_id
    )

    # Get project info
    project = wiki_service.get_project_detail(
        db=wiki_db, project_id=generation.project_id
    )

    # Get contents
    contents = wiki_service.get_generation_contents(
        db=wiki_db, generation_id=generation_id, user_id=user_id
    )

    # Build response
    generation_dict = generation.__dict__.copy()
    generation_dict["project"] = project
    generation_dict["contents"] = contents

    return generation_dict


@internal_router.post("/generations/contents", status_code=status.HTTP_204_NO_CONTENT)
def save_wiki_generation_contents(
    payload: WikiContentWriteRequest,
    _: None = Depends(_verify_internal_token),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Write wiki generation contents and update status (internal use)."""
    wiki_service.save_generation_contents(
        wiki_db=wiki_db,
        payload=payload,
    )
    return None


@internal_router.get("/generations/{generation_id}/pages", response_model=WikiPageRead)
def read_wiki_generation_page(
    generation_id: int,
    path: str = Query(..., min_length=1, description="Stable page path to read"),
    caller: Optional[User] = Depends(_internal_caller),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Read one page of the version the agent is writing into (internal use).

    An incremental version begins as a complete copy of the published wiki, so the
    agent's own generation is also the current wiki — which makes "read your own
    version" both the capability it needs and the narrowest scope that provides it.
    Without this the instruction to revise a page cannot be followed: the agent knows
    the page's path and cannot see a word of what it says.

    Answers 404 when the path holds no page. That is a useful answer rather than a
    failure — in an incremental run it means the page is new.
    """
    _assert_caller_owns_generation(wiki_db, caller, generation_id)
    page = wiki_service.get_generation_page(
        wiki_db=wiki_db, generation_id=generation_id, path=path
    )
    if page is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Generation {generation_id} has no page at '{path}'",
        )
    return page


@router.get(
    "/generations/{generation_id}/contents", response_model=list[WikiContentInDB]
)
def get_wiki_generation_contents(
    generation_id: int,
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Get wiki generation contents.

    Always uses system-bound user ID (WIKI_DEFAULT_USER_ID) for querying generation contents.
    - When WIKI_DEFAULT_USER_ID > 0: returns system-bound user's contents
    - When WIKI_DEFAULT_USER_ID = 0: returns contents for all users (legacy behavior)
    """
    # Always use system-bound user ID for querying generation contents
    # When WIKI_DEFAULT_USER_ID = 0, pass user_id=0 to query all users' generation contents (legacy behavior)
    user_id = wiki_settings.DEFAULT_USER_ID  # 0 means query all users (legacy)

    return wiki_service.get_generation_contents(
        db=wiki_db, generation_id=generation_id, user_id=user_id
    )


@router.post("/generations/{generation_id}/cancel", response_model=WikiGenerationInDB)
def cancel_wiki_generation(
    generation_id: int,
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Cancel a wiki generation task.

    Always uses system-bound user ID (WIKI_DEFAULT_USER_ID) for cancellation.
    - When WIKI_DEFAULT_USER_ID > 0: uses system-bound user for cancellation
    - When WIKI_DEFAULT_USER_ID = 0: uses current user (legacy behavior)
    """
    # Always use system-bound user ID for cancellation
    # When WIKI_DEFAULT_USER_ID = 0, use current user (legacy behavior)
    user_id = (
        wiki_settings.DEFAULT_USER_ID
        if wiki_settings.DEFAULT_USER_ID > 0
        else current_user.id
    )

    return wiki_service.cancel_wiki_generation(
        wiki_db=wiki_db, generation_id=generation_id, user_id=user_id
    )


# ========== Project Endpoints ==========
@router.get("/projects", response_model=WikiProjectListResponse)
def get_wiki_projects(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    project_type: str = Query(None, description="Filter by project type"),
    source_type: str = Query(None, description="Filter by source type"),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """
    Get wiki project list filtered by user's repository access permissions.

    Only returns projects where the current user has read access to the underlying repository.
    """
    skip = (page - 1) * limit

    # Get user from main_db to ensure we have the latest git_info
    user = main_db.query(User).filter(User.id == current_user.id).first()

    items, total = wiki_service.get_projects(
        db=wiki_db,
        user=user,
        skip=skip,
        limit=limit,
        project_type=project_type,
        source_type=source_type,
    )
    return {"total": total, "items": items}


@router.get("/projects/{project_id}", response_model=WikiProjectDetail)
def get_wiki_project(
    project_id: int,
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Get wiki project detail.

    Requires authentication and verifies the current user has read access to the
    underlying repository, matching the filtering applied by the list endpoint.
    Returns project details with recent generations from system-bound user.
    When WIKI_DEFAULT_USER_ID = 0, returns all users' generations (legacy behavior).
    """
    project = wiki_service.get_project_detail(db=wiki_db, project_id=project_id)

    # Enforce the same repository-access check used by the project list endpoint.
    # Get user from main_db to ensure we have the latest git_info.
    user = main_db.query(User).filter(User.id == current_user.id).first()
    if not wiki_service.check_user_project_access(project, user):
        # Use 404 to avoid leaking the existence of inaccessible projects.
        raise HTTPException(status_code=404, detail="Project not found")

    # Get recent generations for this project using system-bound user ID
    # When WIKI_DEFAULT_USER_ID = 0, returns all users' generations (legacy behavior)
    generations, _ = wiki_service.get_generations(
        db=wiki_db,
        user_id=wiki_settings.DEFAULT_USER_ID,  # Use system-bound user ID
        project_id=project_id,
        skip=0,
        limit=10,
    )

    # Build response
    project_dict = project.__dict__.copy()
    project_dict["generations"] = generations

    return project_dict


# ========== Statistics Endpoints ==========
@router.get("/stats/summary")
def get_wiki_stats_summary(
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Get wiki statistics summary for current user"""
    # Get user's generations count by status
    from app.models.wiki import WikiGeneration

    user_id = _resolve_user_id(account_id, current_user, main_db)

    total_generations = (
        wiki_db.query(WikiGeneration).filter(WikiGeneration.user_id == user_id).count()
    )

    pending_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "PENDING")
        .count()
    )

    running_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "RUNNING")
        .count()
    )

    completed_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "COMPLETED")
        .count()
    )

    failed_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "FAILED")
        .count()
    )

    cancelled_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "CANCELLED")
        .count()
    )

    return {
        "total_generations": total_generations,
        "pending_generations": pending_generations,
        "running_generations": running_generations,
        "completed_generations": completed_generations,
        "failed_generations": failed_generations,
        "cancelled_generations": cancelled_generations,
    }


# ========== Config Endpoints ==========
@router.get("/config")
def get_wiki_config(
    code_wiki: bool = Query(
        default=False,
        description="Report on the code wiki team rather than the legacy wiki team",
    ),
    current_user: User = Depends(security.get_current_user),
    main_db: Session = Depends(get_db),
):
    """Get wiki configuration including default team info and bound model"""
    from app.services.adapters.team_kinds import team_kinds_service

    # Which team to report on. The legacy wiki and a code wiki run different teams,
    # so answering for the wrong one tells the caller a model is bound when the run
    # it is about to start has none.
    default_team_name = (
        wiki_settings.CODE_WIKI_TEAM_NAME
        if code_wiki
        else wiki_settings.DEFAULT_TEAM_NAME
    )
    default_user_id = wiki_settings.DEFAULT_USER_ID
    default_team = None
    has_bound_model = False
    bound_model_name = None

    if default_team_name:
        # A code wiki runs as its own owner, so the team has to be resolved for the
        # caller: answering for the legacy wiki account would report a bound model
        # that the run about to start does not have.
        lookup_user_id = (
            current_user.id if code_wiki or default_user_id <= 0 else default_user_id
        )

        # Find team by name and namespace
        team = team_kinds_service.get_team_by_name_and_namespace(
            db=main_db,
            team_name=default_team_name,
            team_namespace="default",
            user_id=lookup_user_id,
        )
        if team:
            # Convert Kind to team dict to get agent_type and bot info
            team_dict = team_kinds_service._convert_to_team_dict(
                team, main_db, lookup_user_id
            )
            default_team = {
                "id": team.id,
                "name": team.name,
                "agent_type": team_dict.get("agent_type"),
            }

            # Check if team has a bound model by examining the first bot's agent_config
            # Note: team_dict uses "bots" key (not "members") with structure:
            # [{"bot_id": ..., "bot_prompt": ..., "role": ..., "bot": {"agent_config": {...}, "shell_type": ...}}]
            bots = team_dict.get("bots", [])
            if bots:
                first_bot_info = bots[0]
                # The bot summary is nested under "bot" key
                bot_summary = first_bot_info.get("bot", {})
                agent_config = bot_summary.get("agent_config", {})
                # Check if agent_config has bind_model (predefined model)
                if agent_config and isinstance(agent_config, dict):
                    bind_model = agent_config.get("bind_model")
                    if bind_model:
                        has_bound_model = True
                        bound_model_name = bind_model
                    else:
                        # Check if agent_config has model configuration (custom config)
                        # Custom config means the bot has a model configured
                        # For custom config, agent_config contains protocol, api_key, base_url, model etc.
                        if (
                            agent_config.get("protocol")
                            or agent_config.get("api_key")
                            or agent_config.get("model")
                        ):
                            has_bound_model = True
                            bound_model_name = "custom"

    return {
        "default_team_name": default_team_name,
        "default_team": default_team,
        "default_user_id": default_user_id,
        "has_bound_model": has_bound_model,
        "bound_model_name": bound_model_name,
        "enabled": wiki_settings.ENABLED,
        "default_language": wiki_settings.DEFAULT_LANGUAGE,
    }
