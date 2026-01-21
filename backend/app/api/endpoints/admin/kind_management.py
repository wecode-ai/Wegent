# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin kind management and batch operation endpoints."""

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.kind.common import (
    format_resource_list,
    format_single_resource,
    prepare_batch_resources,
    validate_and_prepare_resource,
    validate_resource_type,
    validate_user_exists,
)
from app.api.endpoints.kind.kinds import KIND_SCHEMA_MAP
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.kind import BatchResponse
from app.services.k_batch import batch_service
from app.services.kind import kind_service
from app.services.user import user_service

router = APIRouter()


# ==================== Admin Kind Management Endpoints ====================


@router.get("/users/{user_id}/kinds/{kinds}")
async def admin_list_user_resources(
    user_id: int = Path(..., description="User ID"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    namespace: str = Query("default", description="Resource namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get all resources of specified type for a user

    Administrators can view resource lists for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists
    validate_user_exists(db, user_id)

    # Get resource list
    resources = kind_service.list_resources(user_id, kind, namespace)

    # Format and return response
    return format_resource_list(kind, resources)


@router.get("/users/username/{user_name}/kinds/{kinds}")
async def admin_list_user_resources_by_username(
    user_name: str = Path(..., description="User name"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    namespace: str = Query("default", description="Resource namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get all resources of specified type for a user by username

    Administrators can view resource lists for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists and get user ID
    target_user = user_service.get_user_by_name(db, user_name)
    user_id = target_user.id

    # Get resource list
    resources = kind_service.list_resources(user_id, kind, namespace)

    # Format and return response
    return format_resource_list(kind, resources)


@router.get("/users/{user_id}/kinds/{kinds}/{name}")
async def admin_get_user_resource(
    user_id: int = Path(..., description="User ID"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    namespace: str = Query("default", description="Resource namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get specific resource for a user

    Administrators can view details of any specific resource for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists
    validate_user_exists(db, user_id)

    # Get resource
    resource = kind_service.get_resource(user_id, kind, namespace, name)
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{kind} resource '{name}' not found in namespace '{namespace}'",
        )

    # Format and return response
    return format_single_resource(kind, resource)


@router.get("/users/username/{user_name}/kinds/{kinds}/{name}")
async def admin_get_user_resource_by_username(
    user_name: str = Path(..., description="User name"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    namespace: str = Query("default", description="Resource namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get specific resource for a user by username

    Administrators can view details of any specific resource for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists and get user ID
    target_user = user_service.get_user_by_name(db, user_name)
    user_id = target_user.id

    # Get resource
    resource = kind_service.get_resource(user_id, kind, namespace, name)
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{kind} resource '{name}' not found in namespace '{namespace}'",
        )

    # Format and return response
    return format_single_resource(kind, resource)


@router.post("/users/{user_id}/kinds/{kinds}", status_code=status.HTTP_201_CREATED)
async def admin_create_resource_for_user(
    user_id: int = Path(..., description="User ID"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    namespace: str = Query("default", description="Resource namespace"),
    resource: Dict[str, Any] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create resource for specified user

    Administrators can create resources for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists
    validate_user_exists(db, user_id)

    # Validate and prepare resource data
    validated_resource = validate_and_prepare_resource(kind, resource, namespace)

    # Create resource
    resource_id = kind_service.create_resource(user_id, kind, validated_resource)

    # Format and return response
    formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(formatted_resource)


@router.put("/users/{user_id}/kinds/{kinds}/{name}")
async def admin_update_user_resource(
    user_id: int = Path(..., description="User ID"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    namespace: str = Query("default", description="Resource namespace"),
    resource: Dict[str, Any] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update resource for specified user

    Administrators can update resources for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists
    validate_user_exists(db, user_id)

    # Validate and prepare resource data
    validated_resource = validate_and_prepare_resource(kind, resource, namespace, name)

    # Update resource
    resource_id = kind_service.update_resource(
        user_id, kind, namespace, name, validated_resource
    )

    # Format and return response
    formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
    schema_class = KIND_SCHEMA_MAP[kind]
    return schema_class.parse_obj(formatted_resource)


@router.delete(
    "/users/{user_id}/kinds/{kinds}/{name}", status_code=status.HTTP_204_NO_CONTENT
)
async def admin_delete_user_resource(
    user_id: int = Path(..., description="User ID"),
    kinds: str = Path(
        ...,
        description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks",
    ),
    name: str = Path(..., description="Resource name"),
    namespace: str = Query("default", description="Resource namespace"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete resource for specified user

    Administrators can delete resources for any user.
    """
    # Validate resource type
    kind = validate_resource_type(kinds)

    # Verify user exists
    validate_user_exists(db, user_id)

    # Delete resource
    kind_service.delete_resource(user_id, kind, namespace, name)

    return None


# ==================== Admin Batch Operation Endpoints ====================


@router.post("/users/{user_id}/kinds/batch/apply", response_model=BatchResponse)
async def admin_apply_resources_for_user(
    user_id: int = Path(..., description="User ID"),
    namespace: str = Query("default", description="Resource namespace"),
    resources: List[Dict[str, Any]] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Batch apply resources for specified user (create or update)

    Administrators can batch create or update resources for any user.
    """
    if not resources:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Resource list is required"
        )

    # Verify user exists
    user_service.get_user_by_id(db, user_id)

    # Ensure all resources have correct namespace
    for resource in resources:
        if "metadata" not in resource:
            resource["metadata"] = {}
        resource["metadata"]["namespace"] = namespace

    try:
        # Execute batch operation
        results = batch_service.apply_resources(user_id, resources)

        success_count = sum(1 for r in results if r["success"])
        total_count = len(results)

        return BatchResponse(
            success=success_count == total_count,
            message=f"Applied {success_count}/{total_count} resources for user {user_id}",
            results=results,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error batch applying resources for user {user_id}: {str(e)}",
        )


@router.post("/users/{user_id}/kinds/batch/delete", response_model=BatchResponse)
async def admin_delete_resources_for_user(
    user_id: int = Path(..., description="User ID"),
    namespace: str = Query("default", description="Resource namespace"),
    resources: List[Dict[str, Any]] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Batch delete resources for specified user

    Administrators can batch delete resources for any user.
    """
    # Verify user exists
    validate_user_exists(db, user_id)

    # Prepare batch resource data
    prepare_batch_resources(resources, namespace)

    # Execute batch delete operation
    results = batch_service.delete_resources(user_id, resources)

    success_count = sum(1 for r in results if r["success"])
    total_count = len(results)

    return BatchResponse(
        success=success_count == total_count,
        message=f"Deleted {success_count}/{total_count} resources for user {user_id}",
        results=results,
    )
