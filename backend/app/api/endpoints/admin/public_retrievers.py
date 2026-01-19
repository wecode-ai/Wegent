# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public retriever management endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.admin import (
    PublicRetrieverListResponse,
    PublicRetrieverResponse,
)
from app.schemas.kind import Retriever
from app.services.adapters.public_retriever import public_retriever_service

router = APIRouter()


def _retriever_to_response(r: dict) -> PublicRetrieverResponse:
    """Convert retriever dict to PublicRetrieverResponse."""
    return PublicRetrieverResponse(
        id=r["id"],
        name=r["name"],
        namespace=r["namespace"],
        displayName=r["displayName"],
        storageType=r["storageType"],
        description=r["description"],
        json=r["json"],
        is_active=r["is_active"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


@router.get("/public-retrievers", response_model=PublicRetrieverListResponse)
async def list_public_retrievers(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public retrievers with pagination
    """
    total = public_retriever_service.count_active_retrievers(
        db, current_user=current_user
    )
    skip = (page - 1) * limit
    retrievers = public_retriever_service.get_retrievers(
        db, skip=skip, limit=limit, current_user=current_user
    )

    return PublicRetrieverListResponse(
        total=total,
        items=[_retriever_to_response(r) for r in retrievers],
    )


@router.post(
    "/public-retrievers",
    response_model=PublicRetrieverResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_retriever(
    retriever_data: Retriever,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public retriever (admin only)
    """
    result = public_retriever_service.create_retriever(
        db, retriever=retriever_data, current_user=current_user
    )
    return _retriever_to_response(result)


@router.put("/public-retrievers/{retriever_id}", response_model=PublicRetrieverResponse)
async def update_public_retriever(
    retriever_data: Retriever,
    retriever_id: int = Path(..., description="Retriever ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public retriever (admin only)
    """
    result = public_retriever_service.update_retriever(
        db,
        retriever_id=retriever_id,
        retriever=retriever_data,
        current_user=current_user,
    )
    return _retriever_to_response(result)


@router.delete(
    "/public-retrievers/{retriever_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_public_retriever(
    retriever_id: int = Path(..., description="Retriever ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public retriever (admin only)
    """
    public_retriever_service.delete_retriever(
        db, retriever_id=retriever_id, current_user=current_user
    )
    return None
