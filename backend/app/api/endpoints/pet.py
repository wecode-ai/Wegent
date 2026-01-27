# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet API endpoints for user pet nurturing feature."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.pet import PetResponse, PetUpdate
from app.services.pet import pet_service
from shared.telemetry.decorators import trace_async

router = APIRouter()


@trace_async()
@router.get("", response_model=PetResponse)
async def get_current_user_pet(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's pet.
    If no pet exists, a new one will be created automatically.
    """
    pet = pet_service.get_or_create_pet(db, current_user.id)
    return pet_service.to_response(pet)


@trace_async()
@router.put("", response_model=PetResponse)
async def update_current_user_pet(
    pet_update: PetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update current user's pet settings.
    Can update pet name and visibility.
    """
    pet = pet_service.update_pet(db, current_user.id, pet_update)
    if pet is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pet not found",
        )
    return pet_service.to_response(pet)


@trace_async()
@router.post("/reset", response_model=PetResponse)
async def reset_current_user_pet(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Reset current user's pet.
    This will reset all stats and generate a new appearance seed.
    Visibility preference is preserved.
    """
    pet = pet_service.reset_pet(db, current_user.id)
    return pet_service.to_response(pet)
