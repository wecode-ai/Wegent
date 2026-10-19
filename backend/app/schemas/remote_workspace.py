# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional

from pydantic import BaseModel, Field


class RemoteWorkspaceStatusResponse(BaseModel):
    connected: bool
    available: bool
    root_path: str = "/workspace"
    reason: Optional[str] = None


class RemoteWorkspaceTreeEntry(BaseModel):
    name: str
    path: str
    is_directory: bool
    size: int = 0
    modified_at: Optional[str] = None


class RemoteWorkspaceTreeResponse(BaseModel):
    path: str
    entries: List[RemoteWorkspaceTreeEntry]


class RemoteWorkspaceArtifactDeclareRequest(BaseModel):
    relative_path: str = Field(min_length=1, max_length=4096)
    name: str = Field(min_length=1, max_length=255)
    file_size: int = Field(ge=0)
    mime_type: str = Field(default="application/octet-stream", max_length=255)
    modified_at: Optional[int] = Field(default=None, ge=0)
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


class RemoteWorkspaceArtifactResponse(BaseModel):
    id: int
    task_id: int
    subtask_id: int
    relative_path: str
    name: str
    file_size: int
    mime_type: str
    modified_at: Optional[int] = None
    sha256: str
    download_url: str
