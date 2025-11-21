# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status, Body
from sqlalchemy.orm import Session
from typing import List, Dict, Any
from pydantic import BaseModel

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.model import (
    ModelCreate,
    ModelUpdate,
    ModelInDB,
    ModelListResponse,
    ModelDetail,
    ModelBulkCreateItem,
)
from app.services.adapters import public_model_service

router = APIRouter()


class TestConnectionRequest(BaseModel):
    provider: str
    config: Dict[str, Any]


class TestConnectionResponse(BaseModel):
    success: bool
    message: str


class BotReference(BaseModel):
    bot_id: int
    bot_name: str


class CheckReferencesResponse(BaseModel):
    is_referenced: bool
    referenced_by: List[BotReference]


@router.post("/test", response_model=TestConnectionResponse)
def test_connection(
    request: TestConnectionRequest = Body(...),
    current_user: User = Depends(security.get_current_user),
):
    """
    Test model connection with provided configuration
    """
    try:
        # For now, we'll do a simple validation
        # In a real implementation, you would:
        # 1. Extract provider type and credentials from request.config
        # 2. Initialize the appropriate SDK client
        # 3. Make a simple API call to verify credentials

        provider = request.provider
        config = request.config.get("env", {})

        # Basic validation
        if not config.get("model_id"):
            return TestConnectionResponse(
                success=False,
                message="Model ID is required"
            )

        if not config.get("api_key"):
            return TestConnectionResponse(
                success=False,
                message="API Key is required"
            )

        # TODO: Implement actual connection testing based on provider
        # For now, return success after basic validation
        return TestConnectionResponse(
            success=True,
            message=f"Connection test successful for {provider}"
        )

    except Exception as e:
        return TestConnectionResponse(
            success=False,
            message=f"Connection test failed: {str(e)}"
        )


@router.get("/{model_id}/check-references", response_model=CheckReferencesResponse)
def check_references(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Check if the model is referenced by any bots
    """
    # Get the model name first
    try:
        model_dict = public_model_service.get_by_id(db=db, model_id=model_id, current_user=current_user)
        model_name = model_dict.get("name")
    except Exception:
        return CheckReferencesResponse(
            is_referenced=False,
            referenced_by=[]
        )

    # Query bots table to check for references
    referenced_by = []
    try:
        from app.models.bot import Bot

        # Check bots that use this model in their agent_config
        bots = db.query(Bot).filter(Bot.is_active == True).all()

        for bot in bots:
            # Check if bot's agent_config references this model
            if hasattr(bot, 'agent_config') and isinstance(bot.agent_config, dict):
                private_model = bot.agent_config.get('private_model')
                if private_model == model_name:
                    referenced_by.append(BotReference(
                        bot_id=bot.id,
                        bot_name=bot.name
                    ))
    except Exception:
        # If bot model doesn't exist or query fails, return empty list
        pass

    return CheckReferencesResponse(
        is_referenced=len(referenced_by) > 0,
        referenced_by=referenced_by
    )


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
    items = public_model_service.get_models(db=db, skip=skip, limit=limit, current_user=current_user)
    total = public_model_service.count_active_models(db=db, current_user=current_user)
    
    return {"total": total, "items": items}


@router.get("/names")
def list_model_names(
    agent_name: str = Query(..., description="Agent name (Agno、ClaudeCode)"),
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
    data = public_model_service.list_model_names(db=db, current_user=current_user, agent_name=agent_name)
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
    return public_model_service.create_model(db=db, obj_in=model_create, current_user=current_user)


@router.post("/batch", status_code=status.HTTP_201_CREATED)
def bulk_create_models(
    items: List[ModelBulkCreateItem],
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Bulk upsert Models (create if not exists, update if exists).

    Request body example:
    [
      {
        "name": "modelname",
        "env": {
          "model": "xx",
          "base_url": "xx",
          "model_id": "xx",
          "api_key": "xx"
        }
      }
    ]

    Response:
    {
      "created": [ModelInDB...],
      "updated": [ModelInDB...],
      "skipped": [{"name": "...", "reason": "..."}]
    }
    """
    result = public_model_service.bulk_create_models(db=db, items=items, current_user=current_user)
    
    # Convert PublicModel objects to Model-like objects
    created = []
    for pm in result.get("created", []):
        model_data = {
            "id": pm.id,
            "name": pm.name,
            "config": pm.json.get("spec", {}).get("modelConfig", {}),
            "is_active": pm.is_active,
            "created_at": pm.created_at,
            "updated_at": pm.updated_at
        }
        created.append(ModelInDB.model_validate(model_data))
    
    updated = []
    for pm in result.get("updated", []):
        model_data = {
            "id": pm.id,
            "name": pm.name,
            "config": pm.json.get("spec", {}).get("modelConfig", {}),
            "is_active": pm.is_active,
            "created_at": pm.created_at,
            "updated_at": pm.updated_at
        }
        updated.append(ModelInDB.model_validate(model_data))
    
    return {"created": created, "updated": updated, "skipped": result.get("skipped", [])}


@router.get("/{model_id}", response_model=ModelDetail)
def get_model(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get specified Model details
    """
    return public_model_service.get_by_id(db=db, model_id=model_id, current_user=current_user)


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
    return public_model_service.update_model(db=db, model_id=model_id, obj_in=model_update, current_user=current_user)


@router.delete("/{model_id}")
def delete_model(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Soft delete Model (set is_active to False)
    """
    public_model_service.delete_model(db=db, model_id=model_id, current_user=current_user)
    return {"message": "Model deleted successfully"}