"""
Sync API endpoints.
"""
import asyncio
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.sync import (
    SyncHistoryItem,
    SyncHistoryResponse,
    SyncStatusResponse,
    SyncTriggerRequest,
    SyncTriggerResponse,
)
from app.services.sync_service import SyncService

router = APIRouter()


@router.post("/trigger", response_model=SyncTriggerResponse)
async def trigger_sync(
    request: SyncTriggerRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Trigger a new data sync job."""
    service = SyncService(db)
    try:
        sync_id, version_id = await service.trigger_sync(
            start_time=request.start_time,
            end_time=request.end_time,
            user_id=request.user_id,
            version_mode=request.version_mode,
            version_id=request.version_id,
            write_mode=request.write_mode,
            version_description=request.version_description,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Execute sync in background
    background_tasks.add_task(_run_sync, sync_id)

    return SyncTriggerResponse(
        sync_id=sync_id,
        status="started",
        message="Sync job started",
        version_id=version_id,
    )


async def _run_sync(sync_id: str):
    """Background task to run sync."""
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        service = SyncService(db)
        await service.execute_sync(sync_id)


@router.get("/status/{sync_id}", response_model=SyncStatusResponse)
async def get_sync_status(
    sync_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get status of a sync job."""
    service = SyncService(db)
    sync_job = await service.get_sync_status(sync_id)

    if not sync_job:
        raise HTTPException(status_code=404, detail="Sync job not found")

    return SyncStatusResponse(
        sync_id=sync_job.sync_id,
        status=sync_job.status.value,
        total_fetched=sync_job.total_fetched,
        total_inserted=sync_job.total_inserted,
        total_skipped=sync_job.total_skipped,
        error_message=sync_job.error_message,
        version_id=sync_job.version_id,
    )


@router.get("/history", response_model=SyncHistoryResponse)
async def get_sync_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Get sync job history."""
    service = SyncService(db)
    items, total = await service.get_sync_history(page=page, page_size=page_size)

    total_pages = (total + page_size - 1) // page_size

    return SyncHistoryResponse(
        items=[
            SyncHistoryItem(
                sync_id=item.sync_id,
                start_time=item.start_time,
                end_time=item.end_time,
                user_id=item.user_id,
                version_id=item.version_id,
                status=item.status.value,
                total_fetched=item.total_fetched,
                total_inserted=item.total_inserted,
                total_skipped=item.total_skipped,
                error_message=item.error_message,
                created_at=item.created_at,
                updated_at=item.updated_at,
            )
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )
