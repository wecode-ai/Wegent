# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk authentication module.
This module is loaded via side-effect import when AUTH_MODE=dingtalk.
"""
import logging
import os

logger = logging.getLogger(__name__)

# Only register routes when DingTalk mode is enabled
AUTH_MODE = os.getenv("AUTH_MODE", "local")

if AUTH_MODE == "dingtalk":
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
