# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Typed contracts for the project configuration MCP control plane."""

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    create_model,
    model_validator,
)

from app.schemas.cloud_project import (
    CloudProjectAiAutomation,
    CloudProjectBoardConfig,
    CloudProjectPullRequestAutomation,
)
from app.schemas.issue_workflow import ProjectWorkflowDefinition
from app.schemas.project_admin import (
    ProjectAdminReadResult,
    ProjectAdminWriteResult,
    ProjectAssistantRosterChange,
    ProjectCollaborationPolicy,
    ProjectMemberChange,
    ProjectTagChange,
    validate_unique_roster_changes,
)
from app.schemas.project_admin_board_views import ProjectAdminBoardViews
from app.schemas.tagging import NormalizedTags


class ProjectAdminWriteControls(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    operation_id: str | None = Field(default=None, min_length=1, max_length=128)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)
    dry_run: bool = False


class ProjectDetailsUpdate(ProjectAdminWriteControls):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None

    @model_validator(mode="after")
    def require_change(self) -> "ProjectDetailsUpdate":
        if self.name is None and self.description is None:
            raise ValueError("name or description is required")
        return self


class ProjectTagsUpdate(ProjectAdminWriteControls):
    tags: NormalizedTags


class ProjectTagUpdate(ProjectAdminWriteControls):
    tag_change: ProjectTagChange


class ProjectBoardViewsUpdate(ProjectAdminWriteControls):
    board_views: ProjectAdminBoardViews


class ProjectStrategyUpdate(ProjectAdminWriteControls):
    collaboration_policy: ProjectCollaborationPolicy


class ProjectStatusesUpdate(ProjectAdminWriteControls):
    board_config: CloudProjectBoardConfig


class ProjectWorkflowUpdate(ProjectAdminWriteControls):
    workflow_definition: ProjectWorkflowDefinition


class ProjectAutomationUpdate(ProjectAdminWriteControls):
    ai_automation: CloudProjectAiAutomation
    pull_request_automation: CloudProjectPullRequestAutomation | None = None


class ProjectAdminSpaceUpdate(ProjectAdminWriteControls):
    """Allowlisted project configuration fields; provider credentials are excluded."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    tags: NormalizedTags | None = None
    tag_change: ProjectTagChange | None = None
    board_config: CloudProjectBoardConfig | None = None
    board_views: ProjectAdminBoardViews | None = None
    collaboration_policy: ProjectCollaborationPolicy | None = None
    workflow_definition: ProjectWorkflowDefinition | None = None
    ai_automation: CloudProjectAiAutomation | None = None
    pull_request_automation: CloudProjectPullRequestAutomation | None = None
    member_changes: list[ProjectMemberChange] | None = Field(
        default=None, min_length=1, max_length=50
    )
    assistant_roster_changes: list[ProjectAssistantRosterChange] | None = Field(
        default=None, min_length=1, max_length=50
    )


class ProjectAdminError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason_code: str
    message: str
    status_code: int
    fields: list[dict[str, Any]] = Field(default_factory=list)


class ProjectMembersUpdate(ProjectAdminWriteControls):
    member_changes: list[ProjectMemberChange] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_members(self) -> "ProjectMembersUpdate":
        validate_unique_roster_changes(self.member_changes, "user_id")
        return self


class ProjectAssistantRosterUpdate(ProjectAdminWriteControls):
    assistant_roster_changes: list[ProjectAssistantRosterChange] = Field(
        min_length=1, max_length=50
    )

    @model_validator(mode="after")
    def validate_assistants(self) -> "ProjectAssistantRosterUpdate":
        validate_unique_roster_changes(self.assistant_roster_changes, "agent_id")
        return self


class ProjectAdminFailure(BaseModel):
    error: ProjectAdminError


class ProjectAdminSpaceUpdateResult(BaseModel):
    id: str
    project_key: str
    name: str
    description: str
    task_provider: str
    tags: list[str]
    version: int
    project_admin_result: ProjectAdminWriteResult


def project_admin_output_schema(result_type: type[BaseModel]) -> dict[str, Any]:
    schema = TypeAdapter(result_type | ProjectAdminFailure).json_schema()
    return {"type": "object", **schema}


@dataclass(frozen=True)
class ProjectAdminOperation:
    name: str
    tool_name: str
    description: str
    permission: Literal["viewer", "maintainer"]
    request_type: type[BaseModel] | None = None

    @property
    def read_only(self) -> bool:
        return self.request_type is None

    def input_schema(self) -> dict[str, Any]:
        fields: dict[str, Any] = {"space_id": (str, "")}
        if self.request_type is not None:
            fields["request"] = (self.request_type, ...)
        return create_model(
            f"{self.tool_name}Input", __config__=ConfigDict(extra="forbid"), **fields
        ).model_json_schema()

    def descriptor(self) -> dict[str, Any]:
        output = ProjectAdminReadResult if self.read_only else ProjectAdminWriteResult
        return {
            "name": self.name,
            "toolName": self.tool_name,
            "description": self.description,
            "inputSchema": self.input_schema(),
            "outputSchema": project_admin_output_schema(output),
            "errorSchema": ProjectAdminFailure.model_json_schema(),
            "permission": self.permission,
            "readOnly": self.read_only,
            "supportsDryRun": not self.read_only,
            "requiresVersion": not self.read_only,
            "idempotencyKey": not self.read_only,
            "availability": {"available": True},
        }


PROJECT_ADMIN_OPERATIONS = (
    ProjectAdminOperation(
        "project.get",
        "get_project_config",
        "Read project configuration and revisions.",
        "viewer",
    ),
    ProjectAdminOperation(
        "project.update",
        "update_project_details",
        "Update project name or description.",
        "maintainer",
        ProjectDetailsUpdate,
    ),
    ProjectAdminOperation(
        "project.tags.replace",
        "update_project_tags",
        "Replace tags and clean every saved reference atomically.",
        "maintainer",
        ProjectTagsUpdate,
    ),
    ProjectAdminOperation(
        "project.tag.change",
        "change_project_tag",
        "Rename or delete one tag and update all references atomically.",
        "maintainer",
        ProjectTagUpdate,
    ),
    ProjectAdminOperation(
        "project.boardViews.update",
        "update_project_board_views",
        "Replace validated saved board views.",
        "maintainer",
        ProjectBoardViewsUpdate,
    ),
    ProjectAdminOperation(
        "project.strategy.update",
        "update_project_strategy",
        "Update collaboration policy for future Issues; running snapshots remain unchanged.",
        "maintainer",
        ProjectStrategyUpdate,
    ),
    ProjectAdminOperation(
        "project.statuses.update",
        "update_project_statuses",
        "Update board statuses and status configuration.",
        "maintainer",
        ProjectStatusesUpdate,
    ),
    ProjectAdminOperation(
        "project.workflow.update",
        "update_project_workflow",
        "Update the typed workflow definition for future Issues.",
        "maintainer",
        ProjectWorkflowUpdate,
    ),
    ProjectAdminOperation(
        "project.automation.update",
        "update_project_automation",
        "Update typed project retry and pull request automation settings.",
        "maintainer",
        ProjectAutomationUpdate,
    ),
    ProjectAdminOperation(
        "project.members.get",
        "get_project_members",
        "Read project permission roles and functional responsibilities.",
        "viewer",
    ),
    ProjectAdminOperation(
        "project.assistantRoster.get",
        "get_project_assistant_roster",
        "Read visible project assistant bindings without private executable content.",
        "viewer",
    ),
    ProjectAdminOperation(
        "project.members.update",
        "update_project_members",
        "Update direct project membership and functional responsibilities atomically.",
        "maintainer",
        ProjectMembersUpdate,
    ),
    ProjectAdminOperation(
        "project.assistantRoster.update",
        "update_project_assistant_roster",
        "Update project assistant activation and functional responsibilities using existing resource authorization.",
        "maintainer",
        ProjectAssistantRosterUpdate,
    ),
)


def build_project_admin_capabilities(
    db: Any, project_id: int, user_id: int
) -> dict[str, Any]:
    """Publish only callable operations using the same role check as page writes."""
    from app.core.config import settings
    from app.schemas.base_role import BaseRole
    from app.services.cloud_projects.access import require_cloud_project_role
    from app.services.cloud_projects.service import cloud_project_service

    access = require_cloud_project_role(db, project_id, user_id, BaseRole.Viewer)
    snapshot = cloud_project_service.admin_config(db, project_id, user_id)
    return build_project_admin_catalog(
        access.role,
        snapshot["projectVersion"],
        snapshot["revision"],
        settings.WEWORK_PROJECT_ADMIN_TOOLS_V1,
    )


def build_project_admin_catalog(
    role: Any, project_version: int, revision: int, enabled: bool
) -> dict[str, Any]:
    """Build canonical schemas for remote MCP and the desktop's native bridge."""
    from app.schemas.base_role import BaseRole, has_permission

    operations = []
    unavailable = []
    for operation in PROJECT_ADMIN_OPERATIONS:
        descriptor = operation.descriptor()
        reason = None
        if not has_permission(role, BaseRole.Viewer):
            reason = "permission_denied"
        elif not operation.read_only:
            if not has_permission(role, BaseRole.Maintainer):
                reason = "permission_denied"
            elif not enabled:
                reason = "feature_disabled"
        if reason:
            descriptor["availability"] = {"available": False, "reason_code": reason}
            unavailable.append(descriptor)
        else:
            operations.append(descriptor)
    return {
        "schemaVersion": 1,
        "featureFlag": "wework.projectAdminTools.v1",
        "enabled": enabled,
        "projectVersion": project_version,
        "revision": revision,
        "updateSpaceInputSchema": create_model(
            "update_spaceInput",
            __config__=ConfigDict(extra="forbid"),
            project=(ProjectAdminSpaceUpdate, ...),
            space_id=(str, ""),
        ).model_json_schema(),
        "updateSpaceOutputSchema": project_admin_output_schema(
            ProjectAdminSpaceUpdateResult
        ),
        "operations": operations,
        "unavailableCapabilities": unavailable,
    }
