# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin system configuration endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.admin import (
    AdminSetupCompleteResponse,
    ChatSloganItem,
    ChatSloganTipsResponse,
    ChatSloganTipsUpdate,
    ChatTipItem,
    SystemConfigResponse,
    SystemConfigUpdate,
)

router = APIRouter()

# Config keys
QUICK_ACCESS_CONFIG_KEY = "quick_access_recommended"
CHAT_SLOGAN_TIPS_CONFIG_KEY = "chat_slogan_tips"
ADMIN_SETUP_CONFIG_KEY = "admin_setup_completed"

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
        {
            "id": 1,
            "zh": "试试问我：帮我分析这段代码的性能问题",
            "en": "Try asking: Help me analyze the performance issues in this code",
        },
        {
            "id": 2,
            "zh": "你可以上传文件让我帮你处理",
            "en": "You can upload files for me to help you process",
        },
        {
            "id": 3,
            "zh": "我可以帮你生成代码、修复 Bug 或重构现有代码",
            "en": "I can help you generate code, fix bugs, or refactor existing code",
        },
        {
            "id": 4,
            "zh": "试试让我帮你编写单元测试或文档",
            "en": "Try asking me to write unit tests or documentation",
        },
        {
            "id": 5,
            "zh": "我可以解释复杂的代码逻辑，帮助你理解代码库",
            "en": "I can explain complex code logic and help you understand the codebase",
        },
    ],
}


@router.get("/system-config/quick-access", response_model=SystemConfigResponse)
async def get_quick_access_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get system recommended quick access configuration
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_ACCESS_CONFIG_KEY)
        .first()
    )
    if not config:
        return SystemConfigResponse(version=0, teams=[])

    config_value = config.config_value or {}
    return SystemConfigResponse(
        version=config.version,
        teams=config_value.get("teams", []),
    )


@router.put("/system-config/quick-access", response_model=SystemConfigResponse)
async def update_quick_access_config(
    config_data: SystemConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update system recommended quick access configuration (admin only).
    Version number is automatically incremented.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_ACCESS_CONFIG_KEY)
        .first()
    )

    if not config:
        # Create new config
        config = SystemConfig(
            config_key=QUICK_ACCESS_CONFIG_KEY,
            config_value={"teams": config_data.teams},
            version=1,
            updated_by=current_user.id,
        )
        db.add(config)
    else:
        # Update existing config and increment version
        config.config_value = {"teams": config_data.teams}
        config.version = config.version + 1
        config.updated_by = current_user.id

    db.commit()
    db.refresh(config)

    return SystemConfigResponse(
        version=config.version,
        teams=config.config_value.get("teams", []),
    )


@router.get("/system-config/slogan-tips", response_model=ChatSloganTipsResponse)
async def get_slogan_tips_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get chat slogan and tips configuration
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .first()
    )
    if not config:
        # Return default configuration
        return ChatSloganTipsResponse(
            version=0,
            slogans=[
                ChatSloganItem(**s) for s in DEFAULT_SLOGAN_TIPS_CONFIG["slogans"]
            ],
            tips=[ChatTipItem(**tip) for tip in DEFAULT_SLOGAN_TIPS_CONFIG["tips"]],
        )

    config_value = config.config_value or {}
    return ChatSloganTipsResponse(
        version=config.version,
        slogans=[
            ChatSloganItem(**s)
            for s in config_value.get("slogans", DEFAULT_SLOGAN_TIPS_CONFIG["slogans"])
        ],
        tips=[ChatTipItem(**tip) for tip in config_value.get("tips", [])],
    )


@router.put("/system-config/slogan-tips", response_model=ChatSloganTipsResponse)
async def update_slogan_tips_config(
    config_data: ChatSloganTipsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update chat slogan and tips configuration (admin only).
    Version number is automatically incremented.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .first()
    )

    config_value = {
        "slogans": [s.model_dump() for s in config_data.slogans],
        "tips": [tip.model_dump() for tip in config_data.tips],
    }

    if not config:
        # Create new config
        config = SystemConfig(
            config_key=CHAT_SLOGAN_TIPS_CONFIG_KEY,
            config_value=config_value,
            version=1,
            updated_by=current_user.id,
        )
        db.add(config)
    else:
        # Update existing config and increment version
        config.config_value = config_value
        config.version = config.version + 1
        config.updated_by = current_user.id

    db.commit()
    db.refresh(config)

    return ChatSloganTipsResponse(
        version=config.version,
        slogans=config_data.slogans,
        tips=config_data.tips,
    )


# ==================== Admin Setup Wizard Endpoints ====================


@router.post("/setup-complete", response_model=AdminSetupCompleteResponse)
async def mark_admin_setup_complete(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Mark admin setup wizard as completed.
    This will prevent the wizard from showing on subsequent admin logins.

    Returns:
        AdminSetupCompleteResponse: Contains success status and message
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == ADMIN_SETUP_CONFIG_KEY)
        .first()
    )

    if config:
        # Update existing config
        config.config_value = {"completed": True}
        config.updated_by = current_user.id
        config.version += 1
    else:
        # Create new config
        config = SystemConfig(
            config_key=ADMIN_SETUP_CONFIG_KEY,
            updated_by=current_user.id,
        )
        config.config_value = {"completed": True}
        db.add(config)

    db.commit()

    return AdminSetupCompleteResponse(
        success=True,
        message="Admin setup wizard marked as completed",
    )
