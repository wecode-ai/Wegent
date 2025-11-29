# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, EmailStr


class Token(BaseModel):
    """Token response model"""

    access_token: str
    token_type: str


class TokenData(BaseModel):
    """Token data model"""

    username: Optional[str] = None


class GitInfo(BaseModel):
    """Git information model"""

    git_domain: str
    git_token: str
    type: str
    user_name: Optional[str] = None
    git_id: Optional[str] = None
    git_login: Optional[str] = None
    git_email: Optional[str] = None


class UserBase(BaseModel):
    """User base model"""

    user_name: str
    email: Optional[EmailStr] = None
    is_active: Optional[bool] = True


class UserCreate(UserBase):
    """User creation model"""

    git_info: Optional[List[GitInfo]] = None
    password: Optional[str] = None


class UserUpdate(BaseModel):
    """User update model"""

    user_name: Optional[str] = None
    email: Optional[EmailStr] = None
    git_info: Optional[List[GitInfo]] = None
    password: Optional[str] = None


class UserInDB(UserBase):
    """Database user model"""

    id: int
    git_info: Optional[List[GitInfo]] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class LoginRequest(BaseModel):
    user_name: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str


class UserInfo(BaseModel):
    """User info model for admin list"""

    id: int
    user_name: str
