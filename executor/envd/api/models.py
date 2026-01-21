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
