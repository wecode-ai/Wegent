# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional

from pydantic import BaseModel


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
