#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Pydantic models for envd REST API
"""

from typing import Dict, List, Optional

from pydantic import BaseModel


class WorkspaceFile(BaseModel):
    """File entry information for workspace file listing"""

    name: str  # File/directory name
    path: str  # Relative path from workspace root
    type: str  # 'file' or 'directory'
    size: Optional[int] = None  # File size in bytes (only for files)
    children: Optional[List["WorkspaceFile"]] = None  # Children (only for directories)


class WorkspaceFilesResponse(BaseModel):
    """Response model for /files/list endpoint"""

    files: List[WorkspaceFile]
    total_count: int
    truncated: bool = False  # True if file count exceeds limit


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
