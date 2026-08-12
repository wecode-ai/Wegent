# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Composition root for project development workflow services."""

from app.services.adapters.team_kinds import team_kinds_service
from app.services.project_workflows.advancement import WorkflowAdvancementMixin
from app.services.project_workflows.automation import AutomationWorkflowMixin
from app.services.project_workflows.commands import WorkflowRunCommandMixin
from app.services.project_workflows.configuration import (
    ProjectWorkflowConfigurationMixin,
)
from app.services.project_workflows.development import DevelopmentWorkflowMixin
from app.services.project_workflows.execution import WorkflowExecutionMixin
from app.services.project_workflows.lookups import WorkflowLookupMixin
from app.services.project_workflows.provider import repository_provider_client
from app.services.project_workflows.views import WorkflowViewMixin


class ProjectWorkflowService(
    AutomationWorkflowMixin,
    DevelopmentWorkflowMixin,
    ProjectWorkflowConfigurationMixin,
    WorkflowRunCommandMixin,
    WorkflowExecutionMixin,
    WorkflowAdvancementMixin,
    WorkflowLookupMixin,
    WorkflowViewMixin,
):
    """Own the project-scoped workflow domain and its authorization boundary."""


project_workflow_service = ProjectWorkflowService()
