# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, EmailStr, field_validator


class UserPreferences(BaseModel):
    """User preferences model"""

    send_key: Literal["enter", "cmd_enter"] = "enter"
    search_key: Literal["cmd_k", "cmd_f", "disabled"] = "cmd_k"


class Token(BaseModel):
    """Token response model"""

    access_token: str
    token_type: str


class TokenData(BaseModel):
    """Token data model"""

    username: Optional[str] = None


class GitInfo(BaseModel):
    """Git information model"""

    id: Optional[str] = None  # Unique identifier for this git info entry (UUID)
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
    preferences: Optional[UserPreferences] = None
    password: Optional[str] = None


class UserUpdate(BaseModel):
    """User update model"""

    user_name: Optional[str] = None
    email: Optional[EmailStr] = None
    git_info: Optional[List[GitInfo]] = None
    preferences: Optional[UserPreferences] = None
    password: Optional[str] = None


class UserInDB(UserBase):
    """Database user model"""

    id: int
    git_info: Optional[List[GitInfo]] = None
    preferences: Optional[UserPreferences] = None
    role: str = "user"
    auth_source: str = "unknown"
    created_at: datetime
    updated_at: datetime

    @field_validator("preferences", mode="before")
    @classmethod
    def parse_preferences(cls, v):
        """Parse preferences from JSON string or dict to UserPreferences object"""
        if v is None or v == "" or v == "null":
            return None
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                if not parsed:  # Empty dict or None after parsing
                    return None
                return UserPreferences(**parsed)
            except (json.JSONDecodeError, TypeError):
                return None
        if isinstance(v, dict):
            if not v:  # Empty dict
                return None
            return UserPreferences(**v)
        return v

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
    role: str = "user"


class UserAuthTypeResponse(BaseModel):
    """Response model for user authentication type query"""

    exists: bool
    auth_source: Optional[str] = None


class CLILoginInitRequest(BaseModel):
    """Request model for CLI OIDC login initialization"""

    session_id: str


class CLILoginInitResponse(BaseModel):
    """Response model for CLI OIDC login initialization"""

    auth_url: str
    session_id: str


class CLIPollResponse(BaseModel):
    """Response model for CLI polling"""

    status: str  # pending, success, failed
    access_token: Optional[str] = None
    username: Optional[str] = None
    error: Optional[str] = None
