# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace application-service facade."""

from app.services.workspaces.agents import WorkspaceAgentService
from app.services.workspaces.execution_environments import (
    WorkspaceExecutionEnvironmentService,
)
from app.services.workspaces.lifecycle import WorkspaceLifecycleService
from app.services.workspaces.members import WorkspaceMemberService
from app.services.workspaces.personal_resources import WorkspacePersonalResourceService


class WorkspaceService(
    WorkspaceLifecycleService,
    WorkspaceMemberService,
    WorkspacePersonalResourceService,
    WorkspaceAgentService,
    WorkspaceExecutionEnvironmentService,
):
    """Expose the complete Workspace aggregate service through one facade."""


workspace_service = WorkspaceService()
