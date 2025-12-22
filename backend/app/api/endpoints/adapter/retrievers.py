# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.kind import Retriever
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.rag.storage import factory as storage_factory

router = APIRouter()
logger = logging.getLogger(__name__)


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
    return {
        "data": storage_factory.get_all_storage_retrieval_methods(),
        "storage_types": storage_factory.get_supported_storage_types(),
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
    from fastapi import HTTPException

    try:
        methods = storage_factory.get_supported_retrieval_methods(storage_type)
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
def test_retriever_connection(
    test_data: dict,
    current_user: User = Depends(security.get_current_user),
):
    """
    Test retriever storage connection using storage backend.

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
    storage_type = test_data.get("storage_type")
    url = test_data.get("url")
    username = test_data.get("username")
    password = test_data.get("password")
    api_key = test_data.get("api_key")

    if not storage_type or not url:
        return {
            "success": False,
            "message": "Missing required fields: storage_type, url",
        }

    try:
        # Create storage backend from config
        backend = storage_factory.create_storage_backend_from_config(
            storage_type=storage_type,
            url=url,
            username=username,
            password=password,
            api_key=api_key,
        )

        # Test connection using backend's test_connection method
        success = backend.test_connection()

        if success:
            return {
                "success": True,
                "message": f"Successfully connected to {storage_type}",
            }
        else:
            return {
                "success": False,
                "message": f"Failed to connect to {storage_type}",
            }

    except ValueError as e:
        # Unsupported storage type
        return {"success": False, "message": str(e)}

    except Exception as e:
        logger.error(f"Retriever connection test failed: {str(e)}")
        return {"success": False, "message": f"Connection failed: {str(e)}"}
