# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.admin import (
    ChatSloganItem,
    ChatTipItem,
    QuickAccessResponse,
    QuickAccessTeam,
    WelcomeConfigResponse,
)
from app.schemas.user import UserCreate, UserInDB, UserUpdate
from app.services.kind import kind_service
from app.services.user import user_service

router = APIRouter()


@router.get("/me", response_model=UserInDB)
async def read_current_user(current_user: User = Depends(security.get_current_user)):
    """Get current user information"""
    return current_user


@router.put("/me", response_model=UserInDB)
async def update_current_user_endpoint(
    user_update: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Update current user information"""
    try:
        user = user_service.update_current_user(
            db=db,
            user=current_user,
            obj_in=user_update,
        )
        return user
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/me/git-token/{git_domain:path}", response_model=UserInDB)
async def delete_git_token(
    git_domain: str,
    git_info_id: Optional[str] = Query(
        None, description="Unique ID of the git_info entry to delete"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Delete a specific git token

    Args:
        git_domain: Git domain (required for backward compatibility)
        git_info_id: Unique ID of the git_info entry (preferred, for precise deletion)

    If git_info_id is provided, it will be used for precise deletion.
    Otherwise, falls back to deleting by domain (may delete multiple tokens).
    """
    try:
        user = user_service.delete_git_token(
            db=db, user=current_user, git_info_id=git_info_id, git_domain=git_domain
        )
        return user
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("", response_model=UserInDB, status_code=status.HTTP_201_CREATED)
def create_user(
    user_create: UserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
    """Create new user (admin only)"""
    return user_service.create_user(db=db, obj_in=user_create)


QUICK_ACCESS_CONFIG_KEY = "quick_access_recommended"


@router.get("/quick-access", response_model=QuickAccessResponse)
async def get_user_quick_access(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get user's quick access teams merged with system recommendations.
    Returns teams based on version comparison logic.
    """
    # Get system config
    system_config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_ACCESS_CONFIG_KEY)
        .first()
    )
    system_version = system_config.version if system_config else 0
    system_team_ids = (
        system_config.config_value.get("teams", [])
        if system_config and system_config.config_value
        else []
    )

    # Get user preferences
    user_preferences = {}
    if current_user.preferences:
        try:
            user_preferences = json.loads(current_user.preferences)
        except (json.JSONDecodeError, TypeError):
            user_preferences = {}

    quick_access_config = user_preferences.get("quick_access", {})
    user_version = quick_access_config.get("version")
    user_team_ids = quick_access_config.get("teams", [])

    # Determine if we should show system recommended
    show_system_recommended = user_version is None or user_version < system_version

    # Build teams list
    result_teams = []
    seen_team_ids = set()

    # Helper function to get team info
    def get_team_info(team_id: int, is_system: bool) -> Optional[QuickAccessTeam]:
        # Get team from Kind service
        team_data = kind_service.get_team_by_id(team_id)
        if not team_data:
            return None

        # Extract recommended_mode from spec if available
        spec = team_data.get("spec", {})
        recommended_mode = spec.get("recommended_mode", "both")

        return QuickAccessTeam(
            id=team_data.get("id", team_id),
            name=team_data.get("metadata", {}).get("name", f"Team {team_id}"),
            is_system=is_system,
            recommended_mode=recommended_mode,
            agent_type=team_data.get("agent_type"),
        )

    if show_system_recommended:
        # Add system teams first
        for team_id in system_team_ids:
            if team_id not in seen_team_ids:
                team_info = get_team_info(team_id, is_system=True)
                if team_info:
                    result_teams.append(team_info)
                    seen_team_ids.add(team_id)

        # Add user teams (excluding duplicates)
        for team_id in user_team_ids:
            if team_id not in seen_team_ids:
                team_info = get_team_info(team_id, is_system=False)
                if team_info:
                    result_teams.append(team_info)
                    seen_team_ids.add(team_id)
    else:
        # Only show user teams
        for team_id in user_team_ids:
            if team_id not in seen_team_ids:
                team_info = get_team_info(team_id, is_system=False)
                if team_info:
                    result_teams.append(team_info)
                    seen_team_ids.add(team_id)

    return QuickAccessResponse(
        system_version=system_version,
        user_version=user_version,
        show_system_recommended=show_system_recommended,
        teams=result_teams,
    )


# ==================== Welcome Config (Slogan & Tips) ====================

CHAT_SLOGAN_TIPS_CONFIG_KEY = "chat_slogan_tips"

# Default slogan and tips configuration
DEFAULT_SLOGAN_TIPS_CONFIG = {
    "slogans": [
        {
            "id": 1,
            "zh": "今天有什么可以帮到你？",
            "en": "What can I help you with today?",
            "mode": "chat",
        },
        {
            "id": 2,
            "zh": "让我们一起写代码吧",
            "en": "Let's code together",
            "mode": "code",
        },
    ],
    "tips": [
        # Chat mode tips
        {
            "id": 1,
            "zh": "试试问我任何问题，我会尽力帮助你",
            "en": "Try asking me any question, I'll do my best to help",
            "mode": "chat",
        },
        {
            "id": 2,
            "zh": "你可以上传文件让我帮你分析和处理",
            "en": "You can upload files for me to analyze and process",
            "mode": "chat",
        },
        {
            "id": 3,
            "zh": "我可以帮你总结文档、翻译内容或回答问题",
            "en": "I can help you summarize documents, translate content, or answer questions",
            "mode": "chat",
        },
        # Code mode tips
        {
            "id": 4,
            "zh": "试试问我：帮我分析这段代码的性能问题",
            "en": "Try asking: Help me analyze the performance issues in this code",
            "mode": "code",
        },
        {
            "id": 5,
            "zh": "我可以帮你生成代码、修复 Bug 或重构现有代码",
            "en": "I can help you generate code, fix bugs, or refactor existing code",
            "mode": "code",
        },
        {
            "id": 6,
            "zh": "试试让我帮你编写单元测试或文档",
            "en": "Try asking me to write unit tests or documentation",
            "mode": "code",
        },
        {
            "id": 7,
            "zh": "我可以解释复杂的代码逻辑，帮助你理解代码库",
            "en": "I can explain complex code logic and help you understand the codebase",
            "mode": "code",
        },
        # Both modes tips
        {
            "id": 8,
            "zh": "选择合适的智能体团队可以获得更好的回答",
            "en": "Choosing the right agent team can get you better answers",
            "mode": "both",
        },
    ],
}


@router.get("/welcome-config", response_model=WelcomeConfigResponse)
async def get_welcome_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get welcome configuration (slogans and tips) for the chat page.
    This is a public endpoint for logged-in users.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .first()
    )

    if not config:
        # Return default configuration
        return WelcomeConfigResponse(
            slogans=[
                ChatSloganItem(**s) for s in DEFAULT_SLOGAN_TIPS_CONFIG["slogans"]
            ],
            tips=[ChatTipItem(**tip) for tip in DEFAULT_SLOGAN_TIPS_CONFIG["tips"]],
        )

    config_value = config.config_value or {}
    return WelcomeConfigResponse(
        slogans=[
            ChatSloganItem(**s)
            for s in config_value.get("slogans", DEFAULT_SLOGAN_TIPS_CONFIG["slogans"])
        ],
        tips=[
            ChatTipItem(**tip)
            for tip in config_value.get("tips", DEFAULT_SLOGAN_TIPS_CONFIG["tips"])
        ],
    )


class UserSearchItem(BaseModel):
    """User search result item"""

    id: int
    user_name: str
    email: Optional[str] = None


class SearchUsersResponse(BaseModel):
    """User search response"""

    users: list[UserSearchItem]
    total: int


@router.get("/search", response_model=SearchUsersResponse)
async def search_users(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(
        default=20, ge=1, le=100, description="Maximum results to return"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Search users by username or email.
    Used for adding members to group chats.
    """
    # Search users by username or email (case-insensitive)
    query = db.query(User).filter(
        User.is_active == True,
        User.id != current_user.id,  # Exclude current user
    )

    # Search in username and email
    search_pattern = f"%{q}%"
    query = query.filter(
        (User.user_name.ilike(search_pattern)) | (User.email.ilike(search_pattern))
    )

    # Get results with limit
    users = query.limit(limit).all()

    return SearchUsersResponse(
        users=[
            UserSearchItem(id=user.id, user_name=user.user_name, email=user.email)
            for user in users
        ],
        total=len(users),
    )
