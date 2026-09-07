# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin system configuration endpoints."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.core.wiki_config import (
    CodeWikiGenerationPolicy,
    CodeWikiStrategyBinding,
    CodeWikiTeamRef,
)
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.admin import (
    AdminSetupCompleteResponse,
    ChatSloganItem,
    ChatSloganTipsResponse,
    ChatSloganTipsUpdate,
    ChatTipItem,
    CodeWikiGenerationPolicyConfigResponse,
    CodeWikiGenerationPolicyConfigUpdate,
    CodeWikiGenerationStrategyPolicyItem,
    SystemConfigResponse,
    SystemConfigUpdate,
)
from app.schemas.knowledge import (
    KnowledgeBaseRetrievalProfileResponse,
    KnowledgeBaseRetrievalProfileUpdate,
)
from app.schemas.marketplace_tags import MarketplaceTagsResponse, MarketplaceTagsUpdate
from app.schemas.quick_launch import (
    QuickLaunchFunctionsResponse,
    QuickLaunchFunctionsUpdate,
)
from app.services.knowledge.code_wiki.generation_strategy import (
    LEGACY,
)
from app.services.knowledge.code_wiki.generation_strategy import (
    SYSTEM_CONFIG_KEY as CODE_WIKI_GENERATION_POLICY_CONFIG_KEY,
)
from app.services.knowledge.code_wiki.generation_strategy import (
    ResolvedGenerationStrategy,
    configured_policy,
    definition_for,
    selectable_definitions,
)
from app.services.knowledge.code_wiki.runner import strategy_team_readiness
from app.services.knowledge.retrieval_profile import get_profile, save_profile
from app.services.marketplace_tag_service import marketplace_tag_service

router = APIRouter()

# Config keys
QUICK_ACCESS_CONFIG_KEY = "quick_access_recommended"
QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY = "quick_launch_functions"
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


@router.get(
    "/system-config/code-wiki-retrieval-profile",
    response_model=KnowledgeBaseRetrievalProfileResponse,
)
def get_knowledge_base_retrieval_profile(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> KnowledgeBaseRetrievalProfileResponse:
    """Return the retrieval profile and its current resource-reference health."""
    del current_user
    retrieval_config, version, health = get_profile(db)
    return KnowledgeBaseRetrievalProfileResponse(
        version=version,
        retrieval_config=retrieval_config,
        health=health,
    )


@router.put(
    "/system-config/code-wiki-retrieval-profile",
    response_model=KnowledgeBaseRetrievalProfileResponse,
)
def update_knowledge_base_retrieval_profile(
    profile: KnowledgeBaseRetrievalProfileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> KnowledgeBaseRetrievalProfileResponse:
    """Replace the administrator-managed retrieval baseline for new knowledge bases."""
    retrieval_config, version, health = save_profile(
        db,
        retrieval_config=profile.retrieval_config.model_dump(exclude_none=True),
        updated_by=current_user.id,
    )
    return KnowledgeBaseRetrievalProfileResponse(
        version=version,
        retrieval_config=retrieval_config,
        health=health,
    )


def _code_wiki_generation_policy_response(
    db: Session,
) -> CodeWikiGenerationPolicyConfigResponse:
    """Expose registered strategies while keeping the legacy compatibility binding internal."""

    stored = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CODE_WIKI_GENERATION_POLICY_CONFIG_KEY)
        .first()
    )
    policy = configured_policy(db)
    fallback_binding = policy.strategies[LEGACY]
    strategies = []
    for definition in selectable_definitions():
        binding = policy.strategies.get(definition.strategy_id)
        if binding is None:
            binding = CodeWikiStrategyBinding(
                enabled=False,
                teamRef=fallback_binding.team_ref,
            )
        strategies.append(
            CodeWikiGenerationStrategyPolicyItem(
                id=definition.strategy_id,
                enabled=binding.enabled,
                team_name=binding.team_ref.name,
                team_namespace=binding.team_ref.namespace,
                display_name=definition.display_name,
                description=definition.description,
            )
        )
    return CodeWikiGenerationPolicyConfigResponse(
        version=stored.version if stored is not None else 0,
        configured=stored is not None,
        default_strategy=policy.default_strategy,
        strategies=strategies,
    )


@router.get(
    "/system-config/code-wiki-generation-policy",
    response_model=CodeWikiGenerationPolicyConfigResponse,
)
def get_code_wiki_generation_policy(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> CodeWikiGenerationPolicyConfigResponse:
    """Return the administrator-managed Code Wiki strategy policy."""

    del current_user
    return _code_wiki_generation_policy_response(db)


@router.put(
    "/system-config/code-wiki-generation-policy",
    response_model=CodeWikiGenerationPolicyConfigResponse,
)
def update_code_wiki_generation_policy(
    policy_input: CodeWikiGenerationPolicyConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> CodeWikiGenerationPolicyConfigResponse:
    """Persist only known strategies after validating their selected Team resources."""

    definitions = {item.strategy_id: item for item in selectable_definitions()}
    provided = {item.id: item for item in policy_input.strategies}
    if len(provided) != len(policy_input.strategies) or set(provided) != set(
        definitions
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Every registered Code Wiki generation strategy must be configured",
        )
    if policy_input.default_strategy not in definitions:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The default Code Wiki generation strategy is unknown",
        )
    if not provided[policy_input.default_strategy].enabled:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The default Code Wiki generation strategy must be enabled",
        )

    bindings = {
        strategy_id: CodeWikiStrategyBinding(
            enabled=item.enabled,
            teamRef=CodeWikiTeamRef(
                name=item.team_name,
                namespace=item.team_namespace,
            ),
        )
        for strategy_id, item in provided.items()
    }
    current_policy = configured_policy(db)
    legacy_binding = current_policy.strategies[LEGACY]
    policy = CodeWikiGenerationPolicy(
        defaultStrategy=policy_input.default_strategy,
        legacyFallbackStrategy=LEGACY,
        strategies={**bindings, LEGACY: legacy_binding},
    )
    for strategy_id, binding in bindings.items():
        if not binding.enabled:
            continue
        reason = strategy_team_readiness(
            db,
            current_user,
            ResolvedGenerationStrategy(
                definition=definition_for(strategy_id),
                team_ref=binding.team_ref,
            ),
        )
        if reason:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{strategy_id}: {reason}",
            )

    stored = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CODE_WIKI_GENERATION_POLICY_CONFIG_KEY)
        .first()
    )
    if stored is None:
        stored = SystemConfig(
            config_key=CODE_WIKI_GENERATION_POLICY_CONFIG_KEY,
            config_value=policy.model_dump(by_alias=True),
            version=1,
            updated_by=current_user.id,
        )
        db.add(stored)
    else:
        stored.config_value = policy.model_dump(by_alias=True)
        stored.version += 1
        stored.updated_by = current_user.id
    db.commit()
    return _code_wiki_generation_policy_response(db)


@router.get(
    "/system-config/marketplace-tags",
    response_model=MarketplaceTagsResponse,
)
def get_marketplace_tags_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> MarketplaceTagsResponse:
    """Get the marketplace tag catalog."""
    return marketplace_tag_service.get_config(db)


@router.put(
    "/system-config/marketplace-tags",
    response_model=MarketplaceTagsResponse,
)
def update_marketplace_tags_config(
    config_data: MarketplaceTagsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> MarketplaceTagsResponse:
    """Replace the marketplace tag catalog."""
    return marketplace_tag_service.update_config(
        db,
        items=config_data.items,
        expected_version=config_data.expected_version,
        current_user=current_user,
    )


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


@router.get(
    "/system-config/quick-launch-functions",
    response_model=QuickLaunchFunctionsResponse,
)
async def get_quick_launch_functions_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get system function launchers shown in the homepage QuickCard.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY)
        .first()
    )
    if not config:
        return QuickLaunchFunctionsResponse(version=0, functions=[])

    config_value = config.config_value or {}
    return QuickLaunchFunctionsResponse(
        version=config.version,
        functions=config_value.get("functions", []),
    )


@router.put(
    "/system-config/quick-launch-functions",
    response_model=QuickLaunchFunctionsResponse,
)
async def update_quick_launch_functions_config(
    config_data: QuickLaunchFunctionsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update system function launchers shown in the homepage QuickCard.
    """
    config_value = {
        "functions": [function.model_dump() for function in config_data.functions]
    }
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY)
        .first()
    )

    if not config:
        config = SystemConfig(
            config_key=QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY,
            config_value=config_value,
            version=1,
            updated_by=current_user.id,
        )
        db.add(config)
    else:
        config.config_value = config_value
        config.version = config.version + 1
        config.updated_by = current_user.id

    db.commit()
    db.refresh(config)

    return QuickLaunchFunctionsResponse(
        version=config.version,
        functions=config_value["functions"],
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
