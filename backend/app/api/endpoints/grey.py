# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Grey (Beta) test management API endpoints.
Allows users to self-manage their beta testing status.
"""

import logging
from typing import AsyncGenerator, List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from redis.asyncio import Redis

from app.core.config import settings
from app.core.security import get_current_user
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()

# Grey test configuration (hardcoded as per requirements)
GREY_CONFIG_NAME = "wegent-grey-uids"
GREY_TOKEN = "xxx"
GREY_API_URL = "https://nginx.com/admin/biz/grey-uids"


class GreyStatusResponse(BaseModel):
    """Response model for grey status check."""

    is_grey_user: bool


class GreyActionResponse(BaseModel):
    """Response model for grey join/leave actions."""

    success: bool
    is_grey_user: bool


async def get_redis() -> AsyncGenerator[Redis, None]:
    """Get async Redis client for grey operations."""
    client = Redis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_timeout=5.0,
        socket_connect_timeout=2.0,
    )
    try:
        yield client
    finally:
        await client.aclose()


def get_grey_redis_key() -> str:
    """Get the Redis key for grey user set."""
    return f"grey:{GREY_CONFIG_NAME}"


async def call_grey_api(uids: List[int]) -> bool:
    """
    Call external grey API to update the UID list.

    Args:
        uids: List of user IDs to set as grey users

    Returns:
        True if successful, raises exception otherwise
    """
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{GREY_API_URL}?config_name={GREY_CONFIG_NAME}&token={GREY_TOKEN}",
                json={"uids": uids},
                headers={"Content-Type": "application/json"},
            )

            if response.status_code != 200:
                logger.error(
                    f"Grey API returned non-200 status: {response.status_code}, body: {response.text}"
                )
                raise HTTPException(
                    status_code=500, detail="Failed to call grey API: non-200 status"
                )

            result = response.json()
            if result.get("code") != 0:
                logger.error(f"Grey API returned error code: {result}")
                raise HTTPException(
                    status_code=500,
                    detail=f"Grey API error: {result.get('message', 'Unknown error')}",
                )

            return True
    except httpx.RequestError as e:
        logger.error(f"Grey API request failed: {e}")
        raise HTTPException(
            status_code=500, detail="Failed to connect to grey API"
        ) from e


@router.get("/status", response_model=GreyStatusResponse)
async def get_grey_status(
    current_user: User = Depends(get_current_user),
    redis: Redis = Depends(get_redis),
) -> GreyStatusResponse:
    """
    Check if the current user is a grey (beta) test user.

    Returns:
        GreyStatusResponse with is_grey_user boolean
    """
    redis_key = get_grey_redis_key()
    is_member = await redis.sismember(redis_key, str(current_user.id))

    return GreyStatusResponse(is_grey_user=bool(is_member))


@router.post("/join", response_model=GreyActionResponse)
async def join_grey(
    current_user: User = Depends(get_current_user),
    redis: Redis = Depends(get_redis),
) -> GreyActionResponse:
    """
    Join the grey (beta) test program.

    This will:
    1. Add the user to the Redis set
    2. Get all UIDs from the set
    3. Call external API to replace the entire list

    Returns:
        GreyActionResponse indicating success and new status
    """
    redis_key = get_grey_redis_key()

    # Add user to Redis set
    await redis.sadd(redis_key, str(current_user.id))

    # Get all UIDs from the set
    uid_strings = await redis.smembers(redis_key)
    uids = [int(uid) for uid in uid_strings]

    # Call external API to update the list
    await call_grey_api(uids)

    logger.info(f"User {current_user.id} ({current_user.user_name}) joined grey test")

    return GreyActionResponse(success=True, is_grey_user=True)


@router.post("/leave", response_model=GreyActionResponse)
async def leave_grey(
    current_user: User = Depends(get_current_user),
    redis: Redis = Depends(get_redis),
) -> GreyActionResponse:
    """
    Leave the grey (beta) test program.

    This will:
    1. Remove the user from the Redis set
    2. Get all remaining UIDs from the set
    3. Call external API to replace the entire list

    Returns:
        GreyActionResponse indicating success and new status
    """
    redis_key = get_grey_redis_key()

    # Remove user from Redis set
    await redis.srem(redis_key, str(current_user.id))

    # Get all remaining UIDs from the set
    uid_strings = await redis.smembers(redis_key)
    uids = [int(uid) for uid in uid_strings]

    # Call external API to update the list
    await call_grey_api(uids)

    logger.info(f"User {current_user.id} ({current_user.user_name}) left grey test")

    return GreyActionResponse(success=True, is_grey_user=False)
