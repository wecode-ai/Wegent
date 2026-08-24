# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for the project-board first-screen read snapshot."""

from pydantic import BaseModel

from app.schemas.cloud_project import CloudProjectMemberResponse
from app.schemas.delivery import LoopItemResponse, LoopItemTaskBindingResponse
from app.schemas.project_chat import ProjectChatAgentView


class ProjectBoardSnapshotResponse(BaseModel):
    items: list[LoopItemResponse]
    task_bindings: list[LoopItemTaskBindingResponse]
    members: list[CloudProjectMemberResponse]
    agents: list[ProjectChatAgentView]
