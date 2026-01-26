# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Integration Startup and Shutdown.

Handles initialization of all IM integrations at application startup
and cleanup at shutdown.
"""

import logging
from typing import Any, Dict

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.services.im.base.message import IMPlatform
from app.services.im.manager import im_manager

# Import providers to register them
import app.services.im.providers  # noqa: F401

logger = logging.getLogger(__name__)


async def init_im_integrations() -> None:
    """
    Initialize all IM integrations at application startup.

    Scans all Teams with enabled IM integrations and starts the
    corresponding providers.
    """
    # Check if IM is enabled globally
    if not getattr(settings, "IM_ENABLED", True):
        logger.info("IM integrations are disabled globally")
        return

    logger.info("Initializing IM integrations...")

    db: Session = SessionLocal()
    try:
        # Query all active Teams
        teams = (
            db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .all()
        )

        initialized_count = 0
        for team in teams:
            if await _init_team_im(team):
                initialized_count += 1

        logger.info(
            f"IM integrations initialized: {initialized_count} providers started"
        )

    except Exception as e:
        logger.error(f"Failed to initialize IM integrations: {e}", exc_info=True)
    finally:
        db.close()


async def _init_team_im(team: Kind) -> bool:
    """
    Initialize IM integrations for a single team.

    Args:
        team: Team Kind model

    Returns:
        True if any provider was started
    """
    started_any = False

    try:
        spec = team.json.get("spec", {})
        im_integrations = spec.get("imIntegrations", [])

        for integration in im_integrations:
            if not integration.get("enabled"):
                continue

            provider_name = integration.get("provider")
            config = integration.get("config", {})

            # Parse platform
            try:
                platform = IMPlatform(provider_name)
            except ValueError:
                logger.warning(f"Unknown IM platform: {provider_name}")
                continue

            # Decrypt sensitive config values
            decrypted_config = _decrypt_config(config)

            # Start provider
            success = await im_manager.start_provider(
                team_id=team.id,
                platform=platform,
                config=decrypted_config,
            )

            if success:
                logger.info(f"Started {platform.value} provider for team {team.id}")
                started_any = True
            else:
                logger.warning(
                    f"Failed to start {platform.value} provider for team {team.id}"
                )

    except Exception as e:
        logger.error(f"Error initializing IM for team {team.id}: {e}")

    return started_any


def _decrypt_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Decrypt encrypted values in the config.

    Values prefixed with "encrypted:" are decrypted.

    Args:
        config: Configuration dictionary

    Returns:
        Decrypted configuration
    """
    from shared.utils.crypto import decrypt_api_key

    decrypted = {}
    for key, value in config.items():
        if isinstance(value, str) and value.startswith("encrypted:"):
            decrypted[key] = decrypt_api_key(value[10:])
        else:
            decrypted[key] = value
    return decrypted


async def shutdown_im_integrations() -> None:
    """
    Shutdown all IM integrations at application shutdown.
    """
    logger.info("Shutting down IM integrations...")
    await im_manager.stop_all()
    logger.info("IM integrations shutdown complete")


async def restart_team_im_integrations(team_id: int) -> bool:
    """
    Restart IM integrations for a specific team.

    Called when team IM configuration is updated.

    Args:
        team_id: Team ID

    Returns:
        True if successful
    """
    from app.services.im.base.message import IMPlatform

    db: Session = SessionLocal()
    try:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .first()
        )

        if not team:
            logger.warning(f"Team {team_id} not found for IM restart")
            return False

        # Stop all existing providers for this team
        for platform in IMPlatform:
            if im_manager.is_provider_active(team_id, platform):
                await im_manager.stop_provider(team_id, platform)

        # Start new providers based on current config
        return await _init_team_im(team)

    except Exception as e:
        logger.error(f"Failed to restart IM for team {team_id}: {e}")
        return False
    finally:
        db.close()
