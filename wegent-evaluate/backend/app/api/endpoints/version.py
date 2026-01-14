"""
Version API endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.version import (
    DataVersionCreateRequest,
    DataVersionListResponse,
    DataVersionResponse,
)
from app.services.version_service import VersionService

router = APIRouter()


@router.get("", response_model=DataVersionListResponse)
async def get_versions(
    db: AsyncSession = Depends(get_db),
):
    """Get all data versions ordered by id desc."""
    service = VersionService(db)
    versions, total = await service.get_versions()

    return DataVersionListResponse(
        items=[
            DataVersionResponse(
                id=v.id,
                name=v.name,
                description=v.description,
                created_at=v.created_at,
                last_sync_time=v.last_sync_time,
                sync_count=v.sync_count,
            )
            for v in versions
        ],
        total=total,
    )


@router.get("/latest", response_model=DataVersionResponse)
async def get_latest_version(
    db: AsyncSession = Depends(get_db),
):
    """Get the latest (newest) data version."""
    service = VersionService(db)
    version = await service.get_latest_version()

    if not version:
        raise HTTPException(status_code=404, detail="No versions found")

    return DataVersionResponse(
        id=version.id,
        name=version.name,
        description=version.description,
        created_at=version.created_at,
        last_sync_time=version.last_sync_time,
        sync_count=version.sync_count,
    )


@router.get("/{version_id}", response_model=DataVersionResponse)
async def get_version(
    version_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get a single data version by ID."""
    service = VersionService(db)
    version = await service.get_version(version_id)

    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    return DataVersionResponse(
        id=version.id,
        name=version.name,
        description=version.description,
        created_at=version.created_at,
        last_sync_time=version.last_sync_time,
        sync_count=version.sync_count,
    )


@router.post("", response_model=DataVersionResponse)
async def create_version(
    request: DataVersionCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create a new data version (internal use only)."""
    service = VersionService(db)
    version = await service.create_version(description=request.description)

    return DataVersionResponse(
        id=version.id,
        name=version.name,
        description=version.description,
        created_at=version.created_at,
        last_sync_time=version.last_sync_time,
        sync_count=version.sync_count,
    )
