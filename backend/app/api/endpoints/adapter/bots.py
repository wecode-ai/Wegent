# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.bot import BotCreate, BotDetail, BotInDB, BotListResponse, BotUpdate
from app.services.adapters import bot_kinds_service

router = APIRouter()


@router.get("", response_model=BotListResponse)
def list_bots(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    scope: str = Query(
        "personal", description="Resource scope: personal, group, or all"
    ),
    group_name: str = Query(
        None, description="Group name (required when scope is 'group')"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get current user's Bot list (paginated) with scope support"""
    skip = (page - 1) * limit
    bot_dicts = bot_kinds_service.get_user_bots(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        scope=scope,
        group_name=group_name,
    )
    if page == 1 and len(bot_dicts) < limit:
        total = len(bot_dicts)
    else:
        total = bot_kinds_service.count_user_bots(
            db=db, user_id=current_user.id, scope=scope, group_name=group_name
        )

    # bot_dicts are already in the correct format
    return {"total": total, "items": bot_dicts}


@router.post("", response_model=BotInDB, status_code=status.HTTP_201_CREATED)
def create_bot(
    bot_create: BotCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new Bot"""
    bot_dict = bot_kinds_service.create_with_user(
        db=db, obj_in=bot_create, user_id=current_user.id
    )
    return bot_dict


@router.get("/{bot_id}", response_model=BotDetail)
def get_bot(
    bot_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified Bot details with related user"""
    bot_dict = bot_kinds_service.get_bot_detail(
        db=db, bot_id=bot_id, user_id=current_user.id
    )
    return bot_dict


@router.put("/{bot_id}", response_model=BotInDB)
def update_bot(
    bot_id: int,
    bot_update: BotUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update Bot information"""
    import logging

    logger = logging.getLogger(__name__)
    logger.info(f"[DEBUG] update_bot called with bot_id={bot_id}")
    logger.info(f"[DEBUG] bot_update raw: {bot_update}")
    logger.info(f"[DEBUG] bot_update.agent_config: {bot_update.agent_config}")
    logger.info(
        f"[DEBUG] bot_update.model_dump(exclude_unset=True): {bot_update.model_dump(exclude_unset=True)}"
    )

    bot_dict = bot_kinds_service.update_with_user(
        db=db, bot_id=bot_id, obj_in=bot_update, user_id=current_user.id
    )
    return bot_dict


@router.delete("/{bot_id}")
def delete_bot(
    bot_id: int,
    force: bool = Query(
        False, description="Force delete even if bot has running tasks"
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete Bot or deactivate if used in teams"""
    bot_kinds_service.delete_with_user(
        db=db, bot_id=bot_id, user_id=current_user.id, force=force
    )
    return {"message": "Bot deleted successfully"}


@router.get("/{bot_id}/running-tasks")
def check_bot_running_tasks(
    bot_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Check if bot has any running tasks"""
    result = bot_kinds_service.check_running_tasks(
        db=db, bot_id=bot_id, user_id=current_user.id
    )
    return result
