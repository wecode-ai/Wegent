# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin public model management endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.admin import (
    PublicModelCreate,
    PublicModelListResponse,
    PublicModelResponse,
    PublicModelUpdate,
)

router = APIRouter()


def _get_display_name(model: Kind) -> str:
    """Extract displayName from model json, fallback to name."""
    if model.json and isinstance(model.json, dict):
        metadata = model.json.get("metadata", {})
        if isinstance(metadata, dict):
            display_name = metadata.get("displayName")
            if display_name:
                return display_name
    return model.name


def _model_to_response(model: Kind) -> PublicModelResponse:
    """Convert Kind model to PublicModelResponse."""
    display_name = _get_display_name(model)
    return PublicModelResponse(
        id=model.id,
        name=model.name,
        namespace=model.namespace,
        display_name=display_name if display_name != model.name else None,
        model_json=model.json,
        is_active=model.is_active,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


@router.get("/public-models", response_model=PublicModelListResponse)
async def list_public_models(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public models with pagination, sorted by displayName
    """
    query = db.query(Kind).filter(
        Kind.user_id == 0, Kind.kind == "Model", Kind.namespace == "default"
    )
    total = query.count()
    models = query.all()

    # Sort models by displayName (case-insensitive)
    sorted_models = sorted(models, key=lambda m: _get_display_name(m).lower())

    # Apply pagination after sorting
    start_idx = (page - 1) * limit
    end_idx = start_idx + limit
    paginated_models = sorted_models[start_idx:end_idx]

    return PublicModelListResponse(
        total=total,
        items=[_model_to_response(model) for model in paginated_models],
    )


@router.post(
    "/public-models",
    response_model=PublicModelResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_model(
    model_data: PublicModelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public model (admin only)
    """
    # Check if model with same name and namespace already exists
    existing_model = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.name == model_data.name,
            Kind.namespace == model_data.namespace,
        )
        .first()
    )
    if existing_model:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public model '{model_data.name}' already exists in namespace '{model_data.namespace}'",
        )

    new_model = Kind(
        user_id=0,
        kind="Model",
        name=model_data.name,
        namespace=model_data.namespace,
        json=model_data.model_json,
        is_active=True,
    )
    db.add(new_model)
    db.commit()
    db.refresh(new_model)

    return _model_to_response(new_model)


@router.put("/public-models/{model_id}", response_model=PublicModelResponse)
async def update_public_model(
    model_data: PublicModelUpdate,
    model_id: int = Path(..., description="Model ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public model (admin only)
    """
    model = (
        db.query(Kind)
        .filter(Kind.id == model_id, Kind.user_id == 0, Kind.kind == "Model")
        .first()
    )
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public model with id {model_id} not found",
        )

    # Check name uniqueness if being changed
    if model_data.name and model_data.name != model.name:
        namespace = model_data.namespace or model.namespace
        existing_model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_data.name,
                Kind.namespace == namespace,
            )
            .first()
        )
        if existing_model:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public model '{model_data.name}' already exists in namespace '{namespace}'",
            )

    # Update fields
    if model_data.name is not None:
        model.name = model_data.name
    if model_data.namespace is not None:
        model.namespace = model_data.namespace
    if model_data.model_json is not None:
        model.json = model_data.model_json
    if model_data.is_active is not None:
        model.is_active = model_data.is_active

    db.commit()
    db.refresh(model)

    return _model_to_response(model)


@router.delete("/public-models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_public_model(
    model_id: int = Path(..., description="Model ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public model (admin only).
    Deletion is blocked if any public bots (active or inactive) reference this model.
    """
    model = (
        db.query(Kind)
        .filter(Kind.id == model_id, Kind.user_id == 0, Kind.kind == "Model")
        .first()
    )
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public model with id {model_id} not found",
        )

    # Check if any public bots (active or inactive) reference this model
    bots_using_model = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Bot",
        )
        .all()
    )

    referencing_bots = []
    for bot in bots_using_model:
        # Defensive validation: ensure bot.json is a dict
        if not isinstance(bot.json, dict):
            continue
        spec = bot.json.get("spec", {})
        # Defensive validation: ensure spec is a dict
        if not isinstance(spec, dict):
            continue
        model_ref = spec.get("modelRef")
        # Defensive validation: ensure modelRef is a dict
        if not isinstance(model_ref, dict):
            continue
        if (
            model_ref.get("name") == model.name
            and model_ref.get("namespace", "default") == model.namespace
        ):
            referencing_bots.append(bot.name)

    if referencing_bots:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete model '{model.name}' because it is referenced by public bots: {', '.join(referencing_bots)}",
        )

    db.delete(model)
    db.commit()

    return None
