# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Kind API endpoints for all Kubernetes-style CRD operations
"""
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Path, status

from app.api.endpoints.kind.common import (
    KIND_SCHEMA_MAP,
    format_resource_list,
    format_single_resource,
    validate_and_prepare_resource,
    validate_resource_type,
)
from app.core.security import get_current_user
from app.models.user import User
from app.services.kind import kind_service

router = APIRouter()


# IMPORTANT: More specific routes (with {name}) must be registered BEFORE generic routes
# to avoid path parameter conflicts when using {namespace:path}
@router.get("/namespaces/{namespace:path}/{kinds}/{name}")
async def get_resource(
    namespace: str = Path(
        ...,
        description="Resource namespace (supports nested groups like 'parent/child')",
    ),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    current_user: User = Depends(get_current_user),
):
    """
    Get a specific resource

    Returns a single resource of the specified kind with the given name in the namespace.
    The response is formatted according to the Kubernetes-style API conventions.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Get resource
    resource = kind_service.get_resource(current_user.id, kind, namespace, name)
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{kind} '{name}' not found in namespace '{namespace}'",
        )

    # Format and return response
    return format_single_resource(kind, resource)


@router.get("/namespaces/{namespace:path}/{kinds}")
async def list_resources(
    namespace: str = Path(
        ...,
        description="Resource namespace (supports nested groups like 'parent/child')",
    ),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    current_user: User = Depends(get_current_user),
):
    """
    List all resources of a specific kind in a namespace

    Returns a list of resources of the specified kind in the given namespace.
    The response is formatted according to the Kubernetes-style API conventions.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Get resources list
    resources = kind_service.list_resources(current_user.id, kind, namespace)

    # Format and return response
    return format_resource_list(kind, resources)


@router.put("/namespaces/{namespace:path}/{kinds}/{name}")
async def update_resource(
    namespace: str = Path(
        ...,
        description="Resource namespace (supports nested groups like 'parent/child')",
    ),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    resource: Dict[str, Any] = None,
    current_user: User = Depends(get_current_user),
):
    """
    Update an existing resource

    Updates an existing resource of the specified kind with the given name in the namespace.
    The request body should contain the complete resource definition.
    The response is the updated resource formatted according to the Kubernetes-style API conventions.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Validate and prepare resource data
    validated_resource = validate_and_prepare_resource(kind, resource, namespace, name)

    # Update resource
    resource_id = kind_service.update_resource(
        current_user.id, kind, namespace, name, validated_resource
    )

    # Format and return response
    formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(formatted_resource)


@router.delete("/namespaces/{namespace:path}/{kinds}/{name}")
async def delete_resource(
    namespace: str = Path(
        ...,
        description="Resource namespace (supports nested groups like 'parent/child')",
    ),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    current_user: User = Depends(get_current_user),
):
    """
    Delete a resource

    Deletes a resource of the specified kind with the given name in the namespace.
    Returns a success message on completion.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Delete resource
    kind_service.delete_resource(current_user.id, kind, namespace, name)

    return {"message": f"Successfully deleted resource '{name}'"}


@router.post(
    "/namespaces/{namespace:path}/{kinds}", status_code=status.HTTP_201_CREATED
)
async def create_resource(
    namespace: str = Path(
        ...,
        description="Resource namespace (supports nested groups like 'parent/child')",
    ),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    resource: Dict[str, Any] = None,
    current_user: User = Depends(get_current_user),
):
    """
    Create a new resource

    Creates a new resource of specified kind in given namespace.
    The request body should contain complete resource definition.
    The response is the created resource formatted according to the Kubernetes-style API conventions.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Validate and prepare resource data
    validated_resource = validate_and_prepare_resource(kind, resource, namespace)

    # Create resource
    resource_id = kind_service.create_resource(
        current_user.id, kind, validated_resource
    )

    # Format and return response
    formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(formatted_resource)
