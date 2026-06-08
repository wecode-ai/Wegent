# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project schemas for API request/response validation.

Projects are containers for organizing tasks. Each task can belong to one project.
"""

import posixpath
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.constants import CLIENT_ORIGIN_FRONTEND, SUPPORTED_CLIENT_ORIGINS
from shared.utils.git_util import get_safe_git_workspace_key


class ProjectTaskBase(BaseModel):
    """Base model for project-task association."""

    task_id: int = Field(..., description="Task ID to add to project")


class ProjectTaskCreate(ProjectTaskBase):
    """Request model for adding a task to a project."""

    pass


class ProjectTaskResponse(BaseModel):
    """Response model for a task within a project."""

    task_id: int = Field(..., description="Task ID")
    task_title: str = Field(..., description="Task title")
    task_status: str = Field(..., description="Task status")
    device_id: Optional[str] = Field(None, description="Device ID used for execution")
    execution_workspace_source: Optional[str] = Field(
        None, description="Task execution workspace source"
    )
    is_group_chat: bool = Field(
        default=False, description="Whether the task is a group chat"
    )
    project_id: int = Field(..., description="Project ID")
    updated_at: Optional[datetime] = Field(
        None, description="Task last update timestamp"
    )

    class Config:
        """Pydantic config."""

        from_attributes = True


class ProjectExecutionConfig(BaseModel):
    """Execution target for a workspace project."""

    targetType: Literal["local", "cloud"] = Field(..., description="Execution target")
    deviceId: Optional[str] = Field(None, description="Local device ID")

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_device(self) -> "ProjectExecutionConfig":
        """Ensure deviceId is present for local and absent for cloud."""
        if self.targetType == "local" and not self.deviceId:
            raise ValueError("deviceId is required when targetType is local")
        if self.targetType == "cloud" and self.deviceId:
            raise ValueError("deviceId must be empty when targetType is cloud")
        return self


class ProjectTeamConfig(BaseModel):
    """Default team used when creating conversations in a workspace project."""

    id: Optional[int] = Field(None, description="Team database ID")
    name: Optional[str] = Field(None, description="Team resource name")
    namespace: str = Field(default="default", description="Team namespace")

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_team_ref(self) -> "ProjectTeamConfig":
        """Require at least one of team.id or team.name."""
        if self.id is None and not self.name:
            raise ValueError("Either team.id or team.name is required")
        return self


class ProjectWorkspaceRef(BaseModel):
    """Workspace CRD reference."""

    name: str = Field(..., min_length=1, description="Workspace resource name")
    namespace: str = Field(default="default", description="Workspace namespace")

    model_config = ConfigDict(extra="forbid")


class ProjectWorkspaceConfig(BaseModel):
    """Workspace source configuration for a workspace project."""

    source: Literal["git", "local_path"] = Field(..., description="Workspace source")
    localPath: Optional[str] = Field(None, description="Local directory path")
    checkoutPath: Optional[str] = Field(None, description="Optional checkout path")
    workspaceRef: Optional[ProjectWorkspaceRef] = Field(
        None, description="Workspace CRD reference"
    )

    model_config = ConfigDict(extra="forbid")


class ProjectGitConfig(BaseModel):
    """Git repository configuration for a workspace project."""

    url: str = Field(..., min_length=1, description="Git repository URL")
    repo: Optional[str] = Field(None, description="Repository name")
    repoId: Optional[int] = Field(None, description="Repository provider ID")
    domain: Optional[str] = Field(None, description="Git domain")
    branch: Optional[str] = Field(default="main", description="Git branch")

    model_config = ConfigDict(extra="forbid")


class ProjectModelSelection(BaseModel):
    """Default model selection for new project conversations."""

    modelName: str = Field(..., min_length=1, description="Selected model name")
    modelType: Optional[Literal["public", "user", "group"]] = Field(
        None, description="Selected model type"
    )
    options: dict[str, str] = Field(
        default_factory=dict,
        description="Model option values, such as reasoning effort.",
    )

    model_config = ConfigDict(extra="forbid")


class ProjectConfig(BaseModel):
    """Validated project configuration.

    Missing config or missing mode represents a legacy task-group project.
    """

    mode: Optional[Literal["workspace"]] = Field(
        None, description="Project mode. workspace means executable project."
    )
    device_id: Optional[str] = Field(None, description="Legacy bound local device ID")
    execution: Optional[ProjectExecutionConfig] = None
    team: Optional[ProjectTeamConfig] = None
    workspace: Optional[ProjectWorkspaceConfig] = None
    git: Optional[ProjectGitConfig] = None
    modelSelection: Optional[ProjectModelSelection] = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_workspace_project(self) -> "ProjectConfig":
        """Validate workspace project constraints (execution, git, paths)."""
        if self.mode != "workspace":
            return self

        if not self.execution:
            if not self.device_id:
                raise ValueError("execution is required for workspace projects")
            self.execution = ProjectExecutionConfig(
                targetType="local",
                deviceId=self.device_id,
            )

        # workspace config is optional — when absent, the executor uses a default path
        if not self.workspace:
            return self

        workspace = self.workspace
        if workspace.source == "git":
            if not self.git:
                raise ValueError("git config is required when workspace.source is git")
            if not workspace.checkoutPath:
                workspace_key = get_safe_git_workspace_key(
                    self.git.url,
                    domain=self.git.domain,
                    repo=self.git.repo,
                )
                workspace.checkoutPath = workspace_key
            if (
                self.execution.targetType == "cloud"
                and workspace.checkoutPath
                and posixpath.isabs(workspace.checkoutPath)
            ):
                raise ValueError("cloud git checkoutPath must be relative")
        elif workspace.source == "local_path":
            if self.execution.targetType != "local":
                raise ValueError("local_path source is only supported for local target")
            if not workspace.localPath:
                raise ValueError(
                    "workspace.localPath is required for local_path source"
                )
            if self.git:
                raise ValueError("git config must be empty for local_path source")

        return self

    @property
    def is_workspace(self) -> bool:
        """Return whether this config represents a workspace project."""

        return self.mode == "workspace"


class ProjectBase(BaseModel):
    """Base model for project data."""

    name: str = Field(..., min_length=1, max_length=100, description="Project name")
    description: str = Field(default="", description="Project description")
    color: Optional[str] = Field(
        None,
        max_length=20,
        description="Project color identifier (e.g., #FF5733)",
    )
    client_origin: str = Field(
        default=CLIENT_ORIGIN_FRONTEND,
        description="Client surface that owns this project",
    )
    config: Optional[ProjectConfig] = Field(
        None, description="Workspace project configuration"
    )

    @model_validator(mode="after")
    def validate_client_origin(self) -> "ProjectBase":
        """Validate project client origin."""
        if self.client_origin not in SUPPORTED_CLIENT_ORIGINS:
            raise ValueError("Unsupported client_origin")
        return self


class ProjectCreate(ProjectBase):
    """Request model for creating a project."""

    pass


class GitWorkspaceProjectCreate(BaseModel):
    """Request model for creating a Git-backed workspace project."""

    device_id: str = Field(..., min_length=1, description="Local device ID")
    git: ProjectGitConfig = Field(..., description="Git repository configuration")
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: str = Field(default="", description="Project description")
    color: Optional[str] = Field(None, max_length=20)
    client_origin: str = Field(default=CLIENT_ORIGIN_FRONTEND)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_client_origin(self) -> "GitWorkspaceProjectCreate":
        """Validate project client origin."""
        if self.client_origin not in SUPPORTED_CLIENT_ORIGINS:
            raise ValueError("Unsupported client_origin")
        return self


class ProjectUpdate(BaseModel):
    """Request model for updating a project."""

    name: Optional[str] = Field(
        None, min_length=1, max_length=100, description="Project name"
    )
    description: Optional[str] = Field(None, description="Project description")
    color: Optional[str] = Field(None, max_length=20, description="Project color")
    sort_order: Optional[int] = Field(None, description="Sort order for display")
    is_expanded: Optional[bool] = Field(
        None, description="Whether the project is expanded in UI"
    )
    config: Optional[ProjectConfig] = Field(
        None, description="Workspace project configuration"
    )


class ProjectResponse(ProjectBase):
    """Response model for a project."""

    id: int = Field(..., description="Project ID")
    user_id: int = Field(..., description="Project owner user ID")
    sort_order: int = Field(default=0, description="Sort order for display")
    is_expanded: bool = Field(
        default=True, description="Whether the project is expanded in UI"
    )
    task_count: int = Field(default=0, description="Number of tasks in the project")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        """Pydantic config."""

        from_attributes = True


class ProjectWithTasksResponse(ProjectResponse):
    """Response model for a project with its tasks."""

    tasks: list[ProjectTaskResponse] = Field(
        default_factory=list,
        description="Tasks in this project",
    )


class GitWorkspaceProjectResponse(BaseModel):
    """Response model for Git-backed workspace creation."""

    project: ProjectResponse
    checkout_path: str = Field(..., description="Relative checkout path")
    reused_existing_checkout: bool = Field(
        default=False, description="Whether an existing checkout was reused"
    )


class ProjectWorktreeProjectRef(BaseModel):
    """Matched project metadata for a scanned worktree directory."""

    id: int = Field(..., description="Project ID")
    name: str = Field(..., description="Project name")
    source_path: str = Field(..., description="Configured project source path")


class ProjectWorktreeTaskRef(BaseModel):
    """Matched task metadata for a scanned worktree directory."""

    id: int = Field(..., description="Task ID")
    title: str = Field(..., description="Task title")
    status: str = Field(..., description="Task status")
    project_id: int = Field(..., description="Project ID")


class ProjectWorktreeItem(BaseModel):
    """One worktree directory discovered on a device."""

    worktree_id: str = Field(..., description="Task ID worktree directory")
    project_name: str = Field(..., description="Project directory name in the worktree")
    path: str = Field(..., description="Absolute worktree path on the device")
    project: Optional[ProjectWorktreeProjectRef] = Field(
        None, description="Matched Wework project, if any"
    )
    task: Optional[ProjectWorktreeTaskRef] = Field(
        None, description="Matched task using this worktree, if any"
    )


class ProjectWorktreeDeviceGroup(BaseModel):
    """Worktree directories grouped by execution device."""

    device_id: str = Field(..., description="Device ID")
    device_name: str = Field(..., description="Device display name")
    device_status: str = Field(..., description="Device status")
    available: bool = Field(
        True, description="Whether worktree directories were readable"
    )
    error: Optional[str] = Field(None, description="Read failure message")
    items: list[ProjectWorktreeItem] = Field(default_factory=list)


class ProjectWorktreeListResponse(BaseModel):
    """Response model for Wework worktree settings."""

    devices: list[ProjectWorktreeDeviceGroup] = Field(default_factory=list)
    total: int = Field(..., description="Total discovered worktrees")


class ProjectWorktreeDeleteResponse(BaseModel):
    """Response model for deleting a project worktree."""

    worktree_id: str = Field(..., description="Deleted task ID worktree directory")
    path: str = Field(..., description="Deleted worktree path on the device")
    deleted_task_ids: list[int] = Field(
        default_factory=list,
        description="Task IDs soft-deleted with this worktree",
    )


class ProjectDeviceSessionResponse(BaseModel):
    """Response model for a project-scoped local device session."""

    session_id: str = Field(..., description="Session ID")
    project_id: int = Field(..., description="Project ID")
    device_id: str = Field(..., description="Bound local device ID")
    type: Literal["terminal", "code_server"] = Field(..., description="Session type")
    path: str = Field(..., description="Project path on the local device")
    url: str = Field(..., description="Browser URL for the interactive session")
    expires_at: Optional[datetime] = Field(
        None,
        description="Session expiration timestamp, if provided by the device",
    )


class ProjectListResponse(BaseModel):
    """Response model for project list with pagination."""

    total: int = Field(..., description="Total number of projects")
    items: list[ProjectWithTasksResponse] = Field(
        default_factory=list,
        description="List of projects",
    )


class AddTaskToProjectResponse(BaseModel):
    """Response model for adding a task to a project."""

    message: str = Field(default="Task added to project successfully")
    project_task: ProjectTaskResponse = Field(
        ..., description="The task that was added to the project"
    )


class RemoveTaskFromProjectResponse(BaseModel):
    """Response model for removing a task from a project."""

    message: str = Field(default="Task removed from project successfully")


class ProjectConversationCreate(BaseModel):
    """Create a new conversation under a workspace project."""

    prompt: str = Field(..., min_length=1, description="Initial user prompt")
    title: Optional[str] = Field(None, description="Conversation title")
    new_session: bool = Field(default=True, description="Start a new runtime session")


class ProjectConversationResponse(BaseModel):
    """Response for project conversation creation."""

    task_id: int = Field(..., description="Created Task ID")
    project_id: int = Field(..., description="Project ID")
    task: dict = Field(..., description="Created task payload")
