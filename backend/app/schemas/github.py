# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from pydantic import BaseModel


class Repository(BaseModel):
    """GitHub repository model"""

    id: int
    name: str
    full_name: str
    clone_url: str
    private: bool
    type: str
    git_domain: str


class RepositoryResult(BaseModel):
    """GitHub repository result model with renamed fields"""

    git_repo_id: int
    name: str
    git_repo: str
    git_url: str
    git_domain: str
    type: str
    private: bool


class Branch(BaseModel):
    """GitHub branch model"""

    name: str
    protected: bool
    default: bool


class GitHubUser(BaseModel):
    """GitHub user information model"""

    id: int
    login: str
    name: Optional[str] = None
    email: Optional[str] = None
    avatar_url: Optional[str] = None


class TokenValidationResponse(BaseModel):
    """GitHub token validation response"""

    valid: bool
    user: Optional[GitHubUser] = None
