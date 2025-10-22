# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Kind API endpoints for all Kubernetes-style CRD operations
"""
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.kind import Kind

from app.core.security import get_current_user
from app.core.exceptions import NotFoundException, ConflictException
from app.models.user import User
from app.services.kind import kind_service
from app.schemas.kind import (
    Ghost, GhostList,
    Model, ModelList,
    Shell, ShellList,
    Bot, BotList,
    Team, TeamList,
    Workspace, WorkspaceList,
    Task, TaskList
)

router = APIRouter()

# Map kind strings to their corresponding schema classes
KIND_SCHEMA_MAP = {
    'Ghost': Ghost,
    'Model': Model,
    'Shell': Shell,
    'Bot': Bot,
    'Team': Team,
    'Workspace': Workspace,
    'Task': Task
}

# Map kind strings to their corresponding list schema classes
KIND_LIST_SCHEMA_MAP = {
    'Ghost': GhostList,
    'Model': ModelList,
    'Shell': ShellList,
    'Bot': BotList,
    'Team': TeamList,
    'Workspace': WorkspaceList,
    'Task': TaskList
}
# Map kind strings to their plural form for URL paths
KIND_URL_MAP = {
    'Ghost': 'ghosts',
    'Model': 'models',
    'Shell': 'shells',
    'Bot': 'bots',
    'Team': 'teams',
    'Workspace': 'workspaces',
    'Task': 'tasks'
}

# Map URL paths to their corresponding kind
URL_KIND_MAP = {v: k for k, v in KIND_URL_MAP.items()}


@router.get("/namespaces/{namespace}/{kinds}")
async def list_resources(
    namespace: str = Path(..., description="Resource namespace"),
    kinds: str = Path(..., description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks"),
    current_user: User = Depends(get_current_user)
):
    """
    List all resources of a specific kind in a namespace
    
    Returns a list of resources of the specified kind in the given namespace.
    The response is formatted according to the Kubernetes-style API conventions.
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid resource type: {kinds}"
        )
    
    kind = URL_KIND_MAP[kinds]
    
    try:
        resources = kind_service.list_resources(current_user.id, kind, namespace)
        
        # Get the appropriate list schema class
        list_schema_class = KIND_LIST_SCHEMA_MAP[kind]
        schema_class = KIND_SCHEMA_MAP[kind]
        
        # Format resources and create response
        items = [
            schema_class.parse_obj(kind_service._format_resource(kind, resource))
            for resource in resources
        ]
        
        return list_schema_class(
            apiVersion="agent.wecode.io/v1",
            kind=f"{kind}List",
            items=items
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error listing {kind} resources: {str(e)}"
        )


@router.get("/namespaces/{namespace}/{kinds}/{name}")
async def get_resource(
    namespace: str = Path(..., description="Resource namespace"),
    kinds: str = Path(..., description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks"),
    name: str = Path(..., description="Resource name"),
    current_user: User = Depends(get_current_user)
):
    """
    Get a specific resource
    
    Returns a single resource of the specified kind with the given name in the namespace.
    The response is formatted according to the Kubernetes-style API conventions.
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid resource type: {kinds}"
        )
    
    kind = URL_KIND_MAP[kinds]
    
    try:
        resource = kind_service.get_resource(current_user.id, kind, namespace, name)
        if not resource:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"{kind} '{name}' not found in namespace '{namespace}'"
            )
        
        # Get the appropriate schema class and format response
        schema_class = KIND_SCHEMA_MAP[kind]
        return schema_class.parse_obj(kind_service._format_resource(kind, resource))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving {kind} '{name}': {str(e)}"
        )


@router.post("/namespaces/{namespace}/{kinds}", status_code=status.HTTP_201_CREATED)
async def create_resource(
    namespace: str = Path(..., description="Resource namespace"),
    kinds: str = Path(..., description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks"),
    resource: Dict[str, Any] = None,
    current_user: User = Depends(get_current_user)
):
    """
    Create a new resource
    
    Creates a new resource of the specified kind in the given namespace.
    The request body should contain the complete resource definition.
    The response is the created resource formatted according to the Kubernetes-style API conventions.
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid resource type: {kinds}"
        )
    
    kind = URL_KIND_MAP[kinds]
    
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body is required"
        )
    
    # Validate resource using schema
    try:
        schema_class = KIND_SCHEMA_MAP[kind]
        # Ensure namespace matches
        if 'metadata' not in resource:
            resource['metadata'] = {}
        resource['metadata']['namespace'] = namespace
        
        # Validate resource against schema
        validated_resource = schema_class.parse_obj(resource).dict()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {kind} resource: {str(e)}"
        )
    
    # Create resource
    try:
        resource_id = kind_service.create_resource(current_user.id, kind, validated_resource)
        
        formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
        
        return schema_class.parse_obj(formatted_resource)
    except ConflictException as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.put("/namespaces/{namespace}/{kinds}/{name}")
async def update_resource(
    namespace: str = Path(..., description="Resource namespace"),
    kinds: str = Path(..., description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks"),
    name: str = Path(..., description="Resource name"),
    resource: Dict[str, Any] = None,
    current_user: User = Depends(get_current_user)
):
    """
    Update an existing resource
    
    Updates an existing resource of the specified kind with the given name in the namespace.
    The request body should contain the complete resource definition.
    The response is the updated resource formatted according to the Kubernetes-style API conventions.
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid resource type: {kinds}"
        )
    
    kind = URL_KIND_MAP[kinds]
    
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body is required"
        )
    
    # Validate resource using schema
    try:
        schema_class = KIND_SCHEMA_MAP[kind]
        # Ensure name and namespace match
        if 'metadata' not in resource:
            resource['metadata'] = {}
        resource['metadata']['name'] = name
        resource['metadata']['namespace'] = namespace
        
        # Validate resource against schema
        validated_resource = schema_class.parse_obj(resource).dict()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {kind} resource: {str(e)}"
        )
    
    try:
        # Update resource and directly get ID
        resource_id = kind_service.update_resource(
            current_user.id,
            kind,
            namespace,
            name,
            validated_resource
        )
        
        formatted_resource = kind_service._format_resource_by_id(kind, resource_id)
        
        return schema_class.parse_obj(formatted_resource)
    except NotFoundException as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating {kind} '{name}': {str(e)}"
        )


@router.delete("/namespaces/{namespace}/{kinds}/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_resource(
    namespace: str = Path(..., description="Resource namespace"),
    kinds: str = Path(..., description="Resource type. Valid options: ghosts, models, shells, bots, teams, workspaces, tasks"),
    name: str = Path(..., description="Resource name"),
    current_user: User = Depends(get_current_user)
):
    """
    Delete a resource
    
    Deletes a resource of the specified kind with the given name in the namespace.
    Returns no content on success.
    """
    if kinds not in URL_KIND_MAP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid resource type: {kinds}"
        )
    
    kind = URL_KIND_MAP[kinds]
    
    try:
        kind_service.delete_resource(current_user.id, kind, namespace, name)
    except NotFoundException as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting {kind} '{name}': {str(e)}"
        )