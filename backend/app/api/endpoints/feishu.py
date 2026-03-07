# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu webhook endpoint."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request, status

from app.services.channels import get_channel_manager

router = APIRouter()


@router.post("/events/{channel_id}")
async def handle_feishu_event(channel_id: int, request: Request) -> Dict[str, Any]:
    """Handle Feishu event subscription callbacks for a running channel."""
    body = await request.json()

    channel_manager = get_channel_manager()
    provider = channel_manager.get_channel(channel_id)

    if not provider or provider.channel_type != "feishu":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Feishu channel {channel_id} not found or not running",
        )

    if not hasattr(provider, "handle_event"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Feishu channel provider",
        )

    result = await provider.handle_event(body)
    return result
