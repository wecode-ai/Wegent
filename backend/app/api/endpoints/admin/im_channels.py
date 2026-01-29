# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin IM channel management endpoints."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.im_channel import IMChannel
from app.models.user import User
from app.schemas.im_channel import (
    IMChannelCreate,
    IMChannelListResponse,
    IMChannelResponse,
    IMChannelStatus,
    IMChannelUpdate,
)
from app.services.channels import get_channel_manager

router = APIRouter()
logger = logging.getLogger(__name__)


def _channel_to_response(channel: IMChannel) -> IMChannelResponse:
    """Convert IMChannel model to IMChannelResponse."""
    return IMChannelResponse(
        id=channel.id,
        name=channel.name,
        channel_type=channel.channel_type,
        is_enabled=channel.is_enabled,
        config=channel.get_masked_config(),  # Mask sensitive fields
        default_team_id=channel.default_team_id,
        default_model_name=channel.default_model_name,
        created_at=channel.created_at,
        updated_at=channel.updated_at,
        created_by=channel.create_user_id,
    )


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
    query = db.query(IMChannel)

    if channel_type:
        query = query.filter(IMChannel.channel_type == channel_type)

    total = query.count()
    channels = (
        query.order_by(IMChannel.id.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    return IMChannelListResponse(
        total=total,
        items=[_channel_to_response(channel) for channel in channels],
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
    channel = db.query(IMChannel).filter(IMChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )
    return _channel_to_response(channel)


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

    # Create channel
    new_channel = IMChannel(
        name=channel_data.name,
        channel_type=channel_data.channel_type,
        is_enabled=channel_data.is_enabled,
        default_team_id=(
            channel_data.default_team_id if channel_data.default_team_id else 0
        ),
        default_model_name=channel_data.default_model_name or "",
        create_user_id=current_user.id,
    )
    new_channel.config = channel_data.config

    db.add(new_channel)
    db.commit()
    db.refresh(new_channel)

    logger.info(
        "[IMChannels] Created channel %s (id=%d, type=%s) by user %s",
        new_channel.name,
        new_channel.id,
        new_channel.channel_type,
        current_user.user_name,
    )

    # Auto-start if enabled
    if new_channel.is_enabled:
        manager = get_channel_manager()
        try:
            await manager.start_channel(new_channel)
        except Exception as e:
            logger.warning(
                "[IMChannels] Failed to auto-start channel %s (id=%d): %s",
                new_channel.name,
                new_channel.id,
                e,
            )

    return _channel_to_response(new_channel)


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
    channel = db.query(IMChannel).filter(IMChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    # Track if we need to restart the channel
    needs_restart = False
    was_enabled = channel.is_enabled

    # Update fields
    if channel_data.name is not None:
        channel.name = channel_data.name
    if channel_data.is_enabled is not None:
        channel.is_enabled = channel_data.is_enabled
    if channel_data.default_team_id is not None:
        channel.default_team_id = channel_data.default_team_id
        needs_restart = True
    if channel_data.default_model_name is not None:
        # Empty string means clear the model override
        channel.default_model_name = channel_data.default_model_name
        needs_restart = True
    if channel_data.config is not None:
        # Merge config - preserve existing keys that aren't being updated
        existing_config = channel.config
        for key, value in channel_data.config.items():
            existing_config[key] = value
        channel.config = existing_config
        needs_restart = True

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
    try:
        if was_enabled and not channel.is_enabled:
            # Channel was disabled
            await manager.stop_channel(channel.id)
        elif not was_enabled and channel.is_enabled:
            # Channel was enabled
            await manager.start_channel(channel)
        elif channel.is_enabled and needs_restart:
            # Channel config changed, restart
            await manager.restart_channel(channel)
    except Exception as e:
        logger.warning(
            "[IMChannels] Failed to update channel state for %s (id=%d): %s",
            channel.name,
            channel.id,
            e,
        )

    return _channel_to_response(channel)


@router.delete("/im-channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete an IM channel.
    """
    channel = db.query(IMChannel).filter(IMChannel.id == channel_id).first()
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
    db.delete(channel)
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
    channel = db.query(IMChannel).filter(IMChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    was_enabled = channel.is_enabled
    channel.is_enabled = not channel.is_enabled
    db.commit()
    db.refresh(channel)

    logger.info(
        "[IMChannels] Toggled channel %s (id=%d) from %s to %s by user %s",
        channel.name,
        channel.id,
        was_enabled,
        channel.is_enabled,
        current_user.user_name,
    )

    # Start or stop based on new state
    manager = get_channel_manager()
    try:
        if channel.is_enabled:
            await manager.start_channel(channel)
        else:
            await manager.stop_channel(channel.id)
    except Exception as e:
        logger.warning(
            "[IMChannels] Failed to toggle channel state for %s (id=%d): %s",
            channel.name,
            channel.id,
            e,
        )

    return _channel_to_response(channel)


@router.post("/im-channels/{channel_id}/restart", response_model=IMChannelStatus)
async def restart_im_channel(
    channel_id: int = Path(..., description="Channel ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Restart an IM channel connection.
    """
    channel = db.query(IMChannel).filter(IMChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    if not channel.is_enabled:
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
    success = await manager.restart_channel(channel)

    status_info = manager.get_status(channel_id)
    if status_info:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel.channel_type,
            is_enabled=channel.is_enabled,
            is_connected=status_info.get("is_connected", False),
            last_error=status_info.get("last_error"),
            uptime_seconds=status_info.get("uptime_seconds"),
            extra_info=status_info.get("extra_info"),
        )
    else:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel.channel_type,
            is_enabled=channel.is_enabled,
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
    channel = db.query(IMChannel).filter(IMChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"IM channel with id {channel_id} not found",
        )

    manager = get_channel_manager()
    status_info = manager.get_status(channel_id)

    if status_info:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel.channel_type,
            is_enabled=channel.is_enabled,
            is_connected=status_info.get("is_connected", False),
            last_error=status_info.get("last_error"),
            uptime_seconds=status_info.get("uptime_seconds"),
            extra_info=status_info.get("extra_info"),
        )
    else:
        return IMChannelStatus(
            id=channel.id,
            name=channel.name,
            channel_type=channel.channel_type,
            is_enabled=channel.is_enabled,
            is_connected=False,
            last_error="Channel not running",
        )
