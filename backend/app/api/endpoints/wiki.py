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
from app.models.wiki import WikiGeneration, WikiProject
from app.schemas.wiki import (
    WikiContentWriteRequest,
    WikiGenerationCreate,
    WikiGenerationInDB,
    WikiGenerationListResponse,
    WikiPageRead,
    WikiProjectDetail,
    WikiProjectListResponse,
)
from app.services.knowledge.code_wiki.prompts import build_diagram_correction
from app.services.user import user_service
from app.services.wiki_repository_access import user_can_read_project
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


def _assert_may_read_generation(
    wiki_db: Session, main_db: Session, generation_id: int, current_user: User
) -> WikiGeneration:
    """Refuse a generation the caller has no claim on.

    These endpoints selected by ``WIKI_DEFAULT_USER_ID``, which is a configuration
    value and not a claim: at its default of 0 the service layer reads it as "do not
    filter by user", so any signed-in caller could walk sequential ids and read the
    full page text of anybody's wiki. Set above zero it narrows to one account's
    wikis, which every signed-in caller could then read — a smaller hole, not a
    closed one.

    A generation is readable when the thing it belongs to is:

    * a code wiki (``kind_id``) — the ordinary knowledge-base ACL, the same check
      its own endpoints make;
    * a legacy project — read access to the underlying repository, which is already
      what the project list and detail endpoints require. Generations were simply
      never held to it.

    404 rather than 403 throughout, so a refusal does not confirm that the id exists.

    Returns:
        The generation, so a caller needing its owner does not look it up again.
    """
    generation = wiki_db.query(WikiGeneration).filter_by(id=generation_id).first()
    if generation is None:
        raise HTTPException(status_code=404, detail="Generation not found")

    if generation.kind_id:
        from app.services.knowledge.knowledge_service import KnowledgeService

        knowledge_base, has_access = KnowledgeService.get_knowledge_base(
            db=main_db, knowledge_base_id=generation.kind_id, user_id=current_user.id
        )
        if knowledge_base is None or not has_access:
            raise HTTPException(status_code=404, detail="Generation not found")
        return generation

    _assert_may_read_project(wiki_db, main_db, generation.project_id, current_user)
    return generation


def _assert_may_read_project(
    wiki_db: Session, main_db: Session, project_id: int, current_user: User
) -> None:
    """Refuse a legacy project whose repository the caller cannot read."""
    project = wiki_db.query(WikiProject).filter_by(id=project_id).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Generation not found")

    # Reloaded from the main database: the access check reads git_info, and the
    # request's user may be a stale copy.
    user = main_db.query(User).filter(User.id == current_user.id).first()
    if not user_can_read_project(project, user):
        raise HTTPException(status_code=404, detail="Generation not found")


@router.get("/generations", response_model=WikiGenerationListResponse)
def get_wiki_generations(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    project_id: int = Query(..., description="Project whose generations to list"),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Generations of one legacy project, for a caller who may read its repository.

    ``project_id`` is required. Without it this listed across every project, filtered
    only by WIKI_DEFAULT_USER_ID — a configuration value, not a claim — so the answer
    depended on a deployment setting rather than on who was asking.

    Code wikis are not listed here. Their history is served by
    ``GET /knowledge-bases/{id}/code-wiki/generations``, which applies the ordinary
    knowledge-base ACL.
    """
    skip = (page - 1) * limit
    _assert_may_read_project(wiki_db, main_db, project_id, current_user)

    items, total = wiki_service.get_generations(
        db=wiki_db, user_id=0, project_id=project_id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@internal_router.post("/generations/contents")
def save_wiki_generation_contents(
    payload: WikiContentWriteRequest,
    _: None = Depends(_verify_internal_token),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Write wiki generation contents and update status (internal use).

    Answers with the publish outcome when a run concludes. It used to answer 204 and
    say nothing, so an agent whose version the gate refused was told its run was
    complete while its work was discarded — and it is the only party that could still
    act on the refusal, since it is running and its checkout is there.

    ``corrections`` carries the same argument one step further. Broken diagrams never
    hold a version back, so the run publishes and ends — and the finding was recorded
    where only a human reading the run history would ever see it, which is the one
    party that cannot fix a diagram. Returned here it reaches the agent while it can
    still rewrite the page and finish again.
    """
    outcome = wiki_service.save_generation_contents(
        wiki_db=wiki_db,
        payload=payload,
    )
    if outcome is None:
        return {"published": True, "reason": "", "corrections": ""}
    return {
        "published": outcome.published,
        "reason": outcome.reason,
        "corrections": build_diagram_correction(outcome.verdict.diagram_warnings) or "",
    }


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


@router.post("/generations/{generation_id}/cancel", response_model=WikiGenerationInDB)
def cancel_wiki_generation(
    generation_id: int,
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Stop a run, for a caller entitled to the generation.

    Held to the same claim as reading it. Selecting the account by configuration let
    any signed-in caller cancel any run that account owned — including a code wiki's,
    which would leave its version to be reclaimed hours later.
    """
    generation = _assert_may_read_generation(
        wiki_db, main_db, generation_id, current_user
    )
    # The generation's own owner, not 0. Cancelling filters on user_id strictly --
    # unlike the read paths, where 0 means "no filter" -- so passing 0 here would
    # look for a generation belonging to nobody and cancel nothing.
    user_id = generation.user_id

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
    if not user_can_read_project(project, user):
        # Use 404 to avoid leaking the existence of inaccessible projects.
        raise HTTPException(status_code=404, detail="Project not found")

    # Scoped by the project, which was authorised just above; 0 is the service
    # layer's "no user filter". It read WIKI_DEFAULT_USER_ID here, which narrowed
    # the answer by a configuration value and hid this project's own history from
    # the caller entitled to it.
    generations, _ = wiki_service.get_generations(
        db=wiki_db,
        user_id=0,
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
    from app.models.wiki import WikiGeneration, WikiProject

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
