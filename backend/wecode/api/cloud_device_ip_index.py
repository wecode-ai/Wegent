# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal admin API for synchronizing the cloud-device Nevis IP index."""

from typing import AsyncGenerator

from fastapi import APIRouter, Depends
from redis.asyncio import Redis
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.models.user import User
from wecode.api.dependencies import get_admin_user_by_jwt_or_api_key
from wecode.schemas.cloud_device_ip_index import CloudDeviceIpSyncResponse
from wecode.service.cloud_device_ip_index import cloud_device_ip_index_service

router = APIRouter()


async def get_cloud_device_ip_index_redis() -> AsyncGenerator[Redis, None]:
    """Provide a bounded Redis client for distributed synchronization locks."""
    client = Redis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_timeout=5,
        socket_connect_timeout=5,
    )
    try:
        yield client
    finally:
        await client.aclose()


@router.post("/sync", response_model=CloudDeviceIpSyncResponse)
async def sync_missing_nevis_ips(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_admin_user_by_jwt_or_api_key),
    redis_client: Redis = Depends(get_cloud_device_ip_index_redis),
) -> CloudDeviceIpSyncResponse:
    """Synchronize missing or sandbox-mismatched Nevis IP index entries."""
    summary = await cloud_device_ip_index_service.sync_missing(
        db,
        redis_client,
    )
    return CloudDeviceIpSyncResponse(
        total=summary.total,
        persisted=summary.persisted,
        missing_ip=summary.missing_ip,
        failed=summary.failed,
        skipped=summary.skipped,
        skip_reason=summary.skip_reason,
    )
