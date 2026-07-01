# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Attachment synchronization protocol shared by backend and executor_manager."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

AttachmentSyncStatus = Literal["success", "failed"]


@dataclass
class AttachmentSyncItem:
    """One attachment in a sync request or response."""

    id: int
    original_filename: str = "attachment"
    status: Optional[AttachmentSyncStatus] = None
    local_path: Optional[str] = None
    error: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: Optional[int] = None
    subtask_id: Optional[int] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AttachmentSyncItem":
        """Build an item from common snake_case or camelCase payloads."""
        return cls(
            id=int(data.get("id") or 0),
            original_filename=(
                data.get("original_filename")
                or data.get("originalFilename")
                or data.get("filename")
                or data.get("name")
                or "attachment"
            ),
            status=data.get("status"),
            local_path=data.get("local_path") or data.get("localPath"),
            error=data.get("error"),
            mime_type=data.get("mime_type") or data.get("mimeType"),
            file_size=data.get("file_size") or data.get("fileSize"),
            subtask_id=data.get("subtask_id") or data.get("subtaskId"),
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize and omit None fields."""
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass
class AttachmentSyncRequest:
    """Payload used to prepare attachments in an executor runtime."""

    task_id: int
    subtask_id: int
    attachments: list[AttachmentSyncItem] = field(default_factory=list)
    user_subtask_id: Optional[int] = None
    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None
    executor_type: Optional[str] = None
    auth_token: str = ""
    backend_url: str = ""
    skill_identity_token: str = ""
    workspace: dict[str, Any] = field(default_factory=dict)
    project_id: Optional[int] = None
    project_workspace_path: Optional[str] = None
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_domain: Optional[str] = None
    git_repo_id: Optional[int] = None
    branch_name: Optional[str] = None
    user: dict[str, Any] = field(default_factory=dict)
    bot: Any = field(default_factory=list)
    executor_image: Optional[str] = None
    callback_url: Optional[str] = None
    mode: Optional[str] = None
    subtask_next_id: Optional[int] = None
    subtask_title: Optional[str] = None
    task_title: Optional[str] = None
    type: Optional[str] = None

    @classmethod
    def from_execution_request(
        cls, request: Any, attachments: Optional[list[dict[str, Any]]] = None
    ) -> "AttachmentSyncRequest":
        """Build a sync request from an ExecutionRequest-like object."""
        raw_attachments = (
            attachments if attachments is not None else request.attachments
        )
        return cls(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            user_subtask_id=request.user_subtask_id,
            executor_name=request.executor_name,
            executor_namespace=request.executor_namespace,
            executor_type=request.executor_type,
            auth_token=request.auth_token,
            backend_url=request.backend_url,
            skill_identity_token=request.skill_identity_token,
            workspace=request.workspace or {},
            project_id=request.project_id,
            project_workspace_path=request.project_workspace_path,
            git_url=request.git_url,
            git_repo=request.git_repo,
            git_domain=request.git_domain,
            git_repo_id=request.git_repo_id,
            branch_name=request.branch_name,
            user=request.user or {},
            bot=request.bot or [],
            executor_image=request.executor_image,
            callback_url=request.callback_url,
            mode=request.mode,
            subtask_next_id=request.subtask_next_id,
            subtask_title=request.subtask_title,
            task_title=request.task_title,
            type=request.type,
            attachments=[
                AttachmentSyncItem.from_dict(item)
                for item in (raw_attachments or [])
                if isinstance(item, dict)
            ],
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AttachmentSyncRequest":
        """Build a sync request from JSON data."""
        return cls(
            task_id=int(data.get("task_id") or 0),
            subtask_id=int(data.get("subtask_id") or 0),
            user_subtask_id=data.get("user_subtask_id") or data.get("userSubtaskId"),
            executor_name=data.get("executor_name") or data.get("executorName"),
            executor_namespace=data.get("executor_namespace")
            or data.get("executorNamespace"),
            executor_type=data.get("executor_type") or data.get("executorType"),
            auth_token=data.get("auth_token") or data.get("authToken") or "",
            backend_url=data.get("backend_url") or data.get("backendUrl") or "",
            skill_identity_token=data.get("skill_identity_token")
            or data.get("skillIdentityToken")
            or "",
            workspace=data.get("workspace") or {},
            project_id=data.get("project_id") or data.get("projectId"),
            project_workspace_path=data.get("project_workspace_path")
            or data.get("projectWorkspacePath"),
            git_url=data.get("git_url") or data.get("gitUrl"),
            git_repo=data.get("git_repo") or data.get("gitRepo"),
            git_domain=data.get("git_domain") or data.get("gitDomain"),
            git_repo_id=data.get("git_repo_id") or data.get("gitRepoId"),
            branch_name=data.get("branch_name") or data.get("branchName"),
            user=data.get("user") or {},
            bot=data.get("bot") or [],
            executor_image=data.get("executor_image") or data.get("executorImage"),
            callback_url=data.get("callback_url") or data.get("callbackUrl"),
            mode=data.get("mode"),
            subtask_next_id=data.get("subtask_next_id") or data.get("subtaskNextId"),
            subtask_title=data.get("subtask_title") or data.get("subtaskTitle"),
            task_title=data.get("task_title") or data.get("taskTitle"),
            type=data.get("type"),
            attachments=[
                AttachmentSyncItem.from_dict(item)
                for item in (data.get("attachments") or [])
                if isinstance(item, dict)
            ],
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize request for JSON transport."""
        data = asdict(self)
        data["attachments"] = [item.to_dict() for item in self.attachments]
        return {key: value for key, value in data.items() if value is not None}


@dataclass
class AttachmentSyncResponse:
    """Executor response for attachment synchronization."""

    task_id: int
    subtask_id: int
    attachments: list[AttachmentSyncItem] = field(default_factory=list)
    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None

    @classmethod
    def failed_for_request(
        cls, request: AttachmentSyncRequest, error: str
    ) -> "AttachmentSyncResponse":
        """Build a response that marks every requested attachment as failed."""
        return cls(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            executor_name=request.executor_name,
            executor_namespace=request.executor_namespace,
            attachments=[
                AttachmentSyncItem(
                    id=item.id,
                    original_filename=item.original_filename,
                    status="failed",
                    error=error,
                    mime_type=item.mime_type,
                    file_size=item.file_size,
                    subtask_id=item.subtask_id,
                )
                for item in request.attachments
            ],
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AttachmentSyncResponse":
        """Build a response from JSON data."""
        return cls(
            task_id=int(data.get("task_id") or 0),
            subtask_id=int(data.get("subtask_id") or 0),
            executor_name=data.get("executor_name") or data.get("executorName"),
            executor_namespace=data.get("executor_namespace")
            or data.get("executorNamespace"),
            attachments=[
                AttachmentSyncItem.from_dict(item)
                for item in (data.get("attachments") or [])
                if isinstance(item, dict)
            ],
        )

    @property
    def success_count(self) -> int:
        """Number of successfully prepared attachments."""
        return sum(1 for item in self.attachments if item.status == "success")

    @property
    def failed_count(self) -> int:
        """Number of failed attachments."""
        return sum(1 for item in self.attachments if item.status == "failed")

    def to_dict(self) -> dict[str, Any]:
        """Serialize response for JSON transport."""
        return {
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "executor_name": self.executor_name,
            "executor_namespace": self.executor_namespace,
            "attachments": [item.to_dict() for item in self.attachments],
            "success_count": self.success_count,
            "failed_count": self.failed_count,
        }
