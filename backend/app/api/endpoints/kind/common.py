# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Common helper functions and constants for kind API endpoints to reduce code duplication
"""
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictException, NotFoundException
from app.schemas.kind import (
    Bot,
    BotList,
    Ghost,
    GhostList,
    Model,
    ModelList,
    Retriever,
    RetrieverList,
    Shell,
    ShellList,
    Task,
    TaskList,
    Team,
    TeamList,
    Workspace,
    WorkspaceList,
)
from app.services.kind import kind_service
from app.services.user import user_service

# Map kind strings to their corresponding schema classes
KIND_SCHEMA_MAP = {
    "Ghost": Ghost,
    "Model": Model,
    "Shell": Shell,
    "Bot": Bot,
    "Team": Team,
    "Workspace": Workspace,
    "Task": Task,
    "Retriever": Retriever,
}

# Map kind strings to their corresponding list schema classes
KIND_LIST_SCHEMA_MAP = {
    "Ghost": GhostList,
    "Model": ModelList,
    "Shell": ShellList,
    "Bot": BotList,
    "Team": TeamList,
    "Workspace": WorkspaceList,
    "Task": TaskList,
    "Retriever": RetrieverList,
}

# Map kind strings to their plural form for URL paths
KIND_URL_MAP = {
    "Ghost": "ghosts",
    "Model": "models",
    "Shell": "shells",
    "Bot": "bots",
    "Team": "teams",
    "Workspace": "workspaces",
    "Task": "tasks",
    "Retriever": "retrievers",
}

# Map URL paths to their corresponding kind
URL_KIND_MAP = {v: k for k, v in KIND_URL_MAP.items()}


def validate_resource_type(kinds: str) -> str:
    """
    Validate resource type and return corresponding kind string

    Args:
        kinds: Resource type string from URL

    Returns:
        str: Corresponding kind string

    Raises:
        HTTPException: When resource type is invalid
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid resource type: {kinds}. Valid options: {', '.join(URL_KIND_MAP.keys())}",
        )

    return URL_KIND_MAP[kinds]


def validate_user_exists(db: Optional[Session], user_id: int) -> None:
    """
    Validate if user exists

    Args:
        db: Database session (optional, required for admin interface)
        user_id: User ID

    Raises:
        HTTPException: When user does not exist
    """
    try:
        if db:
            user_service.get_user_by_id(db, user_id)
        else:
            user_service.get_user_by_id(None, user_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


def format_resource_list(kind: str, resources: List[Any]) -> Any:
    """
    Format resource list as response format

    Args:
        kind: Resource type
        resources: Resource list

    Returns:
        Any: Formatted list response object
    """
    # Get corresponding schema class
    list_schema_class = KIND_LIST_SCHEMA_MAP[kind]
    schema_class = KIND_SCHEMA_MAP[kind]

    # Format resources and create response
    items = [
        schema_class.parse_obj(kind_service._format_resource(kind, resource))
        for resource in resources
    ]

    return list_schema_class(
        apiVersion="agent.wecode.io/v1", kind=f"{kind}List", items=items
    )


def format_single_resource(kind: str, resource: Any) -> Any:
    """
    Format single resource as response format

    Args:
        kind: Resource type
        resource: Resource object

    Returns:
        Any: Formatted resource object
    """
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(kind_service._format_resource(kind, resource))


def validate_and_prepare_resource(
    kind: str, resource: Dict[str, Any], namespace: str, name: Optional[str] = None
) -> Dict[str, Any]:
    """
    Validate and prepare resource data

    Args:
        kind: Resource type
        resource: Resource data
        namespace: Namespace
        name: Resource name (optional, for update operations)

    Returns:
        Dict[str, Any]: Validated resource data

    Raises:
        HTTPException: When resource data is invalid
    """
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Request body is required"
        )

    try:
        schema_class = KIND_SCHEMA_MAP[kind]

        # Ensure metadata exists
        if "metadata" not in resource:
            resource["metadata"] = {}

        # Set namespace
        resource["metadata"]["namespace"] = namespace

        # Set name if provided (for update operations)
        if name:
            resource["metadata"]["name"] = name

        # Validate resource
        validated_resource = schema_class.parse_obj(resource).dict()
        return validated_resource
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {kind} resource: {str(e)}",
        )


def handle_resource_operation_errors(
    operation: str,
    kind: str,
    name: Optional[str] = None,
    user_id: Optional[int] = None,
    admin_context: bool = False,
):
    """
    Resource operation error handling decorator

    Args:
        operation: Operation name (list, get, create, update, delete)
        kind: Resource type
        name: Resource name (optional)
        user_id: User ID (optional, for admin context)
        admin_context: Whether in admin context

    Returns:
        Decorator function
    """

    def decorator(func):
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except NotFoundException as e:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=str(e)
                )
            except ConflictException as e:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
            except HTTPException:
                raise
            except Exception as e:
                # Build error message
                if admin_context and user_id:
                    user_prefix = f"User {user_id}'s "
                else:
                    user_prefix = ""

                if name:
                    resource_desc = f"{user_prefix}{kind} resource '{name}'"
                else:
                    resource_desc = f"{user_prefix}{kind} resource"

                operation_en = {
                    "list": "listing",
                    "get": "getting",
                    "create": "creating",
                    "update": "updating",
                    "delete": "deleting",
                }.get(operation, operation)

                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Error {operation_en} {resource_desc}: {str(e)}",
                )

        return wrapper

    return decorator


def prepare_batch_resources(resources: List[Dict[str, Any]], namespace: str) -> None:
    """
    Prepare resource data for batch operations

    Args:
        resources: Resource list
        namespace: Namespace

    Raises:
        HTTPException: When resource list is empty
    """
    if not resources:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Resource list is required"
        )

    # Ensure all resources have correct namespace
    for resource in resources:
        if "metadata" not in resource:
            resource["metadata"] = {}
        resource["metadata"]["namespace"] = namespace
