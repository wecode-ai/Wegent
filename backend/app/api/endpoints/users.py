# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.admin import (
    ChatSloganItem,
    ChatTipItem,
    QuickAccessModeConfig,
    QuickAccessResponse,
    QuickAccessTeam,
    QuickAccessUpdate,
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
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Create new user"""
    return user_service.create_user(
        db=db, obj_in=user_create, background_tasks=background_tasks
    )


QUICK_ACCESS_CONFIG_KEY = "quick_access_recommended"


def _get_team_info(
    team_id: int, is_pinned: bool, is_system: bool
) -> Optional[QuickAccessTeam]:
    """Helper function to get team info"""
    team_data = kind_service.get_team_by_id(team_id)
    if not team_data:
        return None

    spec = team_data.get("spec", {})
    recommended_mode = spec.get("recommended_mode", "both")
    metadata = team_data.get("metadata", {})

    return QuickAccessTeam(
        id=team_data.get("id", team_id),
        name=metadata.get("name", f"Team {team_id}"),
        is_pinned=is_pinned,
        is_system=is_system,
        recommended_mode=recommended_mode,
        agent_type=team_data.get("agent_type"),
        icon=spec.get("icon"),
    )


def _build_display_teams(
    pinned_team_ids: List[int],
    max_count: int,
    mode: Literal["chat", "code"],
    system_team_ids: List[int],
    user_id: int,
) -> List[QuickAccessTeam]:
    """Build display teams list: pinned teams + auto-filled teams"""
    display_teams = []
    seen_team_ids = set()

    # Helper to check if team matches the mode
    def team_matches_mode(team_data: dict) -> bool:
        if not team_data:
            return False
        spec = team_data.get("spec", {})
        bind_mode = spec.get("bind_mode", [])
        # If bind_mode is empty/not set, show in all modes
        if not bind_mode:
            return True
        return mode in bind_mode

    # First: add user pinned teams (in order)
    for team_id in pinned_team_ids:
        if len(display_teams) >= max_count:
            break
        if team_id in seen_team_ids:
            continue
        # Verify team exists and matches mode
        team_data = kind_service.get_team_by_id(team_id)
        if team_data and team_matches_mode(team_data):
            team_info = _get_team_info(
                team_id, is_pinned=True, is_system=team_id in system_team_ids
            )
            if team_info:
                display_teams.append(team_info)
                seen_team_ids.add(team_id)

    # Calculate how many more teams to fill
    fill_count = max_count - len(display_teams)
    if fill_count <= 0:
        return display_teams

    # Second: auto-fill with system recommended teams
    for team_id in system_team_ids:
        if len(display_teams) >= max_count:
            break
        if team_id in seen_team_ids:
            continue
        team_data = kind_service.get_team_by_id(team_id)
        if team_data and team_matches_mode(team_data):
            team_info = _get_team_info(team_id, is_pinned=False, is_system=True)
            if team_info:
                display_teams.append(team_info)
                seen_team_ids.add(team_id)

    # Third: auto-fill with user's own teams (sorted by updated_at desc)
    if len(display_teams) < max_count:
        user_teams = kind_service.get_user_teams_sorted(user_id, mode)
        for team in user_teams:
            if len(display_teams) >= max_count:
                break
            team_id = team.get("id")
            if team_id and team_id not in seen_team_ids:
                team_info = _get_team_info(team_id, is_pinned=False, is_system=False)
                if team_info:
                    display_teams.append(team_info)
                    seen_team_ids.add(team_id)

    return display_teams


@router.get("/quick-access", response_model=QuickAccessResponse)
async def get_user_quick_access(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get user's quick access configuration for chat and code modes.
    Returns pinned teams + auto-filled teams up to max_count.
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

    # Support both old format (teams) and new format (chat/code)
    # Old format: {"version": 1, "teams": [...]}
    # New format: {"version": 2, "chat": {...}, "code": {...}}

    def get_mode_config(mode: str) -> dict:
        """Get mode-specific config with fallback to legacy format"""
        if mode in quick_access_config and isinstance(
            quick_access_config[mode], dict
        ):
            return quick_access_config[mode]
        # Fallback to legacy format
        legacy_teams = quick_access_config.get("teams", [])
        return {"max_count": 8, "pinned_teams": legacy_teams}

    chat_config = get_mode_config("chat")
    code_config = get_mode_config("code")

    # Build display teams for each mode
    chat_display_teams = _build_display_teams(
        pinned_team_ids=chat_config.get("pinned_teams", []),
        max_count=chat_config.get("max_count", 8),
        mode="chat",
        system_team_ids=system_team_ids,
        user_id=current_user.id,
    )

    code_display_teams = _build_display_teams(
        pinned_team_ids=code_config.get("pinned_teams", []),
        max_count=code_config.get("max_count", 8),
        mode="code",
        system_team_ids=system_team_ids,
        user_id=current_user.id,
    )

    return QuickAccessResponse(
        system_version=system_version,
        user_version=user_version,
        chat=QuickAccessModeConfig(
            max_count=chat_config.get("max_count", 8),
            pinned_teams=chat_config.get("pinned_teams", []),
            display_teams=chat_display_teams,
        ),
        code=QuickAccessModeConfig(
            max_count=code_config.get("max_count", 8),
            pinned_teams=code_config.get("pinned_teams", []),
            display_teams=code_display_teams,
        ),
    )


@router.put("/quick-access", response_model=QuickAccessResponse)
async def update_user_quick_access(
    update_data: QuickAccessUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update user's quick access configuration.
    Returns the updated configuration with display_teams.
    """
    # Get current user preferences
    user_preferences = {}
    if current_user.preferences:
        try:
            user_preferences = json.loads(current_user.preferences)
        except (json.JSONDecodeError, TypeError):
            user_preferences = {}

    # Get or create quick_access config
    quick_access_config = user_preferences.get("quick_access", {})

    # Get system config for version
    system_config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_ACCESS_CONFIG_KEY)
        .first()
    )
    system_version = system_config.version if system_config else 0

    # Update version to indicate user has customized
    quick_access_config["version"] = 2

    # Update chat config
    if update_data.chat:
        quick_access_config["chat"] = {
            "max_count": update_data.chat.max_count,
            "pinned_teams": update_data.chat.pinned_teams,
        }

    # Update code config
    if update_data.code:
        quick_access_config["code"] = {
            "max_count": update_data.code.max_count,
            "pinned_teams": update_data.code.pinned_teams,
        }

    # Save to user preferences
    user_preferences["quick_access"] = quick_access_config
    current_user.preferences = json.dumps(user_preferences)
    db.commit()

    # Get system team IDs for building display teams
    system_team_ids = (
        system_config.config_value.get("teams", [])
        if system_config and system_config.config_value
        else []
    )

    # Build response with display_teams
    chat_config = quick_access_config.get("chat", {"max_count": 8, "pinned_teams": []})
    code_config = quick_access_config.get("code", {"max_count": 8, "pinned_teams": []})

    chat_display_teams = _build_display_teams(
        pinned_team_ids=chat_config.get("pinned_teams", []),
        max_count=chat_config.get("max_count", 8),
        mode="chat",
        system_team_ids=system_team_ids,
        user_id=current_user.id,
    )

    code_display_teams = _build_display_teams(
        pinned_team_ids=code_config.get("pinned_teams", []),
        max_count=code_config.get("max_count", 8),
        mode="code",
        system_team_ids=system_team_ids,
        user_id=current_user.id,
    )

    return QuickAccessResponse(
        system_version=system_version,
        user_version=quick_access_config.get("version"),
        chat=QuickAccessModeConfig(
            max_count=chat_config.get("max_count", 8),
            pinned_teams=chat_config.get("pinned_teams", []),
            display_teams=chat_display_teams,
        ),
        code=QuickAccessModeConfig(
            max_count=code_config.get("max_count", 8),
            pinned_teams=code_config.get("pinned_teams", []),
            display_teams=code_display_teams,
        ),
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
