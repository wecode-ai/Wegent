# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin API key management endpoints (service keys and personal keys)."""

import hashlib
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE, APIKey
from app.models.user import User
from app.schemas.api_key import (
    AdminPersonalKeyListResponse,
    AdminPersonalKeyResponse,
    ServiceKeyCreate,
    ServiceKeyCreatedResponse,
    ServiceKeyListResponse,
    ServiceKeyResponse,
)

router = APIRouter()


# ==================== Service Key Management Endpoints ====================


@router.get("/service-keys", response_model=ServiceKeyListResponse)
async def list_service_keys(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all service keys (admin only), including disabled ones.

    Service keys are used for trusted service authentication.
    """
    # Query service keys with creator information
    results = (
        db.query(APIKey, User)
        .outerjoin(User, APIKey.user_id == User.id)
        .filter(
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .order_by(APIKey.created_at.desc())
        .all()
    )

    items = []
    for api_key, creator in results:
        items.append(
            ServiceKeyResponse(
                id=api_key.id,
                name=api_key.name,
                key_prefix=api_key.key_prefix,
                description=api_key.description,
                expires_at=api_key.expires_at,
                last_used_at=api_key.last_used_at,
                created_at=api_key.created_at,
                is_active=api_key.is_active,
                created_by=creator.user_name if creator else None,
            )
        )

    return ServiceKeyListResponse(items=items, total=len(items))


@router.post(
    "/service-keys",
    response_model=ServiceKeyCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_service_key(
    service_key_create: ServiceKeyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new service key (admin only).

    The full key is only returned once at creation time.
    Store it securely as it cannot be retrieved again.

    Service keys are used for trusted service authentication
    via the wegent-source header.
    """
    # Generate key: wg-{32 random chars}
    random_part = secrets.token_urlsafe(32)
    full_key = f"wg-{random_part}"

    # Hash the key for storage
    key_hash = hashlib.sha256(full_key.encode()).hexdigest()

    # Create prefix for display (first 8 chars after "wg-")
    key_prefix = f"wg-{random_part[:8]}..."

    # Create the service key record (user_id records the creator admin)
    service_key = APIKey(
        user_id=current_user.id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        name=service_key_create.name,
        key_type=KEY_TYPE_SERVICE,
        description=service_key_create.description or "",
    )

    db.add(service_key)
    db.commit()
    db.refresh(service_key)

    # Return with full key (only shown once)
    return ServiceKeyCreatedResponse(
        id=service_key.id,
        name=service_key.name,
        key_prefix=service_key.key_prefix,
        description=service_key.description,
        key=full_key,
        expires_at=service_key.expires_at,
        last_used_at=service_key.last_used_at,
        created_at=service_key.created_at,
        is_active=service_key.is_active,
        created_by=current_user.user_name,
    )


@router.post("/service-keys/{key_id}/toggle-status", response_model=ServiceKeyResponse)
async def toggle_service_key_status(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle a service key's active status (admin only).

    Enable or disable a service key without deleting it.
    """
    result = (
        db.query(APIKey, User)
        .outerjoin(User, APIKey.user_id == User.id)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .first()
    )

    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Service key not found",
        )

    service_key, creator = result

    # Toggle is_active status
    service_key.is_active = not service_key.is_active
    db.commit()
    db.refresh(service_key)

    return ServiceKeyResponse(
        id=service_key.id,
        name=service_key.name,
        key_prefix=service_key.key_prefix,
        description=service_key.description,
        expires_at=service_key.expires_at,
        last_used_at=service_key.last_used_at,
        created_at=service_key.created_at,
        is_active=service_key.is_active,
        created_by=creator.user_name if creator else None,
    )


@router.delete("/service-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a service key (admin only).

    This is a hard delete - the key will be permanently removed.
    """
    service_key = (
        db.query(APIKey)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .first()
    )

    if not service_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Service key not found",
        )

    # Hard delete - permanently remove the record
    db.delete(service_key)
    db.commit()

    return None


# ==================== Personal Key Management Endpoints (Admin) ====================


@router.get("/personal-keys", response_model=AdminPersonalKeyListResponse)
async def list_all_personal_keys(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    search: Optional[str] = Query(None, description="Search by username or key name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all personal keys with their owners (admin only).

    Personal keys are user-created API keys for programmatic access.
    """
    query = (
        db.query(APIKey, User)
        .join(User, APIKey.user_id == User.id)
        .filter(APIKey.key_type == KEY_TYPE_PERSONAL)
    )

    # Apply search filter
    if search:
        search_pattern = f"%{search}%"
        query = query.filter(
            (User.user_name.ilike(search_pattern)) | (APIKey.name.ilike(search_pattern))
        )

    total = query.count()
    results = (
        query.order_by(APIKey.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    items = []
    for api_key, user in results:
        items.append(
            AdminPersonalKeyResponse(
                id=api_key.id,
                user_id=api_key.user_id,
                user_name=user.user_name,
                name=api_key.name,
                key_prefix=api_key.key_prefix,
                description=api_key.description,
                expires_at=api_key.expires_at,
                last_used_at=api_key.last_used_at,
                created_at=api_key.created_at,
                is_active=api_key.is_active,
            )
        )

    return AdminPersonalKeyListResponse(items=items, total=total)


@router.post(
    "/personal-keys/{key_id}/toggle-status", response_model=AdminPersonalKeyResponse
)
async def toggle_personal_key_status(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle a personal key's active status (admin only).

    Enable or disable a personal key without deleting it.
    """
    result = (
        db.query(APIKey, User)
        .join(User, APIKey.user_id == User.id)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
        )
        .first()
    )

    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Personal key not found",
        )

    api_key, user = result

    # Toggle is_active status
    api_key.is_active = not api_key.is_active
    db.commit()
    db.refresh(api_key)

    return AdminPersonalKeyResponse(
        id=api_key.id,
        user_id=api_key.user_id,
        user_name=user.user_name,
        name=api_key.name,
        key_prefix=api_key.key_prefix,
        description=api_key.description,
        expires_at=api_key.expires_at,
        last_used_at=api_key.last_used_at,
        created_at=api_key.created_at,
        is_active=api_key.is_active,
    )


@router.delete("/personal-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_personal_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a personal key (admin only).

    This is a hard delete - the key will be permanently removed.
    """
    api_key = (
        db.query(APIKey)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
        )
        .first()
    )

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Personal key not found",
        )

    # Hard delete - permanently remove the record
    db.delete(api_key)
    db.commit()

    return None
