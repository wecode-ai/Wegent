# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.models.bot import Bot
from app.schemas.bot import BotCreate, BotUpdate, BotInDB, BotListResponse, BotDetail
from app.services.bot import bot_service

router = APIRouter()

@router.get("", response_model=BotListResponse)
def list_bots(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
):
    """Get current user's Bot list (paginated)"""
    skip = (page - 1) * limit
    items = bot_service.get_user_bots(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit
    )
    total = db.query(Bot).filter(
        Bot.user_id == current_user.id,
        Bot.is_active == True
    ).count()
    return {"total": total, "items": items}

@router.post("", response_model=BotInDB, status_code=status.HTTP_201_CREATED)
def create_bot(
    bot_create: BotCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Create new Bot"""
    return bot_service.create_with_user(db=db, obj_in=bot_create, user_id=current_user.id)

@router.get("/{bot_id}", response_model=BotDetail)
def get_bot(
    bot_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Get specified Bot details with related user"""
    return bot_service.get_bot_detail(db=db, bot_id=bot_id, user_id=current_user.id)

@router.put("/{bot_id}", response_model=BotInDB)
def update_bot(
    bot_id: int,
    bot_update: BotUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Update Bot information"""
    return bot_service.update_with_user(
        db=db,
        bot_id=bot_id,
        obj_in=bot_update,
        user_id=current_user.id
    )

@router.delete("/{bot_id}")
def delete_bot(
    bot_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Delete Bot or deactivate if used in teams"""
    bot_service.delete_with_user(db=db, bot_id=bot_id, user_id=current_user.id)
    return {"message": "Bot deleted successfully"}