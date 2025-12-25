# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Grey (Beta) test management API endpoints.
Allows users to self-manage their beta testing status.
"""

import logging
from typing import AsyncGenerator, List

import aiohttp
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
GREY_TOKEN = "X1b3Yz6gk3f2jTt3"
GREY_API_URL = "https://shanhai-dashboard.intra.weibo.cn/shanhai/admin/biz/grey-uids"


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
        timeout = aiohttp.ClientTimeout(total=30, connect=10)

        async with aiohttp.ClientSession(timeout=timeout) as session:
            url = f"{GREY_API_URL}?config_name={GREY_CONFIG_NAME}&token={GREY_TOKEN}"
            async with session.post(
                url,
                json={"uids": uids},
                headers={"Content-Type": "application/json"},
            ) as response:
                if response.status != 200:
                    body = await response.text()
                    logger.error(
                        f"Grey API returned non-200 status: {response.status}, body: {body}"
                    )
                    raise HTTPException(
                        status_code=500,
                        detail="Failed to call grey API: non-200 status",
                    )

                result = await response.json()
                if result.get("code") != 0:
                    logger.error(f"Grey API returned error code: {result}")
                    raise HTTPException(
                        status_code=500,
                        detail=f"Grey API error: {result.get('message', 'Unknown error')}",
                    )

                return True
    except aiohttp.ClientError as e:
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
    1. Get current UIDs from Redis and add the new user
    2. Call external API to update the list
    3. If API succeeds, persist the change to Redis

    Returns:
        GreyActionResponse indicating success and new status
    """
    redis_key = get_grey_redis_key()

    # Get current UIDs from Redis
    uid_strings = await redis.smembers(redis_key)
    uids = [int(uid) for uid in uid_strings]

    # Add current user to the list (if not already present)
    if current_user.id not in uids:
        uids.append(current_user.id)

    # Call external API first - if it fails, don't modify Redis
    await call_grey_api(uids)

    # API succeeded, now persist to Redis
    await redis.sadd(redis_key, str(current_user.id))

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
    1. Get current UIDs from Redis and remove the user
    2. Call external API to update the list
    3. If API succeeds, persist the change to Redis

    Returns:
        GreyActionResponse indicating success and new status
    """
    redis_key = get_grey_redis_key()

    # Get current UIDs from Redis
    uid_strings = await redis.smembers(redis_key)
    uids = [int(uid) for uid in uid_strings]

    # Remove current user from the list
    if current_user.id in uids:
        uids.remove(current_user.id)

    # Call external API first - if it fails, don't modify Redis
    await call_grey_api(uids)

    # API succeeded, now persist to Redis
    await redis.srem(redis_key, str(current_user.id))

    logger.info(f"User {current_user.id} ({current_user.user_name}) left grey test")

    return GreyActionResponse(success=True, is_grey_user=False)
