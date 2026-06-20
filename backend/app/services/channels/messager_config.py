# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared Messager channel configuration readers."""

from typing import Any, Dict, Optional

from app.db.session import SessionLocal
from app.models.kind import Kind

MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0
DEFAULT_USER_MAPPING_MODE = "select_user"


def _get_channel_spec(channel_id: int) -> Optional[Dict[str, Any]]:
    """Load the active Messager CRD spec for a channel."""
    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active.is_(True),
            )
            .first()
        )
        if not channel:
            return None
        return channel.json.get("spec", {})
    finally:
        db.close()


def get_channel_default_team_id(channel_id: int) -> Optional[int]:
    """Get the current default team ID for a channel."""
    spec = _get_channel_spec(channel_id)
    if spec is None:
        return None
    return spec.get("defaultTeamId", 0)


def get_channel_default_model_name(channel_id: int) -> Optional[str]:
    """Get the current default model name for a channel."""
    spec = _get_channel_spec(channel_id)
    if spec is None:
        return None
    model_name = spec.get("defaultModelName", "")
    return model_name if model_name else None


def get_channel_user_mapping_config(channel_id: int) -> Dict[str, Any]:
    """Get the current user mapping configuration for a channel."""
    spec = _get_channel_spec(channel_id)
    if spec is None:
        return {"mode": DEFAULT_USER_MAPPING_MODE, "config": None}

    config = spec.get("config", {})
    return {
        "mode": config.get("user_mapping_mode", DEFAULT_USER_MAPPING_MODE),
        "config": config.get("user_mapping_config"),
    }
