# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session
from typing import List

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


@router.post("/test-connection")
def test_model_connection(
    test_data: dict,
    current_user: User = Depends(security.get_current_user),
):
    """
    Test model connection

    Request body:
    {
      "provider_type": "openai" | "anthropic",
      "model_id": "gpt-4",
      "api_key": "sk-...",
      "base_url": "https://api.openai.com/v1"  // optional
    }

    Response:
    {
      "success": true | false,
      "message": "连接成功" | "错误信息"
    }
    """
    import logging
    logger = logging.getLogger(__name__)

    provider_type = test_data.get("provider_type")
    model_id = test_data.get("model_id")
    api_key = test_data.get("api_key")
    base_url = test_data.get("base_url")

    try:
        if provider_type == "openai":
            import openai
            client = openai.OpenAI(
                api_key=api_key,
                base_url=base_url or "https://api.openai.com/v1"
            )
            # Send minimal test request
            response = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=1
            )
            return {
                "success": True,
                "message": f"成功连接到 {model_id}"
            }

        elif provider_type == "anthropic":
            import anthropic
            client = anthropic.Anthropic(api_key=api_key)
            if base_url:
                client.base_url = base_url

            response = client.messages.create(
                model=model_id,
                max_tokens=1,
                messages=[{"role": "user", "content": "hi"}]
            )
            return {
                "success": True,
                "message": f"成功连接到 {model_id}"
            }

        else:
            return {
                "success": False,
                "message": "不支持的提供商类型"
            }

    except Exception as e:
        logger.error(f"Model connection test failed: {str(e)}")
        return {
            "success": False,
            "message": f"连接失败: {str(e)}"
        }


@router.get("/compatible")
def get_compatible_models(
    agent_name: str = Query(..., description="Agent name (Agno or ClaudeCode)"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get list of models compatible with specified agent

    Parameters:
    - agent_name: "Agno" or "ClaudeCode"

    Response:
    {
      "models": [
        {"name": "my-gpt4-model"},
        {"name": "my-gpt4o-model"}
      ]
    }
    """
    import logging
    from app.models.kind import Kind
    from app.schemas.kind import Model as ModelCRD

    logger = logging.getLogger(__name__)

    # Query all active Model CRDs
    models = db.query(Kind).filter(
        Kind.user_id == current_user.id,
        Kind.kind == "Model",
        Kind.namespace == "default",
        Kind.is_active == True
    ).all()

    compatible_models = []

    for model_kind in models:
        try:
            model_crd = ModelCRD.model_validate(model_kind.json)
            env = model_crd.spec.modelConfig.get("env", {})
            model_type = env.get("model", "")

            # Filter compatible models
            if agent_name == "Agno" and model_type == "openai":
                compatible_models.append({"name": model_kind.name})
            elif agent_name == "ClaudeCode" and model_type == "claude":
                compatible_models.append({"name": model_kind.name})
        except Exception as e:
            logger.warning(f"Failed to parse model {model_kind.name}: {e}")
            continue

    return {"models": compatible_models}