# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.model import (
    ModelCreate,
    ModelUpdate,
    ModelInDB,
    ModelListResponse,
    ModelDetail,
)
from app.services.model import model_service

router = APIRouter()


@router.get("", response_model=ModelListResponse)
def list_models(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get Model list (paginated, active only)
    """
    skip = (page - 1) * limit
    items = model_service.get_models(db=db, skip=skip, limit=limit, current_user=current_user)
    total = model_service.count_active_models(db=db, current_user=current_user)
    return {"total": total, "items": items}


@router.get("/names")
def list_model_names(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all active model names

    Response:
    {
      "data": [
        {"name": "string"}
      ]
    }
    """
    data = model_service.list_model_names(db=db, current_user=current_user)
    return {"data": data}


@router.post("", response_model=ModelInDB, status_code=status.HTTP_201_CREATED)
def create_model(
    model_create: ModelCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create new Model
    """
    return model_service.create_model(db=db, obj_in=model_create, current_user=current_user)


@router.get("/{model_id}", response_model=ModelDetail)
def get_model(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get specified Model details
    """
    model = model_service.get_by_id(db=db, model_id=model_id, current_user=current_user)
    # The detail schema matches the model fields directly
    return model


@router.put("/{model_id}", response_model=ModelInDB)
def update_model(
    model_id: int,
    model_update: ModelUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update Model information
    """
    return model_service.update_model(db=db, model_id=model_id, obj_in=model_update, current_user=current_user)


@router.delete("/{model_id}")
def delete_model(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Soft delete Model (set is_active to False)
    """
    model_service.delete_model(db=db, model_id=model_id, current_user=current_user)
    return {"message": "Model deleted successfully"}