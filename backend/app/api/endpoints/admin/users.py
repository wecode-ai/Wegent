# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin user management endpoints."""

import asyncio
import threading
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user, get_password_hash
from app.models.user import User
from app.schemas.admin import (
    AdminUserCreate,
    AdminUserListResponse,
    AdminUserResponse,
    AdminUserUpdate,
    PasswordReset,
    RoleUpdate,
)
from app.services.k_batch import apply_default_resources_async
from app.services.user import user_service

router = APIRouter()


def _user_to_response(user: User) -> AdminUserResponse:
    """Convert User model to AdminUserResponse."""
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
        items=[_user_to_response(user) for user in users],
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
    return _user_to_response(user)


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

    return _user_to_response(new_user)


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

    return _user_to_response(user)


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

    return _user_to_response(user)


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

    return _user_to_response(user)


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

    return _user_to_response(user)
