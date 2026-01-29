# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin IM channel management endpoints.

IM channels are stored as Messager CRD in the kinds table with user_id=0.
"""

import logging
from datetime import datetime
from typing import Any, Dict, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.im_channel import (
    IMChannelCreate,
    IMChannelListResponse,
    IMChannelResponse,
    IMChannelStatus,
    IMChannelUpdate,
)
from app.services.channels import get_channel_manager
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

router = APIRouter()
logger = logging.getLogger(__name__)

# CRD kind for IM channels
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0  # System-level resource

# Sensitive config keys that should be encrypted
SENSITIVE_CONFIG_KEYS: Set[str] = {
    "client_secret",
    "secret",
    "token",
    "access_token",
    "app_secret",
    "encrypt_key",
    "encoding_aes_key",
}


def _is_sensitive_key(key: str) -> bool:
    """Check if a config key is sensitive and should be encrypted."""
    key_lower = key.lower()
    return any(sk in key_lower for sk in SENSITIVE_CONFIG_KEYS)


def _encrypt_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Encrypt sensitive fields in config before storage."""
    encrypted = config.copy()
    for key, value in config.items():
        if (
            _is_sensitive_key(key)
            and isinstance(value, str)
            and value
            and value != "***"
        ):
            encrypted[key] = encrypt_sensitive_data(value)
    return encrypted


def _decrypt_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Decrypt sensitive fields in config for internal use."""
    decrypted = config.copy()
    for key, value in config.items():
        if _is_sensitive_key(key) and isinstance(value, str) and value:
            decrypted[key] = decrypt_sensitive_data(value)
    return decrypted


def _mask_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Mask sensitive fields in config for API response."""
    masked = config.copy()
    for key in masked:
        if _is_sensitive_key(key):
            masked[key] = "***"
    return masked


def _kind_to_response(kind: Kind) -> IMChannelResponse:
    """Convert Kind model to IMChannelResponse."""
    spec = kind.json.get("spec", {})
    config = spec.get("config", {})

    return IMChannelResponse(
        id=kind.id,
        name=kind.name,
        namespace=kind.namespace,
        channel_type=spec.get("channelType", "dingtalk"),
        is_enabled=spec.get("isEnabled", True),
        config=_mask_config(config),  # Mask sensitive fields
        default_team_id=spec.get("defaultTeamId", 0),
        default_model_name=spec.get("defaultModelName", ""),
        created_at=kind.created_at,
        updated_at=kind.updated_at,
    )


def _create_messager_json(
    name: str,
    namespace: str,
    channel_type: str,
    is_enabled: bool,
    config: Dict[str, Any],
    default_team_id: int,
    default_model_name: str,
) -> Dict[str, Any]:
    """Create Messager CRD JSON structure with encrypted config."""
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": MESSAGER_KIND,
        "metadata": {
            "name": name,
            "namespace": namespace,
        },
        "spec": {
            "channelType": channel_type,
            "isEnabled": is_enabled,
            "config": _encrypt_config(config),  # Encrypt sensitive fields
            "defaultTeamId": default_team_id,
            "defaultModelName": default_model_name,
        },
    }


class IMChannelAdapter:
    """Adapter to make Kind behave like IMChannel for ChannelManager."""

    def __init__(self, kind: Kind):
        self._kind = kind
        spec = kind.json.get("spec", {})
        self.id = kind.id
        self.name = kind.name
        self.channel_type = spec.get("channelType", "dingtalk")
        self.is_enabled = spec.get("isEnabled", True)
        # Decrypt config for actual use
        self.config = _decrypt_config(spec.get("config", {}))
        self.default_team_id = spec.get("defaultTeamId", 0)
        self.default_model_name = spec.get("defaultModelName", "")

    def __repr__(self) -> str:
        return f"<IMChannelAdapter(id={self.id}, name='{self.name}', type='{self.channel_type}')>"


@router.get("/im-channels", response_model=IMChannelListResponse)
async def list_im_channels(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    channel_type: Optional[str] = Query(None, description="Filter by channel type"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all IM channels with pagination.
    """
    query = db.query(Kind).filter(
        Kind.kind == MESSAGER_KIND,
        Kind.user_id == MESSAGER_USER_ID,
        Kind.is_active == True,
    )

    # Get all and filter by channel_type in Python (JSON field)
    all_channels = query.order_by(Kind.id.desc()).all()

    if channel_type:
        all_channels = [
            ch
            for ch in all_channels
            if ch.json.get("spec", {}).get("channelType") == channel_type
        ]

    total = len(all_channels)
    start = (page - 1) * limit
    end = start + limit
    channels = all_channels[start:end]

    return IMChannelListResponse(
        total=total,
        items=[_kind_to_response(channel) for channel in channels],
    )


@router.get("/im-channels/{channel_id}", response_model=IMChannelResponse)
async def get_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get a specific IM channel by ID.
    """
    channel = (
        db.query(Kind)
        .filter(
            Kind.id == channel_id,
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.is_active == True,
        )
        .first()
    )
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )
    return _kind_to_response(channel)


@router.post(
    "/im-channels",
    response_model=IMChannelResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_im_channel(
    channel_data: IMChannelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new IM channel.
    """
    # Validate channel type
    valid_types = ["dingtalk", "feishu", "wechat"]
    if channel_data.channel_type not in valid_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid channel type. Must be one of: {', '.join(valid_types)}",
        )

    # Check for duplicate name in same namespace
    existing = (
        db.query(Kind)
        .filter(
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.name == channel_data.name,
            Kind.namespace == channel_data.namespace,
            Kind.is_active == True,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"IM channel '{channel_data.name}' already exists in namespace '{channel_data.namespace}'",
        )

    # Create Messager CRD
    messager_json = _create_messager_json(
        name=channel_data.name,
        namespace=channel_data.namespace,
        channel_type=channel_data.channel_type,
        is_enabled=channel_data.is_enabled,
        config=channel_data.config,
        default_team_id=channel_data.default_team_id or 0,
        default_model_name=channel_data.default_model_name or "",
    )

    new_channel = Kind(
        user_id=MESSAGER_USER_ID,
        kind=MESSAGER_KIND,
        name=channel_data.name,
        namespace=channel_data.namespace,
        json=messager_json,
        is_active=True,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    db.add(new_channel)
    db.commit()
    db.refresh(new_channel)

    logger.info(
        "[IMChannels] Created channel %s (id=%d, type=%s) by user %s",
        new_channel.name,
        new_channel.id,
        channel_data.channel_type,
        current_user.user_name,
    )

    # Auto-start if enabled
    if channel_data.is_enabled:
        manager = get_channel_manager()
        try:
            adapter = IMChannelAdapter(new_channel)
            await manager.start_channel(adapter)
        except Exception as e:
            logger.warning(
                "[IMChannels] Failed to auto-start channel %s (id=%d): %s",
                new_channel.name,
                new_channel.id,
                e,
            )

    return _kind_to_response(new_channel)


@router.put("/im-channels/{channel_id}", response_model=IMChannelResponse)
async def update_im_channel(
    channel_data: IMChannelUpdate,
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update an existing IM channel.
    """
    channel = (
        db.query(Kind)
        .filter(
            Kind.id == channel_id,
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.is_active == True,
        )
        .first()
    )
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    # Get current spec
    current_json = channel.json.copy()
    spec = current_json.get("spec", {})
    was_enabled = spec.get("isEnabled", True)
    needs_restart = False

    # Update fields
    if channel_data.name is not None:
        channel.name = channel_data.name
        current_json["metadata"]["name"] = channel_data.name
    if channel_data.is_enabled is not None:
        spec["isEnabled"] = channel_data.is_enabled
    if channel_data.default_team_id is not None:
        spec["defaultTeamId"] = channel_data.default_team_id
        needs_restart = True
    if channel_data.default_model_name is not None:
        spec["defaultModelName"] = channel_data.default_model_name
        needs_restart = True
    if channel_data.config is not None:
        # Merge config - encrypt new sensitive values
        existing_config = spec.get("config", {})
        for key, value in channel_data.config.items():
            # Skip masked values (*** means "don't update this field")
            if value == "***":
                continue
            # Encrypt sensitive fields
            if _is_sensitive_key(key) and isinstance(value, str) and value:
                existing_config[key] = encrypt_sensitive_data(value)
            else:
                existing_config[key] = value
        spec["config"] = existing_config
        needs_restart = True

    current_json["spec"] = spec
    channel.json = current_json
    channel.updated_at = datetime.now()

    db.commit()
    db.refresh(channel)

    logger.info(
        "[IMChannels] Updated channel %s (id=%d) by user %s",
        channel.name,
        channel.id,
        current_user.user_name,
    )

    # Handle channel state changes
    manager = get_channel_manager()
    is_enabled = spec.get("isEnabled", True)
    adapter = IMChannelAdapter(channel)

    try:
        if was_enabled and not is_enabled:
            # Channel was disabled
            await manager.stop_channel(channel.id)
        elif not was_enabled and is_enabled:
            # Channel was enabled
            await manager.start_channel(adapter)
        elif is_enabled and needs_restart:
            # Channel config changed, restart
            await manager.restart_channel(adapter)
    except Exception as e:
        logger.warning(
            "[IMChannels] Failed to update channel state for %s (id=%d): %s",
            channel.name,
            channel.id,
            e,
        )

    return _kind_to_response(channel)


@router.delete("/im-channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete an IM channel (soft delete).
    """
    channel = (
        db.query(Kind)
        .filter(
            Kind.id == channel_id,
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.is_active == True,
        )
        .first()
    )
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    # Stop the channel if running
    manager = get_channel_manager()
    try:
        await manager.stop_channel(channel_id)
    except Exception as e:
        logger.warning(
            "[IMChannels] Failed to stop channel before deletion (id=%d): %s",
            channel_id,
            e,
        )

    channel_name = channel.name
    # Soft delete
    channel.is_active = False
    channel.updated_at = datetime.now()
    db.commit()

    logger.info(
        "[IMChannels] Deleted channel %s (id=%d) by user %s",
        channel_name,
        channel_id,
        current_user.user_name,
    )

    return None


@router.post("/im-channels/{channel_id}/toggle", response_model=IMChannelResponse)
async def toggle_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle the enabled status of an IM channel.
    """
    channel = (
        db.query(Kind)
        .filter(
            Kind.id == channel_id,
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.is_active == True,
        )
        .first()
    )
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    current_json = channel.json.copy()
    spec = current_json.get("spec", {})
    was_enabled = spec.get("isEnabled", True)
    spec["isEnabled"] = not was_enabled
    current_json["spec"] = spec
    channel.json = current_json
    channel.updated_at = datetime.now()

    db.commit()
    db.refresh(channel)

    logger.info(
        "[IMChannels] Toggled channel %s (id=%d) from %s to %s by user %s",
        channel.name,
        channel.id,
        was_enabled,
        not was_enabled,
        current_user.user_name,
    )

    # Start or stop based on new state
    manager = get_channel_manager()
    adapter = IMChannelAdapter(channel)
    try:
        if not was_enabled:
            await manager.start_channel(adapter)
        else:
            await manager.stop_channel(channel.id)
    except Exception as e:
        logger.warning(
            "[IMChannels] Failed to toggle channel state for %s (id=%d): %s",
            channel.name,
            channel.id,
            e,
        )

    return _kind_to_response(channel)


@router.post("/im-channels/{channel_id}/restart", response_model=IMChannelStatus)
async def restart_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Restart an IM channel connection.
    """
    channel = (
        db.query(Kind)
        .filter(
            Kind.id == channel_id,
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.is_active == True,
        )
        .first()
    )
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    spec = channel.json.get("spec", {})
    is_enabled = spec.get("isEnabled", True)
    channel_type = spec.get("channelType", "dingtalk")

    if not is_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot restart a disabled channel. Enable it first.",
        )

    logger.info(
        "[IMChannels] Restarting channel %s (id=%d) by user %s",
        channel.name,
        channel.id,
        current_user.user_name,
    )

    manager = get_channel_manager()
    adapter = IMChannelAdapter(channel)
    success = await manager.restart_channel(adapter)

    status_info = manager.get_status(channel_id)
    if status_info:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel_type,
            is_enabled=is_enabled,
            is_connected=status_info.get("is_connected", False),
            last_error=status_info.get("last_error"),
            uptime_seconds=status_info.get("uptime_seconds"),
            extra_info=status_info.get("extra_info"),
        )
    else:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel_type,
            is_enabled=is_enabled,
            is_connected=False,
            last_error="Channel not running" if not success else None,
        )


@router.get("/im-channels/{channel_id}/status", response_model=IMChannelStatus)
async def get_im_channel_status(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get the connection status of an IM channel.
    """
    channel = (
        db.query(Kind)
        .filter(
            Kind.id == channel_id,
            Kind.kind == MESSAGER_KIND,
            Kind.user_id == MESSAGER_USER_ID,
            Kind.is_active == True,
        )
        .first()
    )
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    spec = channel.json.get("spec", {})
    is_enabled = spec.get("isEnabled", True)
    channel_type = spec.get("channelType", "dingtalk")

    manager = get_channel_manager()
    status_info = manager.get_status(channel_id)

    if status_info:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel_type,
            is_enabled=is_enabled,
            is_connected=status_info.get("is_connected", False),
            last_error=status_info.get("last_error"),
            uptime_seconds=status_info.get("uptime_seconds"),
            extra_info=status_info.get("extra_info"),
        )
    else:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel_type,
            is_enabled=is_enabled,
            is_connected=False,
            last_error="Channel not running",
        )
