# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin IM channel management endpoints.

IM channels are stored as Messager CRD in the kinds table with user_id=0.
"""

import logging
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Literal, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

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
from app.services.channels.worker_client import channel_worker_client
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
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
    "bot_token",
}


@dataclass(frozen=True)
class _IMChannelSnapshot:
    """Detached channel configuration safe to carry across an await."""

    id: int
    name: str
    namespace: str
    json: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class _IMChannelMutation:
    """Persisted channel plus the lifecycle action its update requires."""

    channel: _IMChannelSnapshot
    action: Literal["start", "stop", "restart"] | None = None


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


def _kind_to_response(kind: Kind | _IMChannelSnapshot) -> IMChannelResponse:
    """Convert stored or detached channel fields to an API response."""
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


def _active_channel_query(db: Session, channel_id: int):
    return db.query(Kind).filter(
        Kind.id == channel_id,
        Kind.kind == MESSAGER_KIND,
        Kind.user_id == MESSAGER_USER_ID,
        Kind.is_active == True,
    )


def _channel_snapshot(kind: Kind) -> _IMChannelSnapshot:
    """Detach all fields used after the worker Session closes."""
    return _IMChannelSnapshot(
        id=kind.id,
        name=kind.name,
        namespace=kind.namespace,
        json=deepcopy(kind.json or {}),
        created_at=kind.created_at,
        updated_at=kind.updated_at,
    )


def _load_channel_snapshot_from_store(channel_id: int) -> _IMChannelSnapshot | None:
    """Load one active channel using a worker-owned database Session."""
    with get_db_session() as db:
        channel = _active_channel_query(db, channel_id).first()
        return _channel_snapshot(channel) if channel is not None else None


def _create_channel_in_store(channel_data: IMChannelCreate) -> _IMChannelSnapshot:
    """Validate and persist a channel entirely inside one DB worker."""
    with get_db_session() as db:
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
                detail=(
                    f"IM channel '{channel_data.name}' already exists in "
                    f"namespace '{channel_data.namespace}'"
                ),
            )

        now = datetime.now()
        channel = Kind(
            user_id=MESSAGER_USER_ID,
            kind=MESSAGER_KIND,
            name=channel_data.name,
            namespace=channel_data.namespace,
            json=_create_messager_json(
                name=channel_data.name,
                namespace=channel_data.namespace,
                channel_type=channel_data.channel_type,
                is_enabled=channel_data.is_enabled,
                config=channel_data.config,
                default_team_id=channel_data.default_team_id or 0,
                default_model_name=channel_data.default_model_name or "",
            ),
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        db.add(channel)
        db.commit()
        db.refresh(channel)
        return _channel_snapshot(channel)


def _apply_channel_update(
    channel: Kind,
    channel_data: IMChannelUpdate,
) -> tuple[bool, bool]:
    """Apply mutable fields and return prior enablement and restart intent."""
    current_json = deepcopy(channel.json or {})
    spec = current_json.get("spec", {})
    was_enabled = spec.get("isEnabled", True)
    needs_restart = False
    if channel_data.name is not None:
        channel.name = channel_data.name
        current_json.setdefault("metadata", {})["name"] = channel_data.name
    if channel_data.is_enabled is not None:
        spec["isEnabled"] = channel_data.is_enabled
    for field, key in (
        (channel_data.default_team_id, "defaultTeamId"),
        (channel_data.default_model_name, "defaultModelName"),
    ):
        if field is not None:
            spec[key] = field
            needs_restart = True
    if channel_data.config is not None:
        existing_config = spec.get("config", {})
        for key, value in channel_data.config.items():
            if value == "***":
                continue
            existing_config[key] = (
                encrypt_sensitive_data(value)
                if _is_sensitive_key(key) and isinstance(value, str) and value
                else value
            )
        spec["config"] = existing_config
        needs_restart = True
    current_json["spec"] = spec
    channel.json = current_json
    channel.updated_at = datetime.now()
    flag_modified(channel, "json")
    return was_enabled, needs_restart


def _update_channel_in_store(
    channel_id: int,
    channel_data: IMChannelUpdate,
) -> _IMChannelMutation:
    """Persist an update and return detached lifecycle intent."""
    with get_db_session() as db:
        channel = _active_channel_query(db, channel_id).first()
        if channel is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"IM channel with id {channel_id} not found",
            )
        was_enabled, needs_restart = _apply_channel_update(channel, channel_data)
        db.commit()
        db.refresh(channel)
        is_enabled = channel.json.get("spec", {}).get("isEnabled", True)
        action: Literal["start", "stop", "restart"] | None = None
        if was_enabled and not is_enabled:
            action = "stop"
        elif not was_enabled and is_enabled:
            action = "start"
        elif is_enabled and needs_restart:
            action = "restart"
        return _IMChannelMutation(_channel_snapshot(channel), action)


def _toggle_channel_in_store(channel_id: int) -> _IMChannelMutation:
    """Toggle one channel and return a detached lifecycle action."""
    with get_db_session() as db:
        channel = _active_channel_query(db, channel_id).first()
        if channel is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"IM channel with id {channel_id} not found",
            )
        current_json = deepcopy(channel.json or {})
        spec = current_json.get("spec", {})
        was_enabled = spec.get("isEnabled", True)
        spec["isEnabled"] = not was_enabled
        current_json["spec"] = spec
        channel.json = current_json
        channel.updated_at = datetime.now()
        flag_modified(channel, "json")
        db.commit()
        db.refresh(channel)
        return _IMChannelMutation(
            channel=_channel_snapshot(channel),
            action="stop" if was_enabled else "start",
        )


def _delete_channel_in_store(channel_id: int) -> None:
    """Soft-delete one channel after its provider has stopped."""
    with get_db_session() as db:
        channel = _active_channel_query(db, channel_id).first()
        if channel is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"IM channel with id {channel_id} not found",
            )
        channel.is_active = False
        channel.updated_at = datetime.now()
        db.commit()


def _channel_status_response(
    channel: _IMChannelSnapshot,
    status_info: Dict[str, Any] | None,
    *,
    missing_error: str | None,
) -> IMChannelStatus:
    """Combine detached configuration with worker-owned provider state."""
    spec = channel.json.get("spec", {})
    if status_info is None:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=spec.get("channelType", "dingtalk"),
            is_enabled=spec.get("isEnabled", True),
            is_connected=False,
            last_error=missing_error,
        )
    return IMChannelStatus(
        id=channel.id,
        name=channel.name,
        channel_type=spec.get("channelType", "dingtalk"),
        is_enabled=spec.get("isEnabled", True),
        is_connected=status_info.get("is_connected", False),
        last_error=status_info.get("last_error"),
        uptime_seconds=status_info.get("uptime_seconds"),
        extra_info=status_info.get("extra_info"),
    )


class IMChannelAdapter:
    """Expose detached channel configuration to the provider owner."""

    def __init__(self, kind: Kind | _IMChannelSnapshot):
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
def list_im_channels(
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
def get_im_channel(
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
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new IM channel.
    """
    # Validate channel type
    valid_types = ["dingtalk", "feishu", "wechat", "telegram", "discord", "weibo"]
    if channel_data.channel_type not in valid_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid channel type. Must be one of: {', '.join(valid_types)}",
        )

    admin_name = current_user.user_name
    new_channel = await run_sync_in_executor(_create_channel_in_store, channel_data)

    logger.info(
        "[IMChannels] Created channel %s (id=%d, type=%s) by user %s",
        new_channel.name,
        new_channel.id,
        channel_data.channel_type,
        admin_name,
    )

    # Auto-start if enabled
    if channel_data.is_enabled:
        await channel_worker_client.reconcile(new_channel.id)

    return _kind_to_response(new_channel)


@router.put("/im-channels/{channel_id}", response_model=IMChannelResponse)
async def update_im_channel(
    channel_data: IMChannelUpdate,
    channel_id: int = Path(..., description="Channel ID"),
    current_user: User = Depends(get_admin_user),
):
    """
    Update an existing IM channel.
    """
    admin_name = current_user.user_name
    mutation = await run_sync_in_executor(
        _update_channel_in_store,
        channel_id,
        channel_data,
    )
    channel = mutation.channel

    logger.info(
        "[IMChannels] Updated channel %s (id=%d) by user %s",
        channel.name,
        channel.id,
        admin_name,
    )

    if mutation.action == "stop":
        await channel_worker_client.stop(channel.id)
    elif mutation.action == "start":
        await channel_worker_client.reconcile(channel.id)
    elif mutation.action == "restart":
        await channel_worker_client.reconcile(channel.id, force_restart=True)

    return _kind_to_response(channel)


@router.delete("/im-channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete an IM channel (soft delete).
    """
    admin_name = current_user.user_name
    channel = await run_sync_in_executor(
        _load_channel_snapshot_from_store,
        channel_id,
    )
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    # Stop the channel if running
    await channel_worker_client.stop(channel_id)

    await run_sync_in_executor(_delete_channel_in_store, channel_id)

    logger.info(
        "[IMChannels] Deleted channel %s (id=%d) by user %s",
        channel.name,
        channel_id,
        admin_name,
    )

    return None


@router.post("/im-channels/{channel_id}/toggle", response_model=IMChannelResponse)
async def toggle_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle the enabled status of an IM channel.
    """
    admin_name = current_user.user_name
    mutation = await run_sync_in_executor(_toggle_channel_in_store, channel_id)
    channel = mutation.channel
    is_enabled = channel.json.get("spec", {}).get("isEnabled", True)

    logger.info(
        "[IMChannels] Toggled channel %s (id=%d) from %s to %s by user %s",
        channel.name,
        channel.id,
        not is_enabled,
        is_enabled,
        admin_name,
    )

    # Start or stop based on new state
    if mutation.action == "start":
        await channel_worker_client.reconcile(channel.id)
    else:
        await channel_worker_client.stop(channel.id)

    return _kind_to_response(channel)


@router.post("/im-channels/{channel_id}/restart", response_model=IMChannelStatus)
async def restart_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    current_user: User = Depends(get_admin_user),
):
    """
    Restart an IM channel connection.
    """
    admin_name = current_user.user_name
    channel = await run_sync_in_executor(
        _load_channel_snapshot_from_store,
        channel_id,
    )
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    spec = channel.json.get("spec", {})
    is_enabled = spec.get("isEnabled", True)

    if not is_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot restart a disabled channel. Enable it first.",
        )

    logger.info(
        "[IMChannels] Restarting channel %s (id=%d) by user %s",
        channel.name,
        channel.id,
        admin_name,
    )

    success = await channel_worker_client.reconcile(
        channel.id,
        force_restart=True,
    )

    status_info = await channel_worker_client.status(channel_id)
    return _channel_status_response(
        channel,
        status_info,
        missing_error="Channel not running" if not success else None,
    )


@router.get("/im-channels/{channel_id}/status", response_model=IMChannelStatus)
async def get_im_channel_status(
    channel_id: int = Path(..., description="Channel ID"),
    current_user: User = Depends(get_admin_user),
):
    """
    Get the connection status of an IM channel.
    """
    channel = await run_sync_in_executor(
        _load_channel_snapshot_from_store,
        channel_id,
    )
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    status_info = await channel_worker_client.status(channel_id)
    return _channel_status_response(
        channel,
        status_info,
        missing_error="Channel not running",
    )
