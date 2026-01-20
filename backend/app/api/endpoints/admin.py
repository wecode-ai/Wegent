# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import func
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
from app.core.security import create_access_token, get_admin_user, get_password_hash
from app.models.kind import Kind
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.admin import (
    AdminUserCreate,
    AdminUserListResponse,
    AdminUserResponse,
    AdminUserUpdate,
    ChatSloganItem,
    ChatSloganTipsResponse,
    ChatSloganTipsUpdate,
    ChatTipItem,
    PasswordReset,
    PublicModelCreate,
    PublicModelListResponse,
    PublicModelResponse,
    PublicModelUpdate,
    PublicRetrieverListResponse,
    PublicRetrieverResponse,
    QuickAccessResponse,
    QuickAccessTeam,
    RoleUpdate,
    SystemConfigResponse,
    SystemConfigUpdate,
    SystemStats,
)
from app.schemas.kind import BatchResponse, Retriever
from app.schemas.task import TaskCreate, TaskInDB
from app.schemas.user import Token, UserInDB, UserInfo
from app.services.adapters.public_retriever import public_retriever_service
from app.services.adapters.task_kinds import task_kinds_service
from app.services.k_batch import apply_default_resources_async, batch_service
from app.services.kind import kind_service
from app.services.user import user_service

router = APIRouter()


# ==================== User Management Endpoints ====================


@router.get("/users", response_model=AdminUserListResponse)
async def list_all_users(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    include_inactive: bool = Query(False),
    search: Optional[str] = Query(None, description="Search by username or email"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all users with pagination and search
    """
    query = db.query(User)
    if not include_inactive:
        query = query.filter(User.is_active == True)

    # Apply search filter
    if search:
        search_pattern = f"%{search}%"
        query = query.filter(
            (User.user_name.ilike(search_pattern)) | (User.email.ilike(search_pattern))
        )

    total = query.count()
    users = query.offset((page - 1) * limit).limit(limit).all()

    return AdminUserListResponse(
        total=total,
        items=[
            AdminUserResponse(
                id=user.id,
                user_name=user.user_name,
                email=user.email,
                role=user.role,
                auth_source=user.auth_source,
                is_active=user.is_active,
                created_at=user.created_at,
                updated_at=user.updated_at,
            )
            for user in users
        ],
    )


@router.get("/users/{user_id}", response_model=AdminUserResponse)
async def get_user_by_id_endpoint(
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get detailed information for specified user ID
    """
    user = user_service.get_user_by_id(db, user_id)
    return AdminUserResponse(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
        role=user.role,
        auth_source=user.auth_source,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.post(
    "/users", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED
)
async def create_user(
    user_data: AdminUserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new user (admin only)
    """
    # Check if username already exists
    existing_user = db.query(User).filter(User.user_name == user_data.user_name).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"User with username '{user_data.user_name}' already exists",
        )

    # Validate password for password auth source
    if user_data.auth_source == "password" and not user_data.password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password is required for password authentication",
        )

    # Create user
    password_hash = (
        get_password_hash(user_data.password)
        if user_data.password
        else get_password_hash("oidc_placeholder")
    )
    new_user = User(
        user_name=user_data.user_name,
        email=user_data.email,
        password_hash=password_hash,
        role=user_data.role,
        auth_source=user_data.auth_source,
        is_active=True,
        git_info=[],
        preferences="{}",
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Apply default resources for the new user in a background thread
    def run_async_task():
        asyncio.run(apply_default_resources_async(new_user.id))

    thread = threading.Thread(target=run_async_task, daemon=True)
    thread.start()

    return AdminUserResponse(
        id=new_user.id,
        user_name=new_user.user_name,
        email=new_user.email,
        role=new_user.role,
        auth_source=new_user.auth_source,
        is_active=new_user.is_active,
        created_at=new_user.created_at,
        updated_at=new_user.updated_at,
    )


@router.put("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_data: AdminUserUpdate,
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update user information (admin only)
    """
    # Query user directly to avoid decrypt_user_git_info modifying the object
    # which can cause SQLAlchemy session state issues
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id {user_id} not found",
        )

    # Prevent admin from deactivating themselves
    if user.id == current_user.id and user_data.is_active is False:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot deactivate your own account",
        )

    # Prevent admin from demoting themselves
    if user.id == current_user.id and user_data.role == "user":
        # Check if there are other admins
        admin_count = (
            db.query(User).filter(User.role == "admin", User.is_active == True).count()
        )
        if admin_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot demote yourself when you are the only admin",
            )

    # Check username uniqueness if being changed
    if user_data.user_name and user_data.user_name != user.user_name:
        existing_user = (
            db.query(User).filter(User.user_name == user_data.user_name).first()
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"User with username '{user_data.user_name}' already exists",
            )

    # Update fields
    if user_data.user_name is not None:
        user.user_name = user_data.user_name
    if user_data.email is not None:
        user.email = user_data.email
    if user_data.role is not None:
        user.role = user_data.role
    if user_data.is_active is not None:
        user.is_active = user_data.is_active

    db.commit()
    db.refresh(user)

    return AdminUserResponse(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
        role=user.role,
        auth_source=user.auth_source,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a user (hard delete - permanently removes the user from database)
    """
    # Query user directly to avoid decrypt_user_git_info modifying the object
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id {user_id} not found",
        )

    # Prevent admin from deleting themselves
    if user.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete your own account",
        )

    # Hard delete - permanently remove the user
    db.delete(user)
    db.commit()

    return None


@router.post("/users/{user_id}/reset-password", response_model=AdminUserResponse)
async def reset_user_password(
    password_data: PasswordReset,
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Reset user password (admin only)
    """
    # Query user directly to avoid decrypt_user_git_info modifying the object
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id {user_id} not found",
        )

    # Only allow password reset for non-OIDC users
    # - "password": user registered with password
    # - "unknown": legacy users before auth_source was added
    # - "api:*": users auto-created via API service key
    can_reset = user.auth_source in [
        "password",
        "unknown",
    ] or user.auth_source.startswith("api:")
    if not can_reset:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot reset password for OIDC-authenticated users",
        )

    user.password_hash = get_password_hash(password_data.new_password)
    if user.auth_source == "unknown":
        user.auth_source = "password"
    db.commit()
    db.refresh(user)

    return AdminUserResponse(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
        role=user.role,
        auth_source=user.auth_source,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.post("/users/{user_id}/toggle-status", response_model=AdminUserResponse)
async def toggle_user_status(
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle user active status (enable/disable)
    """
    # Query user directly to avoid decrypt_user_git_info modifying the object
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id {user_id} not found",
        )

    # Prevent admin from disabling themselves
    if user.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot toggle your own account status",
        )

    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)

    return AdminUserResponse(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
        role=user.role,
        auth_source=user.auth_source,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.put("/users/{user_id}/role", response_model=AdminUserResponse)
async def update_user_role(
    role_data: RoleUpdate,
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update user role (admin only)
    """
    # Query user directly to avoid decrypt_user_git_info modifying the object
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id {user_id} not found",
        )

    # Prevent admin from demoting themselves if they're the only admin
    if user.id == current_user.id and role_data.role == "user":
        admin_count = (
            db.query(User).filter(User.role == "admin", User.is_active == True).count()
        )
        if admin_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot demote yourself when you are the only admin",
            )

    user.role = role_data.role
    db.commit()
    db.refresh(user)

    return AdminUserResponse(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
        role=user.role,
        auth_source=user.auth_source,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


# ==================== Public Model Management Endpoints ====================


@router.get("/public-models", response_model=PublicModelListResponse)
async def list_public_models(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public models with pagination, sorted by displayName
    """
    query = db.query(Kind).filter(
        Kind.user_id == 0, Kind.kind == "Model", Kind.namespace == "default"
    )
    total = query.count()
    models = query.all()

    # Helper function to extract displayName from json
    def get_display_name(model: Kind) -> str:
        """Extract displayName from model json, fallback to name"""
        if model.json and isinstance(model.json, dict):
            metadata = model.json.get("metadata", {})
            if isinstance(metadata, dict):
                display_name = metadata.get("displayName")
                if display_name:
                    return display_name
        return model.name

    # Sort models by displayName (case-insensitive)
    sorted_models = sorted(models, key=lambda m: get_display_name(m).lower())

    # Apply pagination after sorting
    start_idx = (page - 1) * limit
    end_idx = start_idx + limit
    paginated_models = sorted_models[start_idx:end_idx]

    return PublicModelListResponse(
        total=total,
        items=[
            PublicModelResponse(
                id=model.id,
                name=model.name,
                namespace=model.namespace,
                display_name=(
                    get_display_name(model)
                    if get_display_name(model) != model.name
                    else None
                ),
                model_json=model.json,
                is_active=model.is_active,
                created_at=model.created_at,
                updated_at=model.updated_at,
            )
            for model in paginated_models
        ],
    )


@router.post(
    "/public-models",
    response_model=PublicModelResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_model(
    model_data: PublicModelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public model (admin only)
    """
    # Check if model with same name and namespace already exists
    existing_model = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.name == model_data.name,
            Kind.namespace == model_data.namespace,
        )
        .first()
    )
    if existing_model:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public model '{model_data.name}' already exists in namespace '{model_data.namespace}'",
        )

    new_model = Kind(
        user_id=0,
        kind="Model",
        name=model_data.name,
        namespace=model_data.namespace,
        json=model_data.model_json,
        is_active=True,
    )
    db.add(new_model)
    db.commit()
    db.refresh(new_model)

    return PublicModelResponse(
        id=new_model.id,
        name=new_model.name,
        namespace=new_model.namespace,
        model_json=new_model.json,
        is_active=new_model.is_active,
        created_at=new_model.created_at,
        updated_at=new_model.updated_at,
    )


@router.put("/public-models/{model_id}", response_model=PublicModelResponse)
async def update_public_model(
    model_data: PublicModelUpdate,
    model_id: int = Path(..., description="Model ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public model (admin only)
    """
    model = (
        db.query(Kind)
        .filter(Kind.id == model_id, Kind.user_id == 0, Kind.kind == "Model")
        .first()
    )
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public model with id {model_id} not found",
        )

    # Check name uniqueness if being changed
    if model_data.name and model_data.name != model.name:
        namespace = model_data.namespace or model.namespace
        existing_model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_data.name,
                Kind.namespace == namespace,
            )
            .first()
        )
        if existing_model:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Public model '{model_data.name}' already exists in namespace '{namespace}'",
            )

    # Update fields
    if model_data.name is not None:
        model.name = model_data.name
    if model_data.namespace is not None:
        model.namespace = model_data.namespace
    if model_data.model_json is not None:
        model.json = model_data.model_json
    if model_data.is_active is not None:
        model.is_active = model_data.is_active

    db.commit()
    db.refresh(model)

    return PublicModelResponse(
        id=model.id,
        name=model.name,
        namespace=model.namespace,
        model_json=model.json,
        is_active=model.is_active,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


@router.delete("/public-models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_public_model(
    model_id: int = Path(..., description="Model ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public model (admin only)
    """
    model = (
        db.query(Kind)
        .filter(Kind.id == model_id, Kind.user_id == 0, Kind.kind == "Model")
        .first()
    )
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Public model with id {model_id} not found",
        )

    db.delete(model)
    db.commit()

    return None


# ==================== System Stats Endpoint ====================


@router.get("/stats", response_model=SystemStats)
async def get_system_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get system statistics
    """
    from app.models.task import Task

    total_users = db.query(User).count()
    active_users = db.query(User).filter(User.is_active == True).count()
    admin_count = (
        db.query(User).filter(User.role == "admin", User.is_active == True).count()
    )
    total_tasks = db.query(Task).count()
    total_public_models = (
        db.query(Kind)
        .filter(Kind.user_id == 0, Kind.kind == "Model", Kind.namespace == "default")
        .count()
    )

    return SystemStats(
        total_users=total_users,
        active_users=active_users,
        admin_count=admin_count,
        total_tasks=total_tasks,
        total_public_models=total_public_models,
    )


# ==================== Task Management Endpoints ====================


@router.post(
    "/users/{user_id}/tasks",
    response_model=TaskInDB,
    status_code=status.HTTP_201_CREATED,
)
async def create_task_for_user_id(
    task: TaskCreate,
    task_id: Optional[int] = None,
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create task for specified user ID
    """
    # Verify user exists
    target_user = user_service.get_user_by_id(db, user_id)

    # Create task
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task, user=target_user, task_id=task_id
    )


@router.post(
    "/users/username/{user_name}/tasks",
    response_model=TaskInDB,
    status_code=status.HTTP_201_CREATED,
)
async def create_task_for_user_by_username(
    task: TaskCreate,
    task_id: Optional[int] = None,
    user_name: str = Path(..., description="User name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create task for specified user name
    """
    # Verify user exists
    target_user = user_service.get_user_by_name(db, user_name)

    # Create task
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task, user=target_user, task_id=task_id
    )


@router.post("/generate-admin-token", response_model=Token)
async def generate_admin_token(
    db: Session = Depends(get_db), current_user: User = Depends(get_admin_user)
):
    """
    Generate a permanent admin token (pseudo-permanent for 500 years)
    """
    # Create a permanent token (set very long expiration time)
    access_token = create_access_token(
        data={"sub": current_user.user_name, "user_id": current_user.id},
        expires_delta=262800000,  # 500 years
    )

    return Token(access_token=access_token, token_type="bearer")


# Admin Kind Management Endpoints
# Provide administrators with full access to all user resources


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

    return {
        "message": f"Successfully deleted {kind} resource '{name}' for user {user_id}"
    }


# Admin Batch Operation Endpoints
# Provide administrators with batch operation capabilities for user resources


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


# ==================== System Config Endpoints ====================

QUICK_ACCESS_CONFIG_KEY = "quick_access_recommended"


@router.get("/system-config/quick-access", response_model=SystemConfigResponse)
async def get_quick_access_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get system recommended quick access configuration
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_ACCESS_CONFIG_KEY)
        .first()
    )
    if not config:
        return SystemConfigResponse(version=0, teams=[])

    config_value = config.config_value or {}
    return SystemConfigResponse(
        version=config.version,
        teams=config_value.get("teams", []),
    )


@router.put("/system-config/quick-access", response_model=SystemConfigResponse)
async def update_quick_access_config(
    config_data: SystemConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update system recommended quick access configuration (admin only).
    Version number is automatically incremented.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_ACCESS_CONFIG_KEY)
        .first()
    )

    if not config:
        # Create new config
        config = SystemConfig(
            config_key=QUICK_ACCESS_CONFIG_KEY,
            config_value={"teams": config_data.teams},
            version=1,
            updated_by=current_user.id,
        )
        db.add(config)
    else:
        # Update existing config and increment version
        config.config_value = {"teams": config_data.teams}
        config.version = config.version + 1
        config.updated_by = current_user.id

    db.commit()
    db.refresh(config)

    return SystemConfigResponse(
        version=config.version,
        teams=config.config_value.get("teams", []),
    )


# ==================== Chat Slogan & Tips Config Endpoints ====================

CHAT_SLOGAN_TIPS_CONFIG_KEY = "chat_slogan_tips"

# Default slogan and tips configuration
DEFAULT_SLOGAN_TIPS_CONFIG = {
    "slogans": [
        {
            "id": 1,
            "zh": "今天有什么可以帮到你？",
            "en": "What can I help you with today?",
            "mode": "chat",
        },
        {
            "id": 2,
            "zh": "让我们一起写代码吧",
            "en": "Let's code together",
            "mode": "code",
        },
    ],
    "tips": [
        {
            "id": 1,
            "zh": "试试问我：帮我分析这段代码的性能问题",
            "en": "Try asking: Help me analyze the performance issues in this code",
        },
        {
            "id": 2,
            "zh": "你可以上传文件让我帮你处理",
            "en": "You can upload files for me to help you process",
        },
        {
            "id": 3,
            "zh": "我可以帮你生成代码、修复 Bug 或重构现有代码",
            "en": "I can help you generate code, fix bugs, or refactor existing code",
        },
        {
            "id": 4,
            "zh": "试试让我帮你编写单元测试或文档",
            "en": "Try asking me to write unit tests or documentation",
        },
        {
            "id": 5,
            "zh": "我可以解释复杂的代码逻辑，帮助你理解代码库",
            "en": "I can explain complex code logic and help you understand the codebase",
        },
    ],
}


@router.get("/system-config/slogan-tips", response_model=ChatSloganTipsResponse)
async def get_slogan_tips_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get chat slogan and tips configuration
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .first()
    )
    if not config:
        # Return default configuration
        return ChatSloganTipsResponse(
            version=0,
            slogans=[
                ChatSloganItem(**s) for s in DEFAULT_SLOGAN_TIPS_CONFIG["slogans"]
            ],
            tips=[ChatTipItem(**tip) for tip in DEFAULT_SLOGAN_TIPS_CONFIG["tips"]],
        )

    config_value = config.config_value or {}
    return ChatSloganTipsResponse(
        version=config.version,
        slogans=[
            ChatSloganItem(**s)
            for s in config_value.get("slogans", DEFAULT_SLOGAN_TIPS_CONFIG["slogans"])
        ],
        tips=[ChatTipItem(**tip) for tip in config_value.get("tips", [])],
    )


@router.put("/system-config/slogan-tips", response_model=ChatSloganTipsResponse)
async def update_slogan_tips_config(
    config_data: ChatSloganTipsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update chat slogan and tips configuration (admin only).
    Version number is automatically incremented.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .first()
    )

    config_value = {
        "slogans": [s.model_dump() for s in config_data.slogans],
        "tips": [tip.model_dump() for tip in config_data.tips],
    }

    if not config:
        # Create new config
        config = SystemConfig(
            config_key=CHAT_SLOGAN_TIPS_CONFIG_KEY,
            config_value=config_value,
            version=1,
            updated_by=current_user.id,
        )
        db.add(config)
    else:
        # Update existing config and increment version
        config.config_value = config_value
        config.version = config.version + 1
        config.updated_by = current_user.id

    db.commit()
    db.refresh(config)

    return ChatSloganTipsResponse(
        version=config.version,
        slogans=config_data.slogans,
        tips=config_data.tips,
    )


# ==================== Service Key Management Endpoints ====================

import hashlib
import secrets

from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE, APIKey
from app.schemas.api_key import (
    AdminPersonalKeyListResponse,
    AdminPersonalKeyResponse,
    ServiceKeyCreate,
    ServiceKeyCreatedResponse,
    ServiceKeyListResponse,
    ServiceKeyResponse,
)


@router.get("/service-keys", response_model=ServiceKeyListResponse)
async def list_service_keys(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all service keys (admin only), including disabled ones.

    Service keys are used for trusted service authentication.
    """
    # Query service keys with creator information
    results = (
        db.query(APIKey, User)
        .outerjoin(User, APIKey.user_id == User.id)
        .filter(
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .order_by(APIKey.created_at.desc())
        .all()
    )

    items = []
    for api_key, creator in results:
        items.append(
            ServiceKeyResponse(
                id=api_key.id,
                name=api_key.name,
                key_prefix=api_key.key_prefix,
                description=api_key.description,
                expires_at=api_key.expires_at,
                last_used_at=api_key.last_used_at,
                created_at=api_key.created_at,
                is_active=api_key.is_active,
                created_by=creator.user_name if creator else None,
            )
        )

    return ServiceKeyListResponse(items=items, total=len(items))


@router.post(
    "/service-keys",
    response_model=ServiceKeyCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_service_key(
    service_key_create: ServiceKeyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new service key (admin only).

    The full key is only returned once at creation time.
    Store it securely as it cannot be retrieved again.

    Service keys are used for trusted service authentication
    via the wegent-source header.
    """
    # Generate key: wg-{32 random chars}
    random_part = secrets.token_urlsafe(32)
    full_key = f"wg-{random_part}"

    # Hash the key for storage
    key_hash = hashlib.sha256(full_key.encode()).hexdigest()

    # Create prefix for display (first 8 chars after "wg-")
    key_prefix = f"wg-{random_part[:8]}..."

    # Create the service key record (user_id records the creator admin)
    service_key = APIKey(
        user_id=current_user.id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        name=service_key_create.name,
        key_type=KEY_TYPE_SERVICE,
        description=service_key_create.description or "",
    )

    db.add(service_key)
    db.commit()
    db.refresh(service_key)

    # Return with full key (only shown once)
    return ServiceKeyCreatedResponse(
        id=service_key.id,
        name=service_key.name,
        key_prefix=service_key.key_prefix,
        description=service_key.description,
        key=full_key,
        expires_at=service_key.expires_at,
        last_used_at=service_key.last_used_at,
        created_at=service_key.created_at,
        is_active=service_key.is_active,
        created_by=current_user.user_name,
    )


@router.post("/service-keys/{key_id}/toggle-status", response_model=ServiceKeyResponse)
async def toggle_service_key_status(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle a service key's active status (admin only).

    Enable or disable a service key without deleting it.
    """
    result = (
        db.query(APIKey, User)
        .outerjoin(User, APIKey.user_id == User.id)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .first()
    )

    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Service key not found",
        )

    service_key, creator = result

    # Toggle is_active status
    service_key.is_active = not service_key.is_active
    db.commit()
    db.refresh(service_key)

    return ServiceKeyResponse(
        id=service_key.id,
        name=service_key.name,
        key_prefix=service_key.key_prefix,
        description=service_key.description,
        expires_at=service_key.expires_at,
        last_used_at=service_key.last_used_at,
        created_at=service_key.created_at,
        is_active=service_key.is_active,
        created_by=creator.user_name if creator else None,
    )


@router.delete("/service-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a service key (admin only).

    This is a hard delete - the key will be permanently removed.
    """
    service_key = (
        db.query(APIKey)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_SERVICE,
        )
        .first()
    )

    if not service_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Service key not found",
        )

    # Hard delete - permanently remove the record
    db.delete(service_key)
    db.commit()

    return None


# ==================== Personal Key Management Endpoints (Admin) ====================


@router.get("/personal-keys", response_model=AdminPersonalKeyListResponse)
async def list_all_personal_keys(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    search: Optional[str] = Query(None, description="Search by username or key name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all personal keys with their owners (admin only).

    Personal keys are user-created API keys for programmatic access.
    """
    query = (
        db.query(APIKey, User)
        .join(User, APIKey.user_id == User.id)
        .filter(APIKey.key_type == KEY_TYPE_PERSONAL)
    )

    # Apply search filter
    if search:
        search_pattern = f"%{search}%"
        query = query.filter(
            (User.user_name.ilike(search_pattern)) | (APIKey.name.ilike(search_pattern))
        )

    total = query.count()
    results = (
        query.order_by(APIKey.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    items = []
    for api_key, user in results:
        items.append(
            AdminPersonalKeyResponse(
                id=api_key.id,
                user_id=api_key.user_id,
                user_name=user.user_name,
                name=api_key.name,
                key_prefix=api_key.key_prefix,
                description=api_key.description,
                expires_at=api_key.expires_at,
                last_used_at=api_key.last_used_at,
                created_at=api_key.created_at,
                is_active=api_key.is_active,
            )
        )

    return AdminPersonalKeyListResponse(items=items, total=total)


@router.post(
    "/personal-keys/{key_id}/toggle-status", response_model=AdminPersonalKeyResponse
)
async def toggle_personal_key_status(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Toggle a personal key's active status (admin only).

    Enable or disable a personal key without deleting it.
    """
    result = (
        db.query(APIKey, User)
        .join(User, APIKey.user_id == User.id)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
        )
        .first()
    )

    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Personal key not found",
        )

    api_key, user = result

    # Toggle is_active status
    api_key.is_active = not api_key.is_active
    db.commit()
    db.refresh(api_key)

    return AdminPersonalKeyResponse(
        id=api_key.id,
        user_id=api_key.user_id,
        user_name=user.user_name,
        name=api_key.name,
        key_prefix=api_key.key_prefix,
        description=api_key.description,
        expires_at=api_key.expires_at,
        last_used_at=api_key.last_used_at,
        created_at=api_key.created_at,
        is_active=api_key.is_active,
    )


@router.delete("/personal-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_personal_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a personal key (admin only).

    This is a hard delete - the key will be permanently removed.
    """
    api_key = (
        db.query(APIKey)
        .filter(
            APIKey.id == key_id,
            APIKey.key_type == KEY_TYPE_PERSONAL,
        )
        .first()
    )

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Personal key not found",
        )

    # Hard delete - permanently remove the record
    db.delete(api_key)
    db.commit()

    return None


# ==================== Public Retriever Management Endpoints ====================


@router.get("/public-retrievers", response_model=PublicRetrieverListResponse)
async def list_public_retrievers(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of all public retrievers with pagination
    """
    total = public_retriever_service.count_active_retrievers(
        db, current_user=current_user
    )
    skip = (page - 1) * limit
    retrievers = public_retriever_service.get_retrievers(
        db, skip=skip, limit=limit, current_user=current_user
    )

    return PublicRetrieverListResponse(
        total=total,
        items=[
            PublicRetrieverResponse(
                id=r["id"],
                name=r["name"],
                namespace=r["namespace"],
                displayName=r["displayName"],
                storageType=r["storageType"],
                description=r["description"],
                json=r["json"],
                is_active=r["is_active"],
                created_at=r["created_at"],
                updated_at=r["updated_at"],
            )
            for r in retrievers
        ],
    )


@router.post(
    "/public-retrievers",
    response_model=PublicRetrieverResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_public_retriever(
    retriever_data: Retriever,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create a new public retriever (admin only)
    """
    result = public_retriever_service.create_retriever(
        db, retriever=retriever_data, current_user=current_user
    )
    return PublicRetrieverResponse(
        id=result["id"],
        name=result["name"],
        namespace=result["namespace"],
        displayName=result["displayName"],
        storageType=result["storageType"],
        description=result["description"],
        json=result["json"],
        is_active=result["is_active"],
        created_at=result["created_at"],
        updated_at=result["updated_at"],
    )


@router.put("/public-retrievers/{retriever_id}", response_model=PublicRetrieverResponse)
async def update_public_retriever(
    retriever_data: Retriever,
    retriever_id: int = Path(..., description="Retriever ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update a public retriever (admin only)
    """
    result = public_retriever_service.update_retriever(
        db,
        retriever_id=retriever_id,
        retriever=retriever_data,
        current_user=current_user,
    )
    return PublicRetrieverResponse(
        id=result["id"],
        name=result["name"],
        namespace=result["namespace"],
        displayName=result["displayName"],
        storageType=result["storageType"],
        description=result["description"],
        json=result["json"],
        is_active=result["is_active"],
        created_at=result["created_at"],
        updated_at=result["updated_at"],
    )


@router.delete(
    "/public-retrievers/{retriever_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_public_retriever(
    retriever_id: int = Path(..., description="Retriever ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Delete a public retriever (admin only)
    """
    public_retriever_service.delete_retriever(
        db, retriever_id=retriever_id, current_user=current_user
    )
    return None


# ==================== Subscription Monitor Endpoints (formerly Flow Monitor) ====================

from app.schemas.admin import (
    SubscriptionMonitorError,
    SubscriptionMonitorErrorListResponse,
    SubscriptionMonitorStats,
)


@router.get("/subscription-monitor/stats", response_model=SubscriptionMonitorStats)
async def get_subscription_monitor_stats(
    hours: int = Query(default=24, ge=1, le=720, description="Time range in hours"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get subscription execution statistics for admin monitoring.

    Returns aggregate statistics for all users' subscription executions within the
    specified time range. For privacy, only IDs and aggregate data are shown.
    """
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus

    # Calculate time threshold
    threshold = datetime.utcnow() - timedelta(hours=hours)

    # Query all executions within time range
    base_query = db.query(BackgroundExecution).filter(
        BackgroundExecution.created_at >= threshold
    )

    # Get counts by status
    total = base_query.count()
    completed = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.COMPLETED.value
    ).count()
    failed = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.FAILED.value
    ).count()
    cancelled = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.CANCELLED.value
    ).count()
    running = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.RUNNING.value
    ).count()
    pending = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.PENDING.value
    ).count()

    # Count timeout failures (error message contains "timeout" or "timed out")
    timeout = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.FAILED.value,
        BackgroundExecution.error_message.ilike("%timeout%"),
    ).count()

    # Calculate rates
    terminal_count = completed + failed + cancelled
    success_rate = (completed / terminal_count * 100) if terminal_count > 0 else 0.0
    failure_rate = (failed / terminal_count * 100) if terminal_count > 0 else 0.0
    timeout_rate = (timeout / terminal_count * 100) if terminal_count > 0 else 0.0

    # Get subscription counts (Subscription is stored in kinds table with kind='Subscription')
    total_subscriptions = (
        db.query(Kind)
        .filter(Kind.kind == "Subscription", Kind.is_active == True)
        .count()
    )
    # Active subscriptions are those with enabled=True in their JSON spec
    active_subscriptions = 0
    subscriptions = (
        db.query(Kind).filter(Kind.kind == "Subscription", Kind.is_active == True).all()
    )
    for sub in subscriptions:
        if sub.json and isinstance(sub.json, dict):
            spec = sub.json.get("spec", {})
            if spec.get("enabled", True):
                active_subscriptions += 1

    return SubscriptionMonitorStats(
        total_executions=total,
        completed_count=completed,
        failed_count=failed,
        timeout_count=timeout,
        cancelled_count=cancelled,
        running_count=running,
        pending_count=pending,
        success_rate=round(success_rate, 2),
        failure_rate=round(failure_rate, 2),
        timeout_rate=round(timeout_rate, 2),
        active_subscriptions_count=active_subscriptions,
        total_subscriptions_count=total_subscriptions,
    )


# Backward compatibility alias for flow-monitor endpoint
@router.get(
    "/flow-monitor/stats",
    response_model=SubscriptionMonitorStats,
    include_in_schema=False,
)
async def get_flow_monitor_stats(
    hours: int = Query(default=24, ge=1, le=720, description="Time range in hours"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """Backward compatibility alias for subscription-monitor/stats."""
    return await get_subscription_monitor_stats(
        hours=hours, db=db, current_user=current_user
    )


@router.get(
    "/subscription-monitor/errors", response_model=SubscriptionMonitorErrorListResponse
)
async def get_subscription_monitor_errors(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    hours: int = Query(default=24, ge=1, le=720, description="Time range in hours"),
    status_filter: Optional[str] = Query(
        None,
        alias="status",
        description="Filter by status (FAILED, CANCELLED, RUNNING)",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get list of subscription execution errors for admin monitoring.

    Returns a paginated list of failed, cancelled, or stuck executions.
    For privacy, only IDs, status, and error messages are shown - no task content.
    """
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus

    # Calculate time threshold
    threshold = datetime.utcnow() - timedelta(hours=hours)

    # Build query for error/abnormal executions
    query = db.query(BackgroundExecution).filter(
        BackgroundExecution.created_at >= threshold
    )

    # Apply status filter
    if status_filter:
        query = query.filter(BackgroundExecution.status == status_filter)
    else:
        # Default: show FAILED, CANCELLED, and stuck RUNNING (older than 1 hour)
        stuck_threshold = datetime.utcnow() - timedelta(hours=1)
        query = query.filter(
            (
                BackgroundExecution.status.in_(
                    [
                        BackgroundExecutionStatus.FAILED.value,
                        BackgroundExecutionStatus.CANCELLED.value,
                    ]
                )
            )
            | (
                (BackgroundExecution.status == BackgroundExecutionStatus.RUNNING.value)
                & (BackgroundExecution.started_at < stuck_threshold)
            )
        )

    # Get total count
    total = query.count()

    # Get paginated results
    skip = (page - 1) * limit
    executions = (
        query.order_by(BackgroundExecution.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    # Convert to response model (privacy-preserving: no prompt or result details)
    items = [
        SubscriptionMonitorError(
            execution_id=e.id,
            subscription_id=e.subscription_id,
            user_id=e.user_id,
            task_id=e.task_id,
            status=e.status,
            error_message=e.error_message,
            trigger_type=e.trigger_type,
            created_at=e.created_at,
            started_at=e.started_at,
            completed_at=e.completed_at,
        )
        for e in executions
    ]

    return SubscriptionMonitorErrorListResponse(total=total, items=items)


# Backward compatibility alias for flow-monitor endpoint
@router.get(
    "/flow-monitor/errors",
    response_model=SubscriptionMonitorErrorListResponse,
    include_in_schema=False,
)
async def get_flow_monitor_errors(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    hours: int = Query(default=24, ge=1, le=720, description="Time range in hours"),
    status_filter: Optional[str] = Query(
        None,
        alias="status",
        description="Filter by status (FAILED, CANCELLED, RUNNING)",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """Backward compatibility alias for subscription-monitor/errors."""
    return await get_subscription_monitor_errors(
        page=page,
        limit=limit,
        hours=hours,
        status_filter=status_filter,
        db=db,
        current_user=current_user,
    )
