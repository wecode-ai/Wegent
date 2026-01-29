# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk module.

This module provides:
1. DingTalk OAuth authentication
2. DingTalk register user mapper for enterprise user resolution

"""
import logging

from app.core.config import settings

logger = logging.getLogger(__name__)

if settings.AUTH_MODE == "dingtalk":
    from app.api.router import api_router
    from dingtalk.api.auth import router as dingtalk_router
    from dingtalk.config import dingtalk_config

    # Validate configuration
    if not dingtalk_config.validate():
        logger.warning(
            "[DingTalk] Configuration incomplete. "
            "Please set DINGTALK_CORP_ID, DINGTALK_CLIENT_ID, and DINGTALK_CLIENT_SECRET."
        )
    else:
        # Register DingTalk auth routes
        api_router.include_router(
            dingtalk_router, prefix="/auth/dingtalk", tags=["auth", "dingtalk"]
        )
        logger.info("[DingTalk] Authentication module loaded successfully")

# Register internal user mapper for enterprise user resolution
from app.services.channels.dingtalk.user_mapping import set_user_mapper
from dingtalk.user_mapper import ERPUserMapper

set_user_mapper(ERPUserMapper())
logger.info("[DingTalk] Enterprise user mapper (ERPUserMapper) registered")
