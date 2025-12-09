# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ========== Project Schemas ==========
class WikiProjectCreate(BaseModel):
    """Create wiki project record"""

    project_name: str
    project_type: str = "git"
    source_type: str = "github"
    source_url: str
    source_id: Optional[str] = None
    source_domain: Optional[str] = None
    description: Optional[str] = None
    ext: Optional[Dict[str, Any]] = None


class WikiProjectInDB(BaseModel):
    """Wiki project record in database"""

    id: int
    project_name: str
    project_type: str
    source_type: str
    source_url: str
    source_id: Optional[str]
    source_domain: Optional[str]
    description: Optional[str]
    ext: Optional[Dict[str, Any]]
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ========== Generation Schemas ==========
class SourceSnapshot(BaseModel):
    """Source snapshot information (generic)"""

    type: str  # git/local/url
    # Git project fields
    branch_name: Optional[str] = None
    commit_id: Optional[str] = None
    commit_message: Optional[str] = None
    commit_time: Optional[str] = None
    commit_author: Optional[str] = None
    # Local project fields
    path: Optional[str] = None
    version: Optional[str] = None
    # URL project fields
    url: Optional[str] = None
    # Common fields
    snapshot_time: Optional[str] = None
    file_count: Optional[int] = None


class WikiGenerationCreate(BaseModel):
    """Create wiki document generation task (system-level)

    Note: Wiki generation uses system-level configuration.
    Team and model are configured in backend (WIKI_DEFAULT_TEAM_NAME),
    not selected by frontend users.
    """

    project_name: str = Field(..., description="Project name")
    source_url: str = Field(..., description="Source URL")
    source_id: Optional[str] = Field(None, description="Source ID")
    source_domain: Optional[str] = Field(None, description="Source domain")
    project_type: str = Field(default="git", description="Project type")
    source_type: str = Field(default="github", description="Source type")
    generation_type: str = Field(default="full", description="Generation type")
    language: Optional[str] = Field(
        default="en", description="Target language for documentation generation"
    )
    source_snapshot: SourceSnapshot = Field(..., description="Source snapshot")
    ext: Optional[Dict[str, Any]] = Field(None, description="Extension fields")


class WikiGenerationInDB(BaseModel):
    """Wiki generation record in database"""

    id: int
    project_id: int
    user_id: int
    task_id: Optional[int]
    team_id: int
    generation_type: str
    source_snapshot: Dict[str, Any]
    status: str
    ext: Optional[Dict[str, Any]]
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


# ========== Content Schemas ==========
class WikiContentSection(BaseModel):
    """Wiki content section for write API"""

    type: str
    title: str
    content: str
    parent_id: Optional[int] = None
    ext: Optional[Dict[str, Any]] = None


class WikiContentSummary(BaseModel):
    """Wiki content write summary"""

    status: Optional[Literal["COMPLETED", "FAILED"]] = None
    error_message: Optional[str] = None
    model: Optional[str] = None
    tokens_used: Optional[int] = None
    structure_order: Optional[List[str]] = None


class WikiContentWriteRequest(BaseModel):
    """Request payload for writing wiki contents"""

    generation_id: int
    sections: List[WikiContentSection]
    summary: Optional[WikiContentSummary] = None


class WikiContentCreate(BaseModel):
    """Create wiki content"""

    generation_id: int
    type: str = "chapter"
    title: str
    content: str
    parent_id: Optional[int] = None
    ext: Optional[Dict[str, Any]] = None


class WikiContentInDB(BaseModel):
    """Wiki content in database"""

    id: int
    generation_id: int
    type: str
    title: str
    content: str
    parent_id: Optional[int]
    ext: Optional[Dict[str, Any]]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ========== Response Schemas ==========
class WikiGenerationDetail(WikiGenerationInDB):
    """Wiki generation detail (includes project info and contents)"""

    project: Optional[WikiProjectInDB] = None
    contents: List[WikiContentInDB] = []


class WikiGenerationListResponse(BaseModel):
    """Wiki generation list response"""

    total: int
    items: List[WikiGenerationInDB]


class WikiProjectDetail(WikiProjectInDB):
    """Wiki project detail (includes generation records)"""

    generations: List[WikiGenerationInDB] = []


class WikiProjectListResponse(BaseModel):
    """Wiki project list response"""

    total: int
    items: List[WikiProjectInDB]
