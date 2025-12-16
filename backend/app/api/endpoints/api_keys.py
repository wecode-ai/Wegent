# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Keys management endpoints.
"""

import hashlib
import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.api_key import APIKey
from app.models.user import User
from app.schemas.api_key import (
    APIKeyCreate,
    APIKeyCreatedResponse,
    APIKeyListResponse,
    APIKeyResponse,
)

router = APIRouter()


@router.get("", response_model=APIKeyListResponse)
async def list_api_keys(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get all API keys for the current user."""
    keys = (
        db.query(APIKey)
        .filter(APIKey.user_id == current_user.id, APIKey.is_active == True)
        .order_by(APIKey.created_at.desc())
        .all()
    )
    return APIKeyListResponse(
        items=[APIKeyResponse.model_validate(key) for key in keys],
        total=len(keys),
    )


@router.post(
    "", response_model=APIKeyCreatedResponse, status_code=status.HTTP_201_CREATED
)
async def create_api_key(
    api_key_create: APIKeyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Create a new API key for the current user.

    The full key is only returned once at creation time.
    Store it securely as it cannot be retrieved again.
    """
    # Generate key: wg-{32 random chars}
    random_part = secrets.token_urlsafe(32)
    full_key = f"wg-{random_part}"

    # Hash the key for storage
    key_hash = hashlib.sha256(full_key.encode()).hexdigest()

    # Create prefix for display (first 8 chars after "wg-")
    key_prefix = f"wg-{random_part[:8]}..."

    # Create the API key record
    api_key = APIKey(
        user_id=current_user.id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        name=api_key_create.name,
    )

    db.add(api_key)
    db.commit()
    db.refresh(api_key)

    # Return with full key (only shown once)
    return APIKeyCreatedResponse(
        id=api_key.id,
        name=api_key.name,
        key_prefix=api_key.key_prefix,
        key=full_key,
        expires_at=api_key.expires_at,
        last_used_at=api_key.last_used_at,
        created_at=api_key.created_at,
        is_active=api_key.is_active,
    )


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_api_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Delete an API key (hard delete)."""
    api_key = (
        db.query(APIKey)
        .filter(
            APIKey.id == key_id,
            APIKey.user_id == current_user.id,
        )
        .first()
    )

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found",
        )

    # Hard delete - permanently remove the record
    db.delete(api_key)
    db.commit()

    return None
