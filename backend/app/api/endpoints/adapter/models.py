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
    model_category_type: Optional[str] = Query(
        None,
        description="Filter by model category type (llm, tts, stt, embedding, rerank)",
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
    - model_category_type: Optional filter by model category type (llm, tts, stt, embedding, rerank)

    Response:
    {
      "data": [
        {
          "name": "model-name",
          "type": "public" | "user",
          "displayName": "Human Readable Name",
          "provider": "openai" | "claude",
          "modelId": "gpt-4",
          "modelCategoryType": "llm" | "tts" | "stt" | "embedding" | "rerank"
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
        model_category_type=model_category_type,
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
        return _test_llm_connection(
            provider_type=provider_type,
            model_id=model_id,
            api_key=api_key,
            base_url=base_url,
            custom_headers=custom_headers,
            model_category_type=model_category_type,
        )

    except Exception as e:
        logger.error(f"Model connection test failed: {str(e)}")
        return {"success": False, "message": f"Connection failed: {str(e)}"}


def _test_llm_connection(
    provider_type: str,
    model_id: str,
    api_key: str,
    base_url: Optional[str],
    custom_headers: dict,
    model_category_type: str,
) -> dict:
    """Test LLM API connection using LangChain.

    Supports OpenAI, OpenAI Responses API, Anthropic, and Gemini providers.

    Args:
        provider_type: Provider type (openai, openai-responses, anthropic, gemini)
        model_id: The model ID to test
        api_key: API key for the provider
        base_url: Optional base URL for the API
        custom_headers: Optional custom HTTP headers
        model_category_type: Type of model (llm, embedding, tts, stt, rerank)
    """
    # Handle non-LLM model types
    if model_category_type == "embedding":
        return _test_embedding_connection(
            provider_type, model_id, api_key, base_url, custom_headers
        )
    elif model_category_type == "tts":
        return {
            "success": True,
            "message": f"TTS model {model_id} configured. Audio synthesis test requires actual audio output.",
        }
    elif model_category_type == "stt":
        return {
            "success": True,
            "message": f"STT model {model_id} configured. Audio transcription test requires actual audio input.",
        }
    elif model_category_type == "rerank":
        return {
            "success": True,
            "message": f"Rerank model {model_id} configured. Please verify with actual rerank request.",
        }

    # LLM test using LangChain
    if provider_type == "openai":
        from langchain_openai import ChatOpenAI

        chat_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "max_tokens": 128,
        }
        if base_url:
            chat_kwargs["base_url"] = base_url
        if custom_headers:
            chat_kwargs["default_headers"] = custom_headers

        chat = ChatOpenAI(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id} using Chat Completions API",
        }

    elif provider_type == "openai-responses":
        from langchain_openai import ChatOpenAI

        chat_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "max_tokens": 128,
            "use_responses_api": True,
        }
        if base_url:
            chat_kwargs["base_url"] = base_url
        if custom_headers:
            chat_kwargs["default_headers"] = custom_headers

        chat = ChatOpenAI(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id} using Responses API",
        }

    elif provider_type == "anthropic":
        from langchain_anthropic import ChatAnthropic

        chat_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "max_tokens": 128,
        }
        if base_url:
            chat_kwargs["base_url"] = base_url
        if custom_headers:
            chat_kwargs["default_headers"] = custom_headers

        chat = ChatAnthropic(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id}",
        }

    elif provider_type == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        chat_kwargs = {
            "model": model_id,
            "google_api_key": api_key,
            "max_output_tokens": 128,
        }
        # Note: ChatGoogleGenerativeAI doesn't support custom base_url or headers directly
        # For custom endpoints, users should use environment variables

        chat = ChatGoogleGenerativeAI(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id}",
        }

    else:
        return {
            "success": False,
            "message": f"Unsupported provider type: {provider_type}",
        }


def _test_embedding_connection(
    provider_type: str,
    model_id: str,
    api_key: str,
    base_url: Optional[str],
    custom_headers: dict,
) -> dict:
    """Test embedding model connection using LangChain."""
    if provider_type in ["openai", "openai-responses"]:
        from langchain_openai import OpenAIEmbeddings

        embeddings = OpenAIEmbeddings(
            model=model_id,
            api_key=api_key,
            base_url=base_url or "https://api.openai.com/v1",
            default_headers=custom_headers if custom_headers else None,
        )
        embeddings.embed_query("test")
        return {
            "success": True,
            "message": f"Successfully connected to embedding model {model_id}",
        }

    elif provider_type == "gemini":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings

        embeddings = GoogleGenerativeAIEmbeddings(
            model=model_id,
            google_api_key=api_key,
        )
        embeddings.embed_query("test")
        return {
            "success": True,
            "message": f"Successfully connected to embedding model {model_id}",
        }

    elif provider_type == "custom":
        """Test custom OpenAI-compatible embedding API connection."""
        from langchain_openai import OpenAIEmbeddings

        if not base_url:
            return {
                "success": False,
                "message": "base_url is required for custom provider",
            }

        # Construct embeddings endpoint
        embeddings_base_url = base_url.rstrip("/")
        if embeddings_base_url.endswith("/embeddings"):
            embeddings_base_url = embeddings_base_url[: -len("/embeddings")]
        # Build kwargs for OpenAIEmbeddings
        embeddings_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "base_url": embeddings_base_url,
        }

        # Add custom headers if provided
        if custom_headers and isinstance(custom_headers, dict):
            embeddings_kwargs["default_headers"] = custom_headers

        try:
            embeddings = OpenAIEmbeddings(**embeddings_kwargs)
            embeddings.embed_query("test")
            return {
                "success": True,
                "message": f"Successfully connected to custom embedding model {model_id}",
            }
        except Exception as e:
            logger.error(f"Custom embedding connection test failed: {str(e)}")
            return {
                "success": False,
                "message": f"Custom embedding connection failed: {str(e)}",
            }

    else:
        return {
            "success": False,
            "message": f"Embedding not supported for provider: {provider_type}",
        }


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
