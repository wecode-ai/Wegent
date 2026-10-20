# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import PurePosixPath, PureWindowsPath
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator


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


class RemoteWorkspaceArtifactWorkspace(BaseModel):
    workspace_root: str = Field(min_length=1, max_length=4096)

    @field_validator("workspace_root")
    @classmethod
    def validate_workspace_root(cls, value: str) -> str:
        paths = (PurePosixPath(value), PureWindowsPath(value))
        if (
            any(ord(char) < 32 for char in value)
            or ".." in value.replace("\\", "/").split("/")
            or not any(path.is_absolute() and path.parent != path for path in paths)
        ):
            raise ValueError("An absolute, non-root workspace directory is required")
        return value


class RemoteWorkspaceArtifactSource(RemoteWorkspaceArtifactWorkspace):
    executor_name: str = Field(min_length=1)
    executor_namespace: str = ""


class RemoteWorkspaceArtifactDeclareRequest(RemoteWorkspaceArtifactWorkspace):
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
