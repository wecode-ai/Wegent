#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Pydantic models for envd REST API
"""

from typing import Dict, Optional

from pydantic import BaseModel


class InitRequest(BaseModel):
    """Request model for /init endpoint"""

    hyperloopIP: Optional[str] = None
    envVars: Optional[Dict[str, str]] = None
    accessToken: Optional[str] = None
    timestamp: Optional[str] = None
    defaultUser: Optional[str] = None
    defaultWorkdir: Optional[str] = None


class MetricsResponse(BaseModel):
    """Response model for /metrics endpoint"""

    ts: int
    cpu_count: int
    cpu_used_pct: float
    mem_total: int
    mem_used: int
    disk_used: int
    disk_total: int


class EntryInfo(BaseModel):
    """File entry information"""

    path: str
    name: str
    type: str


class ErrorResponse(BaseModel):
    """Error response model"""

    message: str
    code: int


# Workspace archive models
class ArchiveRequest(BaseModel):
    """Request model for /api/archive endpoint"""

    task_id: int
    upload_url: str  # Presigned MinIO upload URL
    max_size_mb: int = 500  # Maximum archive size in MB


class ArchiveResponse(BaseModel):
    """Response model for /api/archive endpoint"""

    task_id: int
    size_bytes: int
    session_file_included: bool  # Whether .claude_session_id was included
    git_included: bool  # Whether .git directory was included


class RestoreRequest(BaseModel):
    """Request model for /api/restore endpoint"""

    task_id: int
    download_url: str  # Presigned MinIO download URL


class RestoreResponse(BaseModel):
    """Response model for /api/restore endpoint"""

    success: bool
    session_restored: bool  # Whether .claude_session_id was restored
    git_restored: bool  # Whether .git directory was restored
