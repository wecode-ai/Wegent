# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from app.schemas.model import (
    ModelBulkCreateItem,
    ModelCreate,
    ModelDetail,
    ModelInDB,
    ModelListResponse,
    ModelUpdate,
)
from app.services.adapters import public_model_service
from app.services.model_aggregation_service import ModelType, model_aggregation_service

router = APIRouter()
logger = logging.getLogger(__name__)


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
    items = public_model_service.get_models(
        db=db, skip=skip, limit=limit, current_user=current_user
    )
    total = public_model_service.count_active_models(db=db, current_user=current_user)

    return {"total": total, "items": items}


@router.get("/names")
def list_model_names(
    shell_type: str = Query(..., description="Shell type (Agno, ClaudeCode)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all active model names (legacy API, use /unified for new implementations)

    Response:
    {
      "data": [
        {"name": "string", "displayName": "string"}
      ]
    }
    """
    data = public_model_service.list_model_names(
        db=db, current_user=current_user, shell_type=shell_type
    )
    return {"data": data}


@router.get("/unified")
def list_unified_models(
    shell_type: Optional[str] = Query(
        None, description="Shell type to filter compatible models (Agno, ClaudeCode)"
    ),
    include_config: bool = Query(
        False, description="Whether to include full config in response"
    ),
    scope: str = Query(
        "personal",
        description="Query scope: 'personal' (default), 'group', or 'all'",
    ),
    group_name: Optional[str] = Query(
        None, description="Group name (required when scope='group')"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get unified list of all available models (both public and user-defined) with scope support.

    This endpoint aggregates models from:
    - Public models (type='public'): Shared across all users
    - User-defined models (type='user'): Private to the current user or group

    Scope behavior:
    - scope='personal' (default): personal models + public models
    - scope='group': group models + public models (requires group_name)
    - scope='all': personal + public + all user's groups

    Each model includes a 'type' field to identify its source, which is
    important for avoiding naming conflicts when binding models.

    Parameters:
    - shell_type: Optional shell type to filter compatible models
    - include_config: Whether to include full model config in response
    - scope: Query scope ('personal', 'group', or 'all')
    - group_name: Group name (required when scope='group')

    Response:
    {
      "data": [
        {
          "name": "model-name",
          "type": "public" | "user",
          "displayName": "Human Readable Name",
          "provider": "openai" | "claude",
          "modelId": "gpt-4"
        }
      ]
    }
    """
    data = model_aggregation_service.list_available_models(
        db=db,
        current_user=current_user,
        shell_type=shell_type,
        include_config=include_config,
        scope=scope,
        group_name=group_name,
    )
    return {"data": data}


@router.get("/unified/{model_name}")
def get_unified_model(
    model_name: str,
    model_type: Optional[str] = Query(
        None, description="Model type ('public' or 'user')"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific model by name, optionally with type hint.

    If model_type is not provided, it will try to find the model
    in the following order:
    1. User's own models (type='user')
    2. Public models (type='public')

    Parameters:
    - model_name: Model name
    - model_type: Optional model type hint ('public' or 'user')

    Response:
    {
      "name": "model-name",
      "type": "public" | "user",
      "displayName": "Human Readable Name",
      "provider": "openai" | "claude",
      "modelId": "gpt-4",
      "config": {...},
      "isActive": true
    }
    """
    from fastapi import HTTPException

    result = model_aggregation_service.resolve_model(
        db=db, current_user=current_user, name=model_name, model_type=model_type
    )

    if not result:
        raise HTTPException(status_code=404, detail="Model not found")

    return result


@router.post("", response_model=ModelInDB, status_code=status.HTTP_201_CREATED)
def create_model(
    model_create: ModelCreate,
    group_name: Optional[str] = Query(None, description="Group name (namespace)"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create new Model.

    If group_name is provided, creates the model in that group's namespace.
    User must have Developer+ permission in the group.
    Otherwise, creates a personal model in 'default' namespace.
    """
    return public_model_service.create_model(
        db=db, obj_in=model_create, current_user=current_user
    )


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
    result = public_model_service.bulk_create_models(
        db=db, items=items, current_user=current_user
    )

    # Convert PublicModel objects to Model-like objects
    created = []
    for pm in result.get("created", []):
        model_data = {
            "id": pm.id,
            "name": pm.name,
            "config": pm.json.get("spec", {}).get("modelConfig", {}),
            "is_active": pm.is_active,
            "created_at": pm.created_at,
            "updated_at": pm.updated_at,
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
            "updated_at": pm.updated_at,
        }
        updated.append(ModelInDB.model_validate(model_data))

    return {
        "created": created,
        "updated": updated,
        "skipped": result.get("skipped", []),
    }


@router.get("/{model_id}", response_model=ModelDetail)
def get_model(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get specified Model details
    """
    return public_model_service.get_by_id(
        db=db, model_id=model_id, current_user=current_user
    )


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
    return public_model_service.update_model(
        db=db, model_id=model_id, obj_in=model_update, current_user=current_user
    )


@router.delete("/{model_id}")
def delete_model(
    model_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Soft delete Model (set is_active to False)
    """
    public_model_service.delete_model(
        db=db, model_id=model_id, current_user=current_user
    )
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
      "message": "Connection successful" | "Error message"
    }
    """
    provider_type = test_data.get("provider_type")
    model_id = test_data.get("model_id")
    api_key = test_data.get("api_key")
    base_url = test_data.get("base_url")

    if not provider_type or not model_id or not api_key:
        return {
            "success": False,
            "message": "Missing required fields: provider_type, model_id, api_key",
        }

    try:
        if provider_type == "openai":
            import openai

            client = openai.OpenAI(
                api_key=api_key, base_url=base_url or "https://api.openai.com/v1"
            )
            # Send minimal test request
            response = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=1,
            )
            return {"success": True, "message": f"Successfully connected to {model_id}"}

        elif provider_type == "anthropic":
            import anthropic

            # Create client with base_url in constructor for proper initialization
            # This is required for compatible APIs like MiniMax
            client_kwargs = {"auth_token": api_key}
            if base_url:
                client_kwargs["base_url"] = base_url

            client = anthropic.Anthropic(**client_kwargs)

            response = client.messages.create(
                model=model_id,
                max_tokens=1,
                messages=[{"role": "user", "content": "hi"}],
            )
            return {"success": True, "message": f"Successfully connected to {model_id}"}

        elif provider_type == "gemini":
            import httpx

            # Gemini uses REST API with API key in header
            gemini_base_url = base_url or "https://generativelanguage.googleapis.com"
            gemini_base_url = gemini_base_url.rstrip("/")

            # Build URL for generateContent endpoint
            if "/v1beta" in gemini_base_url or "/v1" in gemini_base_url:
                url = f"{gemini_base_url}/models/{model_id}:generateContent"
            else:
                url = f"{gemini_base_url}/v1beta/models/{model_id}:generateContent"

            headers = {
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            }

            payload = {
                "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                "generationConfig": {"maxOutputTokens": 1},
            }

            with httpx.Client(timeout=30.0) as client:
                response = client.post(url, json=payload, headers=headers)
                response.raise_for_status()

            return {"success": True, "message": f"Successfully connected to {model_id}"}

        else:
            return {"success": False, "message": "Unsupported provider type"}

    except Exception as e:
        logger.error(f"Model connection test failed: {str(e)}")
        return {"success": False, "message": f"Connection failed: {str(e)}"}


@router.get("/compatible")
def get_compatible_models(
    shell_type: str = Query(..., description="Shell type (Agno or ClaudeCode)"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get models compatible with a specific shell type

    Parameters:
    - shell_type: "Agno" or "ClaudeCode"

    Response:
    {
      "models": [
        {"name": "my-gpt4-model"},
        {"name": "my-gpt4o-model"}
      ]
    }
    """
    from app.schemas.kind import Model as ModelCRD

    # Query all active Model CRDs from kinds table
    models = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Model",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .all()
    )

    compatible_models = []

    for model_kind in models:
        try:
            if not model_kind.json:
                continue
            model_crd = ModelCRD.model_validate(model_kind.json)
            model_config = model_crd.spec.modelConfig
            if isinstance(model_config, dict):
                env = model_config.get("env", {})
                model_type = env.get("model", "")

                # Filter compatible models
                # Agno supports OpenAI, Claude and Gemini models
                if shell_type == "Agno" and model_type in [
                    "openai",
                    "claude",
                    "gemini",
                ]:
                    compatible_models.append({"name": model_kind.name})
                elif shell_type == "ClaudeCode" and model_type == "claude":
                    compatible_models.append({"name": model_kind.name})
        except Exception as e:
            logger.warning(f"Failed to parse model {model_kind.name}: {e}")
            continue

    return {"models": compatible_models}
