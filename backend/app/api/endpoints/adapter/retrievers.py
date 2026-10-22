# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from app.schemas.kind import Retriever
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.rag.gateway_factory import get_rag_gateway
from app.services.rag.remote_gateway import RemoteRagGatewayError
from knowledge_engine.storage.capabilities import (
    get_all_storage_retrieval_methods,
    get_supported_retrieval_methods,
    get_supported_storage_types,
)
from shared.models import RemoteTestConnectionRequest

# RAG module is heavy (llama_index, scipy, pandas, grpc) - skip in standalone mode

router = APIRouter()
logger = logging.getLogger(__name__)


def _check_rag_available():
    """Check if RAG module is available (not in standalone mode)."""
    if settings.STANDALONE_MODE:
        raise HTTPException(
            status_code=503,
            detail="RAG features are not available in standalone mode",
        )


# Static routes must be defined before dynamic routes to avoid conflicts
@router.get("/storage-types/retrieval-methods")
def get_storage_retrieval_methods():
    """
    Get supported retrieval methods for all storage types.

    This endpoint returns the retrieval methods supported by each storage backend.
    Frontend can use this to dynamically show/hide retrieval method options
    based on the selected storage type.

    Response:
    {
      "data": {
        "elasticsearch": ["vector", "keyword", "hybrid"],
        "qdrant": ["vector"]
      },
      "storage_types": ["elasticsearch", "qdrant"]
    }
    """
    _check_rag_available()
    return {
        "data": get_all_storage_retrieval_methods(),
        "storage_types": get_supported_storage_types(),
    }


@router.get("/storage-types/{storage_type}/retrieval-methods")
def get_storage_type_retrieval_methods(storage_type: str):
    """
    Get supported retrieval methods for a specific storage type.

    Args:
        storage_type: Storage type name (e.g., 'elasticsearch', 'qdrant')

    Response:
    {
      "storage_type": "elasticsearch",
      "retrieval_methods": ["vector", "keyword", "hybrid"]
    }

    Raises:
        400: If storage type is not supported
    """
    _check_rag_available()

    try:
        methods = get_supported_retrieval_methods(storage_type)
        return {
            "storage_type": storage_type,
            "retrieval_methods": methods,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("")
def list_retrievers(
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
    Get Retriever list with scope support.

    Scope behavior:
    - scope='personal' (default): personal retrievers only
    - scope='group': group retrievers (requires group_name)
    - scope='all': personal + all user's groups

    Response:
    {
      "data": [
        {
          "name": "retriever-name",
          "type": "user" | "group",
          "displayName": "Human Readable Name",
          "storageType": "elasticsearch" | "qdrant",
          "namespace": "default" | "group-name"
        }
      ]
    }
    """
    data = retriever_kinds_service.list_retrievers(
        db=db,
        user_id=current_user.id,
        scope=scope,
        group_name=group_name,
    )
    return {"data": data}


@router.get("/{retriever_name}")
def get_retriever(
    retriever_name: str,
    namespace: str = Query("default", description="Namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific retriever by name.

    Response: Retriever CRD
    """
    return retriever_kinds_service.get_retriever(
        db=db,
        user_id=current_user.id,
        name=retriever_name,
        namespace=namespace,
    )


@router.post("")
def create_retriever(
    retriever: Retriever,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new Retriever.

    If namespace is not 'default', creates the retriever in that group's namespace.
    User must have Developer+ permission in the group.

    Request body: Retriever CRD
    Response: Retriever CRD
    """
    return retriever_kinds_service.create_retriever(
        db=db,
        user_id=current_user.id,
        retriever=retriever,
    )


@router.put("/{retriever_name}")
def update_retriever(
    retriever_name: str,
    retriever: Retriever,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update an existing Retriever.

    Request body: Retriever CRD
    Response: Retriever CRD
    """
    return retriever_kinds_service.update_retriever(
        db=db,
        user_id=current_user.id,
        name=retriever_name,
        retriever=retriever,
    )


@router.delete("/{retriever_name}")
def delete_retriever(
    retriever_name: str,
    namespace: str = Query("default", description="Namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a Retriever (soft delete - set is_active to False).
    """
    retriever_kinds_service.delete_retriever(
        db=db,
        user_id=current_user.id,
        name=retriever_name,
        namespace=namespace,
    )
    return {"message": "Retriever deleted successfully"}


@router.post("/test-connection")
async def test_retriever_connection(
    test_data: dict,
    current_user: User = Depends(security.get_current_user),
):
    """
    Test retriever storage connection through knowledge_runtime.

    The Backend does not carry the vector store SDKs, so it forwards the
    configuration to knowledge_runtime, which performs the real connection
    test and returns the verdict.

    Request body:
    {
      "storage_type": "elasticsearch" | "qdrant",
      "url": "http://localhost:9200",
      "username": "optional",
      "password": "optional",
      "api_key": "optional"
    }

    Response:
    {
      "success": true | false,
      "message": "Connection successful" | "Error message"
    }
    """
    _check_rag_available()
    del current_user

    storage_type = test_data.get("storage_type")
    url = test_data.get("url")

    if not storage_type or not url:
        return {
            "success": False,
            "message": "Missing required fields: storage_type, url",
        }

    try:
        request = RemoteTestConnectionRequest(
            storage_type=storage_type,
            url=url,
            username=test_data.get("username"),
            password=test_data.get("password"),
            api_key=test_data.get("api_key"),
        )
        return await get_rag_gateway().test_connection(request)
    except RemoteRagGatewayError as e:
        logger.error("Retriever connection test failed: %s", e)
        return {"success": False, "message": str(e)}
    except ValueError as e:
        # A malformed payload must still come back as a verdict, not a 500.
        return {"success": False, "message": str(e)}
