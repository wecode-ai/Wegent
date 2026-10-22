# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, status
from fastapi.concurrency import run_in_threadpool
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
from app.services import model_credential_service
from app.services.adapters import public_model_service
from app.services.model_aggregation_service import model_aggregation_service
from app.services.model_connection_service import _test_llm_connection

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


@router.get("/unified/{model_name}")
def get_unified_model(
    model_name: str,
    model_type: Optional[str] = Query(
        None, description="Model type ('public', 'user', 'group', or 'runtime')"
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
    - model_type: Optional model type hint ('public', 'user', 'group', or 'runtime')

    Response:
    {
      "name": "model-name",
      "type": "public" | "user" | "group" | "runtime",
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


@router.get("/compatible")
def get_compatible_models(
    shell_type: str = Query(..., description="Shell type (Agno, Codex, or ClaudeCode)"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get models compatible with a specific shell type

    Parameters:
    - shell_type: "Agno", "Codex", or "ClaudeCode"

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
            Kind.is_active.is_(True),
        )
        .all()
    )

    compatible_models = []

    for model_kind in models:
        try:
            if not model_kind.json:
                continue
            model_crd = ModelCRD.model_validate(model_kind.json)
            if model_crd.spec.modelType != "llm":
                continue
            model_config = model_crd.spec.modelConfig
            if isinstance(model_config, dict):
                env = model_config.get("env", {})
                model_type = env.get("model", "")
                api_format = getattr(model_crd.spec.apiFormat, "value", None)
                protocol = model_crd.spec.protocol
                is_codex_compatible = (
                    api_format == "responses"
                    or protocol == "openai-responses"
                    or model_config.get("wire_api") == "responses"
                )

                # Filter compatible models
                # Agno supports OpenAI, Claude and Gemini models
                if shell_type == "Agno" and model_type in [
                    "openai",
                    "claude",
                    "gemini",
                ]:
                    compatible_models.append({"name": model_kind.name})
                elif (
                    shell_type == "Codex"
                    and model_type == "openai"
                    and is_codex_compatible
                ):
                    compatible_models.append({"name": model_kind.name})
                elif shell_type == "ClaudeCode" and (
                    model_type == "claude"
                    or (model_type == "openai" and is_codex_compatible)
                ):
                    compatible_models.append({"name": model_kind.name})
        except Exception as e:
            logger.warning(f"Failed to parse model {model_kind.name}: {e}")
            continue

    return {"models": compatible_models}


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
async def test_model_connection(
    test_data: dict,
    current_user: User = Depends(security.get_current_user),
):
    """
    Test model connection

    Request body:
    {
      "provider_type": "openai" | "anthropic" | "gemini",
      "model_id": "gpt-4",
      "api_key": "sk-...",
      "base_url": "https://api.openai.com/v1",  // optional
      "custom_headers": {"header-name": "header-value"},  // optional, custom HTTP headers
      "model_category_type": "llm" | "embedding" | "tts" | "stt" | "rerank"  // optional, defaults to "llm"
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
    custom_headers = test_data.get("custom_headers", {})
    model_category_type = test_data.get("model_category_type", "llm")

    if not provider_type or not model_id or not api_key:
        return {
            "success": False,
            "message": "Missing required fields: provider_type, model_id, api_key",
        }

    # Ensure custom_headers is a dict
    if not isinstance(custom_headers, dict):
        custom_headers = {}

    try:
        # Caller-controlled connection URLs must never select server credentials.
        if isinstance(api_key, str) and "${" in api_key:
            return {
                "success": False,
                "message": "Connection tests require a literal API key",
            }
        resolved_key = model_credential_service.validate_model_api_key(
            api_key, required=True
        )
        return await run_in_threadpool(
            _test_llm_connection,
            provider_type=provider_type,
            model_id=model_id,
            api_key=resolved_key,
            base_url=base_url,
            custom_headers=custom_headers,
            model_category_type=model_category_type,
        )

    except model_credential_service.ModelCredentialError:
        return {"success": False, "message": "Model credentials unavailable"}
    except Exception as e:
        logger.error(f"Model connection test failed: {str(e)}")
        return {"success": False, "message": f"Connection failed: {str(e)}"}


@router.post("/fetch-available-models")
def fetch_available_models(
    fetch_data: dict,
    current_user: User = Depends(security.get_current_user),
):
    """
    Fetch available models from API provider

    Request body:
    {
      "provider_type": "openai" | "anthropic" | "gemini" | "custom",
      "api_key": "sk-...",
      "base_url": "https://api.openai.com/v1",  // optional
      "custom_headers": {"header-name": "header-value"}  // optional
    }

    Response:
    {
      "success": true | false,
      "models": [
        {
          "id": "gpt-4-turbo",
          "name": "GPT-4 Turbo",
          "created": 1234567890,
          "owned_by": "openai"
        }
      ],
      "message": "Error message"  // only present on failure
    }
    """
    import httpx

    provider_type = fetch_data.get("provider_type")
    api_key = fetch_data.get("api_key")
    base_url = fetch_data.get("base_url")
    custom_headers = fetch_data.get("custom_headers", {})

    if not provider_type or not api_key:
        return {
            "success": False,
            "message": "Missing required fields: provider_type, api_key",
            "models": [],
        }

    # Ensure custom_headers is a dict
    if not isinstance(custom_headers, dict):
        custom_headers = {}

    try:
        # OpenAI and custom OpenAI-compatible APIs
        if provider_type in ["openai", "custom"]:
            url = f"{base_url or 'https://api.openai.com/v1'}/models"
            headers = {
                "Authorization": f"Bearer {api_key}",
                **custom_headers,
            }

            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers)
                response.raise_for_status()
                data = response.json()

                models = []
                for model in data.get("data", []):
                    models.append(
                        {
                            "id": model.get("id"),
                            "name": model.get(
                                "id"
                            ),  # OpenAI doesn't provide display names
                            "created": model.get("created"),
                            "owned_by": model.get("owned_by"),
                        }
                    )

                return {"success": True, "models": models}

        # Anthropic
        elif provider_type == "anthropic":
            url = f"{base_url or 'https://api.anthropic.com'}/v1/models"
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                **custom_headers,
            }

            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers)
                response.raise_for_status()
                data = response.json()

                models = []
                for model in data.get("data", []):
                    models.append(
                        {
                            "id": model.get("id"),
                            "name": model.get("display_name") or model.get("id"),
                            "created": model.get("created_at"),
                        }
                    )

                return {"success": True, "models": models}

        # Gemini
        elif provider_type == "gemini":
            url = f"{base_url or 'https://generativelanguage.googleapis.com'}/v1/models"
            params = {"key": api_key}

            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, params=params, headers=custom_headers)
                response.raise_for_status()
                data = response.json()

                models = []
                for model in data.get("models", []):
                    model_id = model.get("name", "").replace("models/", "")
                    models.append(
                        {
                            "id": model_id,
                            "name": model.get("displayName") or model_id,
                        }
                    )

                return {"success": True, "models": models}

        else:
            return {
                "success": False,
                "message": f"Unsupported provider type: {provider_type}",
                "models": [],
            }

    except httpx.HTTPStatusError as e:
        status_code = e.response.status_code
        if status_code == 401:
            message = "API Key authentication failed"
        elif status_code == 403:
            message = "Permission denied"
        elif status_code == 404:
            message = "API endpoint not found"
        else:
            message = f"HTTP error {status_code}"

        logger.error(f"Failed to fetch models from {provider_type}: {message}")
        return {"success": False, "message": message, "models": []}

    except httpx.RequestError as e:
        logger.error(f"Network error fetching models from {provider_type}: {str(e)}")
        return {
            "success": False,
            "message": "Network connection failed",
            "models": [],
        }

    except Exception as e:
        logger.error(f"Unexpected error fetching models from {provider_type}: {str(e)}")
        return {"success": False, "message": str(e), "models": []}
