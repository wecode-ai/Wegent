# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field


# User Management Schemas
class AdminUserCreate(BaseModel):
    """Admin user creation model"""

    user_name: str = Field(..., min_length=2, max_length=50)
    password: Optional[str] = Field(None, min_length=6)
    email: Optional[EmailStr] = None
    role: Literal["admin", "user"] = "user"
    auth_source: Literal["password", "oidc"] = "password"


class AdminUserUpdate(BaseModel):
    """Admin user update model"""

    user_name: Optional[str] = Field(None, min_length=2, max_length=50)
    email: Optional[EmailStr] = None
    role: Optional[Literal["admin", "user"]] = None
    is_active: Optional[bool] = None


class PasswordReset(BaseModel):
    """Password reset model"""

    new_password: str = Field(..., min_length=6)


class AdminUserResponse(BaseModel):
    """Admin user response model"""

    id: int
    user_name: str
    email: Optional[str] = None
    role: str
    auth_source: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AdminUserListResponse(BaseModel):
    """Admin user list response model"""

    total: int
    items: List[AdminUserResponse]


# Public Model Management Schemas
class PublicModelCreate(BaseModel):
    """Public model creation model"""

    name: str = Field(..., min_length=1, max_length=100)
    namespace: str = Field(default="default", max_length=100)
    model_json: dict = Field(..., alias="json")

    class Config:
        populate_by_name = True


class PublicModelUpdate(BaseModel):
    """Public model update model"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    namespace: Optional[str] = Field(None, max_length=100)
    model_json: Optional[dict] = Field(None, alias="json")
    is_active: Optional[bool] = None

    class Config:
        populate_by_name = True


class PublicModelResponse(BaseModel):
    """Public model response model"""

    id: int
    name: str
    namespace: str
    model_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicModelListResponse(BaseModel):
    """Public model list response model"""

    total: int
    items: List[PublicModelResponse]


# System Stats Schemas
class SystemStats(BaseModel):
    """System statistics model"""

    total_users: int
    active_users: int
    admin_count: int
    total_tasks: int
    total_public_models: int


# Role Update Schema
class RoleUpdate(BaseModel):
    """Role update model"""

    role: Literal["admin", "user"]
