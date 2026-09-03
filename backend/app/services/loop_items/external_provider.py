# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitHub and GitLab Issue providers for backend-owned project spaces."""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import tempfile
import threading
import time
from concurrent.futures import Future
from datetime import datetime, timezone
from typing import Any, BinaryIO
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.provider_credentials import decrypt_provider_token
from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_value_is_unset
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.project_chat import LoopItemApproval, LoopItemAssign
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)
from app.services.delivery.storage import delivery_storage
from app.services.loop_item_executions.service import (
    execution_ai_state,
    execution_display_state,
    loop_item_execution_service,
)
from app.services.loop_items.assignment_notification import (
    notify_project_task_assignee,
)
from app.services.project_automation_domain import runnable_wegent_team

logger = logging.getLogger(__name__)

PRIORITY_PREFIX = "wegent:priority:"
STATUS_PREFIX = "wegent:status:"
CREATOR_PREFIX = "wegent:creator:"
ASSIGNEE_PREFIX = "wegent:assignee:"
PARENT_MARKER = "Wegent-Parent:"
EXTERNAL_BOARD_STATUSES = {
    "inbox",
    "pending",
    "in_progress",
    "in_review",
    "completed",
}
ISSUE_LIST_PAGE_SIZE = 100
ISSUE_PAGE_CACHE_SECONDS = 30
GITLAB_PROVIDER_UPLOAD_PATTERN = re.compile(
    r"(?P<image>!)?\[(?P<name>[^\]]+)\]\((?P<url>[^)]*/uploads/[^)]+)\)"
)
WEGENT_ATTACHMENT_PATTERN = re.compile(
    r"(?P<image>!)?\[(?P<name>[^\]]+)\]\((?P<url>[^)]+)\)"
    r"\s*<!--\s*wegent-attachment:(?P<id>gitlab-[A-Za-z0-9_-]+)\s*-->"
)
LEGACY_WEGENT_ATTACHMENT_PATTERN = re.compile(
    r"(?P<image>!)?\[(?P<name>[^\]]+)\]\(wegent://attachments/(?P<id>gitlab-[^)]+)\)"
)


class ExternalLoopItemProvider:
    def __init__(self) -> None:
        self._issue_page_cache: dict[
            tuple[int, int, int, str, str | None, int, int],
            tuple[float, list[dict[str, Any]]],
        ] = {}
        self._issue_page_inflight: dict[
            tuple[int, int, int, str, str | None, int, int],
            Future[list[dict[str, Any]]],
        ] = {}
        self._issue_page_cache_generation: dict[int, int] = {}
        self._issue_page_cache_lock = threading.Lock()
        self._http_client = httpx.Client(timeout=30)

    def close(self) -> None:
        self._http_client.close()

    def is_external_item(self, db: Session, item_id: str) -> bool:
        return self._find_project(db, item_id) is not None

    def list(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        *,
        assignee_type: str | None = None,
        assignee_id: str | None = None,
    ) -> list[dict[str, object]]:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.RestrictedAnalyst
        )
        project = access.project
        self._require_external(project)
        issues = self._list_issues(project)
        if assignee_type in {"user", "agent", "team"} and assignee_id:
            assignee_label = f"{ASSIGNEE_PREFIX}{assignee_type}:{assignee_id}"
            issues = [
                issue for issue in issues if assignee_label in self._labels(issue)
            ]
        return [
            self._response(
                db,
                project,
                issue,
                access,
                user_id,
                include_description=False,
            )
            for issue in issues
        ]

    def list_page(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        *,
        item_status: str,
        parent_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[dict[str, object]], str | None]:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.RestrictedAnalyst
        )
        project = access.project
        self._require_external(project)
        if item_status not in EXTERNAL_BOARD_STATUSES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Unsupported board status"
            )

        page = self._decode_page_cursor(cursor)
        batch = self._list_issue_page(
            project,
            item_status,
            parent_id,
            page,
            limit,
        )
        matched = (
            batch
            if project.task_provider == "gitlab"
            else [
                issue
                for issue in batch
                if self._issue_matches_page(
                    project,
                    issue,
                    item_status=item_status,
                    parent_id=parent_id,
                )
            ]
        )
        next_cursor = (
            self._encode_page_cursor(page + 1) if len(batch) == limit else None
        )

        logger.info(
            "[External board page] project_id=%s provider=%s status=%s "
            "cursor=%s page=%s limit=%s batch_count=%s batch_first_id=%s "
            "batch_last_id=%s returned_ids=%s next_cursor=%s",
            project.id,
            project.task_provider,
            item_status,
            cursor,
            page,
            limit,
            len(batch),
            self._number(batch[0]) if batch else None,
            self._number(batch[-1]) if batch else None,
            [self._number(issue) for issue in matched],
            next_cursor,
        )

        return (
            [
                self._response(
                    db,
                    project,
                    issue,
                    access,
                    user_id,
                    include_description=False,
                )
                for issue in matched
            ],
            next_cursor,
        )

    def _issue_matches_page(
        self,
        project: CloudProject,
        issue: dict[str, Any],
        *,
        item_status: str,
        parent_id: str | None,
    ) -> bool:
        labels = self._labels(issue)
        description = str(issue.get(self._body_key(project)) or "")
        return (
            self._status(labels, str(issue.get("state") or "")) == item_status
            and self._parent_id(project, description) == parent_id
            and "pull_request" not in issue
        )

    def get(self, db: Session, item_id: str, user_id: int) -> dict[str, object]:
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        response = self._response(db, project, issue, access, user_id)
        if not response["can_view_detail"]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return response

    def create(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        user_name: str,
        values: LoopItemCreate,
        *,
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
    ) -> dict[str, object]:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.RestrictedAnalyst
        )
        project = access.project
        self._require_external(project)
        if not access.is_public_visitor and not has_permission(
            access.role, BaseRole.Reporter
        ):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        assignee_label = self._assignee_label_for_values(
            db, project, values, user_id=user_id
        )
        labels = self._labels_for_write(
            values.tags + [f"{CREATOR_PREFIX}{user_id}:{self._safe_name(user_name)}"],
            values.priority,
            values.status,
            assignee=assignee_label,
        )
        issue = self._create_issue(
            project,
            values.title,
            self._with_parent(values.description, values.parent_id),
            labels,
        )
        self._invalidate_issue_page_cache(project.id)
        item_id = f"{project.project_key}-{self._number(issue)}"
        if values.assignee_agent_id:
            agent = db.get(ProjectChatAgent, values.assignee_agent_id)
            if agent is None:  # Already validated while building the label.
                raise RuntimeError("Validated project robot is unavailable")
            self._ensure_index_row(
                db,
                item_id=item_id,
                project=project,
                assignee_type="agent",
                assignee_id=agent.id,
                assignee_name=agent.title or agent.name,
                user_id=user_id,
            )
            self._create_execution_for_agent(
                db,
                item_id=item_id,
                project=project,
                agent=agent,
                user_id=user_id,
                priority=values.priority,
                automation_context=automation_context,
                instruction=instruction,
            )
            db.commit()
        elif values.assignee_team_id:
            team = runnable_wegent_team(db, user_id, values.assignee_team_id)
            self._ensure_index_row(
                db,
                item_id=item_id,
                project=project,
                assignee_type="team",
                assignee_id=str(team.id),
                assignee_name=team.name,
                user_id=user_id,
            )
            loop_item_execution_service.create_for_team_assignment(
                db,
                loop_item_id=item_id,
                cloud_project_id=str(project.id),
                team=team,
                assigner_user_id=user_id,
                priority=values.priority,
            )
            db.commit()
        return self._response(db, project, issue, access, user_id)

    def attach_gitlab_upload(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        filename: str,
        content_type: str,
        source: BinaryIO,
        max_size_bytes: int,
    ) -> dict[str, object] | None:
        project, number = self._resolve_project(db, item_id)
        if project.task_provider != "gitlab":
            return None
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        issue = self._get_issue(project, number)
        description = str(issue.get("description") or "")
        if filename in description:
            attachment = next(
                (
                    attachment
                    for attachment in self._gitlab_attachments(project, item_id, issue)
                    if attachment["display_name"] == filename
                ),
                None,
            )
            if attachment is not None and "wegent://attachments/" in description:
                native_markdown = (
                    f"[{filename}]({self._decode_attachment_id(str(attachment['id']))[1]})\n"
                    f"<!-- wegent-attachment:{attachment['id']} -->"
                )
                description = LEGACY_WEGENT_ATTACHMENT_PATTERN.sub(
                    lambda match: (
                        native_markdown
                        if match.group("id") == attachment["id"]
                        else match.group(0)
                    ),
                    description,
                )
                self._update_issue(project, number, {"description": description})
                attachment["markdown"] = native_markdown
            if attachment is not None:
                self._store_external_attachment(
                    str(attachment["id"]), source, max_size_bytes
                )
            return attachment

        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                length += len(chunk)
                if length > max_size_bytes:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "Feedback bundle is too large",
                    )
                staged.write(chunk)
            staged.seek(0)
            uploaded = self._request(
                project,
                "POST",
                f"/projects/{quote(self._repository(project), safe='')}/uploads",
                files={"file": (filename, staged, content_type)},
            )
            provider_markdown = str(uploaded.get("markdown") or "").strip()
            if not provider_markdown:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "GitLab upload did not return an attachment link",
                )
            url = str(uploaded.get("full_path") or uploaded.get("url") or "")
            if not url:
                match = GITLAB_PROVIDER_UPLOAD_PATTERN.search(provider_markdown)
                url = match.group("url") if match else ""
            attachment = self._gitlab_attachment_values(
                project,
                item_id,
                filename,
                url,
                content_type,
                length,
                user_id,
                str(issue.get("updated_at") or self._now()),
            )
            markdown = (
                f"{provider_markdown}\n"
                f"<!-- wegent-attachment:{attachment['id']} -->"
            )
            attachment["markdown"] = markdown
            self._update_issue(
                project,
                number,
                {"description": f"{description.rstrip()}\n\n{markdown}".strip()},
            )
            staged.seek(0)
            self._store_external_attachment(
                str(attachment["id"]), staged, max_size_bytes
            )
        return attachment

    def list_attachments(
        self, db: Session, item_id: str, user_id: int
    ) -> list[dict[str, object]]:
        project, number = self._resolve_project(db, item_id)
        if project.task_provider != "gitlab":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Attachments are not supported by this Issue provider",
            )
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        return self._gitlab_attachments(
            project, item_id, self._get_issue(project, number)
        )

    def add_attachment(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        filename: str,
        content_type: str,
        source: BinaryIO,
        max_size_bytes: int,
    ) -> dict[str, object]:
        attachment = self.attach_gitlab_upload(
            db,
            item_id,
            user_id,
            filename,
            content_type,
            source,
            max_size_bytes,
        )
        if attachment is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Attachments are not supported by this Issue provider",
            )
        return attachment

    def attachment_access_url(
        self, db: Session, attachment_id: str, user_id: int
    ) -> str:
        item_id, url = self._decode_attachment_id(attachment_id)
        project, _ = self._resolve_project(db, item_id)
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        if project.task_provider != "gitlab":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO attachment not found")
        return self._absolute_gitlab_url(project, url)

    def attachment_content(
        self, db: Session, attachment_id: str, user_id: int
    ) -> tuple[bytes, str, str]:
        item_id, url = self._decode_attachment_id(attachment_id)
        project, _ = self._resolve_project(db, item_id)
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        try:
            content = delivery_storage.get_bytes(
                self._external_attachment_key(attachment_id)
            )
        except Exception as exc:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Provider attachment is not available in unified storage",
            ) from exc
        filename = url.rstrip("/").rsplit("/", 1)[-1] or "attachment"
        return content, "application/octet-stream", filename

    def delete_attachment(self, db: Session, attachment_id: str, user_id: int) -> None:
        item_id, url = self._decode_attachment_id(attachment_id)
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        response = self._response(db, project, issue, access, user_id)
        if not response["can_edit"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        description = str(issue.get("description") or "")
        updated = description
        for pattern in (WEGENT_ATTACHMENT_PATTERN, LEGACY_WEGENT_ATTACHMENT_PATTERN):
            updated = pattern.sub(
                lambda match: (
                    "" if match.group("id") == attachment_id else match.group(0)
                ),
                updated,
            )
        updated = updated.strip()
        self._update_issue(project, number, {"description": updated})
        delivery_storage.remove_objects([self._external_attachment_key(attachment_id)])

    @staticmethod
    def _external_attachment_key(attachment_id: str) -> str:
        digest = hashlib.sha256(attachment_id.encode()).hexdigest()
        return f"loop-items/external-attachments/{digest}"

    def _store_external_attachment(
        self, attachment_id: str, source: BinaryIO, max_size_bytes: int
    ) -> None:
        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                length += len(chunk)
                if length > max_size_bytes:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "TODO attachment is too large",
                    )
                staged.write(chunk)
            staged.seek(0)
            delivery_storage.put_stream(
                self._external_attachment_key(attachment_id),
                staged,
                length,
                "application/octet-stream",
            )

    def _gitlab_attachments(
        self, project: CloudProject, item_id: str, issue: dict[str, Any]
    ) -> list[dict[str, object]]:
        description = str(issue.get("description") or "")
        created_at = str(
            issue.get("updated_at") or issue.get("created_at") or self._now()
        )
        creator_id = self._creator_id(self._labels(issue))
        attachments = []
        matches = list(WEGENT_ATTACHMENT_PATTERN.finditer(description))
        matches.extend(LEGACY_WEGENT_ATTACHMENT_PATTERN.finditer(description))
        for match in matches:
            attachment_id = match.group("id")
            encoded_item_id, url = self._decode_attachment_id(attachment_id)
            if encoded_item_id != item_id:
                continue
            values = self._gitlab_attachment_values(
                project,
                item_id,
                match.group("name"),
                url,
                "image/*" if match.group("image") else None,
                0,
                creator_id,
                created_at,
            )
            values["markdown"] = match.group(0)
            attachments.append(values)
        return attachments

    def _gitlab_attachment_values(
        self,
        project: CloudProject,
        item_id: str,
        filename: str,
        url: str,
        content_type: str | None,
        size_bytes: int,
        user_id: int,
        created_at: str,
    ) -> dict[str, object]:
        raw_id = (
            base64.urlsafe_b64encode(f"{item_id}\n{url}".encode()).decode().rstrip("=")
        )
        return {
            "id": f"gitlab-{raw_id}",
            "loop_item_id": item_id,
            "display_name": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "sha256": hashlib.sha256(url.encode()).hexdigest(),
            "created_by_user_id": user_id,
            "created_at": created_at,
        }

    @staticmethod
    def _decode_attachment_id(attachment_id: str) -> tuple[str, str]:
        if not attachment_id.startswith("gitlab-"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO attachment not found")
        encoded = attachment_id.removeprefix("gitlab-")
        try:
            value = base64.urlsafe_b64decode(
                encoded + "=" * (-len(encoded) % 4)
            ).decode()
            item_id, url = value.split("\n", 1)
        except (ValueError, UnicodeError) as exc:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "TODO attachment not found"
            ) from exc
        return item_id, url

    def _absolute_gitlab_url(self, project: CloudProject, url: str) -> str:
        if url.startswith(("https://", "http://")):
            return url
        config, _ = self._config(project)
        domain = str(config.get("domain") or "gitlab.com").rstrip("/")
        return f"https://{domain}/{url.lstrip('/')}"

    def update(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        values: LoopItemUpdate,
    ) -> dict[str, object]:
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        current = self._get_issue(project, number)
        current_response = self._response(db, project, current, access, user_id)
        if not current_response["can_edit"]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        payload: dict[str, object] = {}
        dumped = values.model_dump(exclude_unset=True)
        if "title" in dumped:
            payload["title"] = values.title
        if "description" in dumped or "parent_id" in dumped:
            description = (
                values.description
                if "description" in dumped
                else str(current_response["description"])
            )
            parent_id = (
                values.parent_id
                if "parent_id" in dumped
                else current_response["parent_id"]
            )
            payload[self._body_key(project)] = self._with_parent(
                description or "", parent_id
            )
        assignee_change = {
            "assignee_user_id",
            "assignee_agent_id",
            "assignee_team_id",
        } & dumped.keys()
        label_change = {"tags", "priority", "status"} & dumped.keys()
        if label_change or assignee_change:
            tags = (
                list(values.tags)
                if values.tags is not None
                else list(current_response["tags"])
            )
            creator = self._creator_label(self._labels(current))
            if creator:
                tags.append(creator)
            if assignee_change:
                assignee_label = self._assignee_label_for_values(
                    db, project, values, user_id=user_id
                )
            else:
                current_assignee = self._assignee_from_labels(self._labels(current))
                assignee_label = (
                    self._assignee_label(
                        current_assignee["type"],
                        current_assignee["id"],
                        current_assignee["name"],
                    )
                    if current_assignee
                    else None
                )
            payload["labels"] = self._labels_for_write(
                tags,
                values.priority or str(current_response["priority"]),
                values.status or str(current_response["status"]),
                assignee=assignee_label,
            )
        if "status" in dumped:
            payload["state"] = self._open_state(project)
        issue = current if not payload else self._update_issue(project, number, payload)
        if payload:
            self._invalidate_issue_page_cache(project.id)
        if assignee_change:
            self._apply_assignee_executions(
                db,
                item_id=item_id,
                project=project,
                user_id=user_id,
                values=values,
                priority=str(current_response["priority"]),
            )
        return self._response(db, project, issue, access, user_id)

    def archive(self, db: Session, item_id: str, user_id: int) -> None:
        """Remove an external issue from the board by closing it upstream."""

        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        response = self._base_response(db, project, issue, access, user_id)
        if not response["can_edit"]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        self._update_issue(project, number, {"state": "closed"})
        self._invalidate_issue_page_cache(project.id)

    def _assignee_label_for_values(
        self,
        db: Session,
        project: CloudProject,
        values: LoopItemUpdate,
        *,
        user_id: int,
    ) -> str | None:
        """Build the assignee label requested by a task update (None = unassign)."""

        if values.assignee_agent_id:
            agent = db.get(ProjectChatAgent, values.assignee_agent_id)
            if (
                agent is None
                or agent.cloud_project_id != str(project.id)
                or agent.status != "active"
            ):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Robot is not active in this project",
                )
            return self._assignee_label("agent", agent.id, agent.title or agent.name)
        if values.assignee_team_id:
            team = runnable_wegent_team(db, user_id, values.assignee_team_id)
            return self._assignee_label("team", str(team.id), team.name)
        if values.assignee_user_id:
            target = db.get(User, values.assignee_user_id)
            return self._assignee_label(
                "user",
                str(values.assignee_user_id),
                target.user_name if target else None,
            )
        return None

    @staticmethod
    def _cancel_active_executions(
        db: Session,
        item_id: str,
        *,
        preserve_automation_run_id: str = "",
    ) -> list:
        """Cancel any active runs of one issue (assignee changed/unassigned).

        Returns the runs that were cancelled and already handed to a device so
        callers can ask the executor to stop them after the change commits.
        """

        cancelled_runs = []
        active = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == item_id,
                LoopItemExecution.status.in_(
                    {
                        "pending_approval",
                        "queued",
                        "claimed",
                        "running",
                        "cancel_requested",
                    }
                ),
            )
            .all()
        )
        for execution in active:
            if (
                preserve_automation_run_id
                and execution.executor_type == "automation_manager"
                and str(execution.automation_run_id or "") == preserve_automation_run_id
            ):
                continue
            cancelled = loop_item_execution_service.cancel(
                db,
                execution_id=execution.id,
                note="Assignee changed before the run finished",
                commit=False,
            )
            if (
                cancelled.status == "cancel_requested"
                and cancelled.runtime_device_id
                and cancelled.runtime_task_id
            ) or (cancelled.team_id and cancelled.backend_task_id):
                cancelled_runs.append(cancelled)
        return cancelled_runs

    def _apply_assignee_executions(
        self,
        db: Session,
        *,
        item_id: str,
        project: CloudProject,
        user_id: int,
        values: LoopItemUpdate,
        priority: str,
    ) -> None:
        """Recreate queue state for an assignee change made through update."""

        cancelled_runs = self._cancel_active_executions(db, item_id)
        if values.assignee_agent_id:
            agent = db.get(ProjectChatAgent, values.assignee_agent_id)
            if agent is not None:
                self._ensure_index_row(
                    db,
                    item_id=item_id,
                    project=project,
                    assignee_type="agent",
                    assignee_id=agent.id,
                    assignee_name=agent.title or agent.name,
                    user_id=user_id,
                )
                self._create_execution_for_agent(
                    db,
                    item_id=item_id,
                    project=project,
                    agent=agent,
                    user_id=user_id,
                    priority=priority,
                )
        elif values.assignee_team_id:
            team = runnable_wegent_team(db, user_id, values.assignee_team_id)
            self._ensure_index_row(
                db,
                item_id=item_id,
                project=project,
                assignee_type="team",
                assignee_id=str(team.id),
                assignee_name=team.name,
                user_id=user_id,
            )
            loop_item_execution_service.create_for_team_assignment(
                db,
                loop_item_id=item_id,
                cloud_project_id=str(project.id),
                team=team,
                assigner_user_id=user_id,
                priority=priority,
            )
        elif values.assignee_user_id:
            target = db.get(User, values.assignee_user_id)
            self._ensure_index_row(
                db,
                item_id=item_id,
                project=project,
                assignee_type="user",
                assignee_id=str(values.assignee_user_id),
                assignee_name=target.user_name if target else None,
                user_id=user_id,
            )
        else:
            self._soft_delete_index_row(db, item_id)
        db.commit()
        if cancelled_runs:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(cancelled_runs)

    def _create_execution_for_agent(
        self,
        db: Session,
        *,
        item_id: str,
        project: CloudProject,
        agent: ProjectChatAgent,
        user_id: int,
        priority: str,
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
    ) -> None:
        """Create the queue run row after assigning a robot to an issue."""

        from app.services.project_chat.service import bot_config

        config = bot_config(agent)
        loop_item_execution_service.create_for_assignment(
            db,
            loop_item_id=item_id,
            cloud_project_id=str(project.id),
            agent=agent,
            assigner_user_id=user_id,
            environment=str(config.get("execution_environment") or "local"),
            execution_device_id=(
                config.get("execution_device_id")
                if isinstance(config.get("execution_device_id"), str)
                else None
            ),
            priority=priority,
            automation_context=automation_context,
            instruction=instruction,
        )

    def assign(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        values: LoopItemAssign,
        *,
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
    ) -> dict[str, object]:
        """Assign an issue to a project member or robot.

        The assignment lives in an issue label; the local loop_items row is an
        index + Wegent-side metadata (assignee chain, AI state) that never
        holds task status. A robot assignment also creates a queue run.
        """

        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        if access.is_public_visitor:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        if not has_permission(access.role, BaseRole.Maintainer):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        current = self._get_issue(project, number)
        current_labels = self._labels(current)
        previous_assignee = self._assignee_from_labels(current_labels)
        agent: ProjectChatAgent | None = None
        team: Kind | None = None
        if values.assignee_type == "agent":
            agent = db.get(ProjectChatAgent, values.assignee_id)
            if (
                agent is None
                or agent.cloud_project_id != str(project.id)
                or agent.status != "active"
            ):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Robot is not active in this project",
                )
            assignee_label = self._assignee_label(
                "agent", agent.id, agent.title or agent.name
            )
            assignee_name = agent.title or agent.name
        elif values.assignee_type == "user":
            try:
                target_user_id = int(values.assignee_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "User assignee id must be numeric",
                ) from exc
            if target_user_id not in self._project_member_ids(db, project):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Assignee is not a member of this project",
                )
            target = db.get(User, target_user_id)
            assignee_label = self._assignee_label(
                "user",
                str(target_user_id),
                target.user_name if target else None,
            )
            assignee_name = target.user_name if target else None
        elif values.assignee_type == "team":
            try:
                target_team_id = int(values.assignee_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Team assignee id must be numeric",
                ) from exc
            team = runnable_wegent_team(db, user_id, target_team_id)
            assignee_label = self._assignee_label("team", str(team.id), team.name)
            assignee_name = team.name
        else:  # pragma: no cover - pydantic constrains assignee_type
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown assignee type"
            )
        issue = self._update_issue(
            project,
            number,
            {
                "labels": self._labels_for_write(
                    self._public_tags(current_labels),
                    self._priority(current_labels),
                    self._status(current_labels, str(current.get("state") or "")),
                    assignee=assignee_label,
                )
            },
        )
        self._ensure_index_row(
            db,
            item_id=item_id,
            project=project,
            assignee_type=values.assignee_type,
            assignee_id=(
                agent.id
                if values.assignee_type == "agent"
                else (
                    str(team.id)
                    if values.assignee_type == "team" and team is not None
                    else str(target_user_id)
                )
            ),
            assignee_name=assignee_name,
            user_id=user_id,
        )
        cancelled_runs = self._cancel_active_executions(
            db,
            item_id,
            preserve_automation_run_id=str(
                (automation_context or {}).get("run_id") or ""
            ),
        )
        if agent is not None:
            self._create_execution_for_agent(
                db,
                item_id=item_id,
                project=project,
                agent=agent,
                user_id=user_id,
                priority=self._priority(current_labels),
                automation_context=automation_context,
                instruction=instruction,
            )
        elif team is not None:
            loop_item_execution_service.create_for_team_assignment(
                db,
                loop_item_id=item_id,
                cloud_project_id=str(project.id),
                team=team,
                assigner_user_id=user_id,
                priority=self._priority(current_labels),
            )
        db.commit()
        if cancelled_runs:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(cancelled_runs)
        if (
            values.assignee_type == "user"
            and target_user_id != user_id
            and (
                previous_assignee is None
                or previous_assignee["type"] != "user"
                or previous_assignee["id"] != str(target_user_id)
            )
        ):
            assigner = db.get(User, user_id)
            notify_project_task_assignee(
                user_id=target_user_id,
                project_id=str(project.id),
                project_name=project.name or "",
                item_id=item_id,
                item_title=str(issue.get("title") or item_id),
                assigner_name=assigner.user_name if assigner else str(user_id),
            )
        return self._response(db, project, issue, access, user_id)

    def _ensure_index_row(
        self,
        db: Session,
        *,
        item_id: str,
        project: CloudProject,
        assignee_type: str,
        assignee_id: str,
        assignee_name: str | None,
        user_id: int,
    ) -> LoopItem:
        """Create or refresh the local index row of an assigned external task.

        The row carries the assignee reference, the assignment chain and AI
        state metadata; task status/title/priority stay in the provider.
        """

        from app.services.loop_items.service import loop_item_service

        row = db.get(LoopItem, item_id)
        if row is None:
            row = LoopItem(
                id=item_id,
                cloud_project_id=str(project.id),
                metadata_json={"external_index": True, "tags": []},
                version=1,
            )
            db.add(row)
        metadata = dict(row.metadata_json or {})
        metadata["external_index"] = True
        if assignee_type == "agent":
            row.assignee_agent_id = assignee_id
            row.assignee_team_id = None
            # Production MySQL stores unset user assignees as 0, not NULL.
            row.assignee_user_id = 0
            loop_item_service._write_assignment_change(
                metadata, user_id, "agent", assignee_id, assignee_name
            )
        elif assignee_type == "team":
            row.assignee_user_id = 0
            row.assignee_agent_id = ""
            row.assignee_team_id = int(assignee_id)
            loop_item_service._write_assignment_change(
                metadata, user_id, "team", assignee_id, assignee_name
            )
        else:
            row.assignee_user_id = int(assignee_id) if assignee_id else 0
            row.assignee_agent_id = ""
            row.assignee_team_id = None
            loop_item_service._write_assignment_change(
                metadata, user_id, "user", assignee_id or None, assignee_name
            )
        row.metadata_json = metadata
        return row

    @staticmethod
    def _soft_delete_index_row(db: Session, item_id: str) -> None:
        """Archive the index row when an external task is unassigned."""

        from app.services.loop_item_executions.service import utcnow

        row = db.get(LoopItem, item_id)
        if row is None:
            return
        row.deleted_at = utcnow()

    @staticmethod
    def _project_member_ids(db: Session, project: CloudProject) -> set[int]:
        member_ids: set[int] = set()
        if project.created_by_user_id:
            member_ids.add(project.created_by_user_id)
        rows = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == project.id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        for row in rows:
            try:
                member_ids.add(int(row.entity_id))
            except (TypeError, ValueError):
                continue
        return member_ids

    def approve_run(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        values: LoopItemApproval,
    ) -> dict[str, object]:
        execution = loop_item_execution_service.active_for_item(db, item_id=item_id)
        if execution is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Task is not assigned to a robot"
            )
        loop_item_execution_service.approve(
            db, execution_id=execution.id, user_id=user_id
        )
        # The executions service no longer commits; persist the approval here.
        db.commit()
        agent = db.get(ProjectChatAgent, execution.agent_id)
        if agent is not None and agent.created_by_user_id:
            from app.services.loop_item_executions.wake import wake_robot_creator

            wake_robot_creator(
                user_id=agent.created_by_user_id,
                project_id=str(project_id),
                agent_id=agent.id,
            )
        return self.get(db, item_id, user_id)

    def reject_run(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        values: LoopItemApproval,
    ) -> dict[str, object]:
        execution = loop_item_execution_service.active_for_item(db, item_id=item_id)
        if execution is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Task is not assigned to a robot"
            )
        loop_item_execution_service.reject(
            db,
            execution_id=execution.id,
            user_id=user_id,
            reason=values.reason,
        )
        # The executions service no longer commits; persist the rejection here.
        db.commit()
        return self.get(db, item_id, user_id)

    def task_view(self, db: Session, item_id: str, user_id: int) -> dict[str, object]:
        """Return current normalized task context for runtime materialization."""

        project, number = self._resolve_project(db, item_id)
        issue = self._get_issue(project, number)
        labels = self._labels(issue)
        raw_description = str(issue.get(self._body_key(project)) or "")
        description = "\n".join(
            line
            for line in raw_description.splitlines()
            if not line.strip().startswith(PARENT_MARKER)
        ).strip()
        assignee = self._assignee_from_labels(labels)
        assignee_user_id = None
        assignee_agent_id = None
        assignee_team_id = None
        if assignee is not None and assignee["type"] == "user":
            try:
                assignee_user_id = int(assignee["id"])
            except ValueError:
                pass
        elif assignee is not None and assignee["type"] == "agent":
            assignee_agent_id = assignee["id"]
        elif assignee is not None and assignee["type"] == "team":
            try:
                assignee_team_id = int(assignee["id"])
            except ValueError:
                pass
        return {
            "id": item_id,
            "cloud_project_id": str(project.id),
            "title": str(issue.get("title") or ""),
            "description": description,
            "status": self._status(labels, str(issue.get("state") or "")),
            "priority": self._priority(labels),
            "parent_id": self._parent_id(project, raw_description),
            "tags": self._public_tags(labels),
            "assignee_user_id": assignee_user_id,
            "assignee_agent_id": assignee_agent_id,
            "assignee_team_id": assignee_team_id,
        }

    def normalize_issue_payload(self, issue: dict[str, Any]) -> dict[str, Any]:
        """Map provider issue fields to the task fields used by automation rules."""

        normalized = dict(issue)
        labels = self._labels(issue)
        normalized["status"] = self._status(labels, str(issue.get("state") or ""))
        normalized["priority"] = self._priority(labels)
        normalized["tags"] = self._public_tags(labels)
        return normalized

    def ensure_shadow(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        """Create a local LoopItem row for legacy binding/delivery flows.

        Kept only for task bindings and feedback deliveries that still expect a
        local row; the execution/queue flow never creates one.
        """

        if not self.is_external_item(db, item_id):
            existing = db.get(LoopItem, item_id)
            if existing is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
            return existing
        existing = db.get(LoopItem, item_id)
        if existing is not None:
            return existing
        values = self.get(db, item_id, user_id)
        item = LoopItem(
            id=str(values["id"]),
            cloud_project_id=str(values["cloud_project_id"]),
            parent_id=values["parent_id"],
            title=str(values["title"]),
            description=str(values["description"]),
            sequence_number=int(values["sequence_number"]),
            created_by_user_id=int(values["created_by_user_id"]),
            assignee_user_id=values["assignee_user_id"],
            status=str(values["status"]),
            priority=str(values["priority"]),
            sort_order=int(values["sort_order"]),
            metadata_json={"tags": values["tags"], "external_shadow": True},
            version=int(values["version"]),
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    def add_comment(
        self, db: Session, item_id: str, user_id: int, body: str
    ) -> dict[str, object]:
        project, number = self._resolve_project(db, item_id)
        access = require_cloud_project_role(
            db, project.id, user_id, BaseRole.RestrictedAnalyst
        )
        issue = self._get_issue(project, number)
        if not self._permissions(
            access, self._creator_id(self._labels(issue)), user_id
        )[1]:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return self._create_comment(project, number, body)

    def _response(
        self,
        db: Session,
        project: CloudProject,
        issue: dict[str, Any],
        access: CloudProjectAccess,
        user_id: int,
        *,
        include_description: bool = True,
    ) -> dict[str, object]:
        """Provider view merged with the active Wegent-side execution run."""

        values = self._base_response(
            db,
            project,
            issue,
            access,
            user_id,
            include_description=include_description,
        )
        return self._with_execution_state(db, values, user_id)

    @staticmethod
    def _derived_version(updated_at: str) -> int:
        """A stable optimistic token derived from the issue's updated time."""

        try:
            parsed = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
            return int(parsed.timestamp())
        except (ValueError, TypeError):
            return 1

    def _base_response(
        self,
        db: Session,
        project: CloudProject,
        issue: dict[str, Any],
        access: CloudProjectAccess,
        user_id: int,
        *,
        include_description: bool = True,
    ) -> dict[str, object]:
        labels = self._labels(issue)
        creator_id = self._creator_id(labels)
        creator_name = self._creator_name(labels)
        can_view, can_edit = self._permissions(access, creator_id, user_id)
        number = self._number(issue)
        description = str(issue.get(self._body_key(project)) or "")
        parent_id = self._parent_id(project, description)
        description = "\n".join(
            line
            for line in description.splitlines()
            if not line.strip().startswith(PARENT_MARKER)
        ).strip()
        state = str(issue.get("state") or "")
        item_status = self._status(labels, state)
        created_at = str(issue.get("created_at") or self._now())
        updated_at = str(issue.get("updated_at") or created_at)
        assignee_user_id: int | None = None
        assignee_name: str | None = None
        assignee_agent_id: str | None = None
        assignee_agent_name: str | None = None
        assignee_team_id: int | None = None
        assignee_team_name: str | None = None
        assignee = self._assignee_from_labels(labels)
        if assignee is not None:
            if assignee["type"] == "user":
                try:
                    assignee_user_id = int(assignee["id"])
                except ValueError:
                    assignee_user_id = None
                assignee_name = assignee["name"] or None
                if assignee_name is None and assignee_user_id is not None:
                    target = db.get(User, assignee_user_id)
                    assignee_name = target.user_name if target else None
            elif assignee["type"] == "agent":
                assignee_agent_id = assignee["id"]
                assignee_agent_name = assignee["name"] or None
                if assignee_agent_name is None and assignee_agent_id:
                    agent = db.get(ProjectChatAgent, assignee_agent_id)
                    assignee_agent_name = (
                        agent.title or agent.name if agent is not None else None
                    )
            elif assignee["type"] == "team":
                try:
                    assignee_team_id = int(assignee["id"])
                except ValueError:
                    assignee_team_id = None
                assignee_team_name = assignee["name"] or None
                if assignee_team_name is None and assignee_team_id is not None:
                    team = db.get(Kind, assignee_team_id)
                    assignee_team_name = team.name if team is not None else None
        return {
            "id": f"{project.project_key}-{number}",
            "cloud_project_id": str(project.id),
            "sequence_number": number,
            "parent_id": parent_id,
            "title": str(issue.get("title") or ""),
            "description": description if can_view and include_description else "",
            "status": item_status,
            "assignee_user_id": assignee_user_id,
            "assignee_name": assignee_name,
            "assignee_agent_id": assignee_agent_id,
            "assignee_agent_name": assignee_agent_name,
            "assignee_team_id": assignee_team_id,
            "assignee_team_name": assignee_team_name,
            "priority": self._priority(labels),
            "due_at": None,
            "sort_order": number,
            "tags": self._public_tags(labels),
            "created_by_user_id": creator_id,
            "created_by_user_name": creator_name,
            "can_view_detail": can_view,
            "can_edit": can_edit,
            "detail_loaded": include_description,
            "current_delivery_id": None,
            "version": self._derived_version(updated_at),
            "created_at": created_at,
            "updated_at": updated_at,
            "completed_at": (
                str(issue.get("closed_at") or updated_at)
                if item_status == "completed"
                else None
            ),
        }

    def _with_execution_state(
        self,
        db: Session,
        values: dict[str, object],
        user_id: int,
    ) -> dict[str, object]:
        """Overlay the active run's queue/approval/AI state on the provider view."""

        execution = loop_item_execution_service.latest_for_item(
            db, item_id=str(values["id"])
        )
        if execution is None:
            return values
        merged = {**values}
        merged["execution_id"] = execution.id
        merged["execution_state"] = execution_display_state(execution)
        merged["execution_control_state"] = execution.status
        merged["execution_observed_state"] = execution.observed_state
        merged["execution_sync_state"] = execution.sync_state
        merged["execution_attempt_no"] = execution.attempt_no
        merged["execution_last_event_seq"] = execution.last_event_seq
        merged["queued_at"] = self._optional_dt(execution.queued_at)
        merged["execution_note"] = execution.execution_note or None
        merged["can_approve"] = self._execution_can_approve(
            db, execution=execution, user_id=user_id
        )
        merged["approval"] = self._execution_approval_view(execution)
        merged["ai_state"] = execution_ai_state(db, execution)
        merged["version"] = int(merged["version"]) + int(execution.id)
        return merged

    @staticmethod
    def _optional_dt(value: object) -> str | None:
        if value is None or loop_datetime_value_is_unset(value):
            return None
        return value.isoformat()

    @staticmethod
    def _execution_can_approve(db: Session, *, execution: object, user_id: int) -> bool:
        """Only the run's robot creator can approve a pending run."""

        if getattr(execution, "status", None) != "pending_approval":
            return False
        agent = db.get(ProjectChatAgent, getattr(execution, "agent_id", None))
        return agent is not None and agent.created_by_user_id == user_id

    @staticmethod
    def _execution_approval_view(execution: object) -> dict | None:
        """Project the execution approval fields into the task response shape."""

        status = getattr(execution, "approval_status", None)
        if not status:
            return None
        view: dict[str, object] = {"status": status}
        if status == "pending":
            view["requested_at"] = (
                getattr(execution, "queued_at", None).isoformat()
                if getattr(execution, "queued_at", None)
                else None
            )
        if status == "approved":
            view["approved_by_user_id"] = getattr(
                execution, "approved_by_user_id", None
            )
            view["approved_at"] = (
                getattr(execution, "approved_at", None).isoformat()
                if getattr(execution, "approved_at", None)
                else None
            )
        if status == "rejected":
            view["rejected_reason"] = getattr(execution, "rejected_reason", None)
        return view

    @staticmethod
    def _permissions(
        access: CloudProjectAccess, creator_id: int, user_id: int
    ) -> tuple[bool, bool]:
        if access.is_public_visitor:
            owns = creator_id > 0 and creator_id == user_id
            return owns, owns
        return True, has_permission(access.role, BaseRole.Developer)

    def _resolve_project(self, db: Session, item_id: str) -> tuple[CloudProject, int]:
        resolved = self._find_project(db, item_id)
        if resolved is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return resolved

    @staticmethod
    def _find_project(db: Session, item_id: str) -> tuple[CloudProject, int] | None:
        key, separator, raw_number = item_id.rpartition("-")
        if not separator or not raw_number.isdigit():
            return None
        project = db.query(CloudProject).filter(CloudProject.project_key == key).first()
        if project is None or project.task_provider not in {"github", "gitlab"}:
            return None
        return project, int(raw_number)

    @staticmethod
    def _require_external(project: CloudProject) -> None:
        if project.task_provider not in {"github", "gitlab"}:
            raise HTTPException(status.HTTP_409_CONFLICT, "Project is not external")

    def _config(self, project: CloudProject) -> tuple[dict[str, object], str]:
        metadata = (
            project.metadata_json if isinstance(project.metadata_json, dict) else {}
        )
        config = metadata.get("provider_config")
        config = config if isinstance(config, dict) else {}
        try:
            token = decrypt_provider_token(project.task_provider, config)
        except ValueError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        if not token:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Provider credential is not configured"
            )
        return config, token

    def _request(
        self,
        project: CloudProject,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, object] | None = None,
        files: dict[str, object] | None = None,
    ) -> Any:
        config, token = self._config(project)
        domain = str(
            config.get("domain")
            or ("github.com" if project.task_provider == "github" else "gitlab.com")
        )
        api_base = str(
            config.get("api_base")
            or (
                "https://api.github.com"
                if project.task_provider == "github"
                else f"https://{domain}/api/v4"
            )
        ).rstrip("/")
        headers = (
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            }
            if project.task_provider == "github"
            else {"PRIVATE-TOKEN": token}
        )
        try:
            response = self._http_client.request(
                method,
                f"{api_base}{path}",
                headers=headers,
                json=json,
                params=params,
                files=files,
            )
            response.raise_for_status()
            return response.json() if response.content else {}
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "TODO not found"
                ) from exc
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, f"Provider request failed: {exc}"
            ) from exc

    def _repository(self, project: CloudProject) -> str:
        config, _ = self._config(project)
        repository = str(config.get("repository") or "").strip().strip("/")
        if not repository:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Provider repository is required"
            )
        return repository

    def _list_issues(self, project: CloudProject) -> list[dict[str, Any]]:
        repository = self._repository(project)
        results: list[dict[str, Any]] = []
        for page in range(1, 101):
            path = (
                f"/repos/{repository}/issues"
                if project.task_provider == "github"
                else f"/projects/{quote(repository, safe='')}/issues"
            )
            batch = self._request(
                project,
                "GET",
                path,
                params={
                    "state": self._open_state(project),
                    "per_page": ISSUE_LIST_PAGE_SIZE,
                    "page": page,
                },
            )
            batch_size = len(batch)
            batch = [issue for issue in batch if issue.get("state") != "closed"]
            if project.task_provider == "github":
                batch = [issue for issue in batch if "pull_request" not in issue]
            results.extend(batch)
            if batch_size < ISSUE_LIST_PAGE_SIZE:
                break
        return results

    def _list_issue_page(
        self,
        project: CloudProject,
        item_status: str,
        parent_id: str | None,
        page: int,
        limit: int,
    ) -> list[dict[str, Any]]:
        now = time.monotonic()
        leader = False
        with self._issue_page_cache_lock:
            cache_key = (
                project.id,
                project.version,
                self._issue_page_cache_generation.get(project.id, 0),
                item_status,
                parent_id,
                page,
                limit,
            )
            cached = self._issue_page_cache.get(cache_key)
            if cached is not None and cached[0] > now:
                logger.info(
                    "[External board page cache] project_id=%s status=%s page=%s "
                    "cache_hit=true issue_count=%s",
                    project.id,
                    item_status,
                    page,
                    len(cached[1]),
                )
                return cached[1]
            future = self._issue_page_inflight.get(cache_key)
            if future is None:
                future = Future()
                self._issue_page_inflight[cache_key] = future
                leader = True

        if not leader:
            return future.result()

        try:
            batch = self._request_issue_page(
                project,
                item_status=item_status,
                parent_id=parent_id,
                page=page,
                limit=limit,
            )
            with self._issue_page_cache_lock:
                self._issue_page_cache = {
                    key: value
                    for key, value in self._issue_page_cache.items()
                    if value[0] > now
                }
                self._issue_page_cache[cache_key] = (
                    time.monotonic() + ISSUE_PAGE_CACHE_SECONDS,
                    batch,
                )
            future.set_result(batch)
            return batch
        except Exception as exc:
            future.set_exception(exc)
            raise
        finally:
            with self._issue_page_cache_lock:
                self._issue_page_inflight.pop(cache_key, None)

    def _request_issue_page(
        self,
        project: CloudProject,
        *,
        item_status: str,
        parent_id: str | None,
        page: int,
        limit: int,
    ) -> list[dict[str, Any]]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues"
        )
        labels = [f"{STATUS_PREFIX}{item_status}"]
        if project.task_provider == "github" and item_status == "pending":
            labels = []
        params: dict[str, object] = {
            "state": self._open_state(project),
            "per_page": limit,
            "page": page,
        }
        if labels:
            params["labels"] = ",".join(labels)
        if project.task_provider == "gitlab":
            if parent_id is None:
                params["not[search]"] = PARENT_MARKER
                params["not[in]"] = "description"
            else:
                params["search"] = f"{PARENT_MARKER} {parent_id}"
                params["in"] = "description"
        batch = self._request(project, "GET", path, params=params)
        logger.info(
            "[External board page cache] project_id=%s status=%s page=%s "
            "cache_hit=false issue_count=%s first_id=%s last_id=%s",
            project.id,
            item_status,
            page,
            len(batch),
            self._number(batch[0]) if batch else None,
            self._number(batch[-1]) if batch else None,
        )
        return batch

    def _invalidate_issue_page_cache(self, project_id: int) -> None:
        with self._issue_page_cache_lock:
            self._issue_page_cache_generation[project_id] = (
                self._issue_page_cache_generation.get(project_id, 0) + 1
            )
            self._issue_page_cache = {
                key: value
                for key, value in self._issue_page_cache.items()
                if key[0] != project_id
            }

    @staticmethod
    def _encode_page_cursor(page: int) -> str:
        raw = str(page).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @staticmethod
    def _decode_page_cursor(cursor: str | None) -> int:
        if not cursor:
            return 1
        try:
            page = int(
                base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
            )
        except (UnicodeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid page cursor"
            ) from exc
        if page < 1 or page > 100:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid page cursor"
            )
        return page

    def _get_issue(self, project: CloudProject, number: int) -> dict[str, Any]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues/{number}"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues/{number}"
        )
        return self._request(project, "GET", path)

    def _create_issue(
        self, project: CloudProject, title: str, body: str, labels: list[str]
    ) -> dict[str, Any]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues"
        )
        payload: dict[str, object] = {
            "title": title,
            self._body_key(project): body,
            "labels": labels if project.task_provider == "github" else ",".join(labels),
        }
        return self._request(project, "POST", path, json=payload)

    def _update_issue(
        self, project: CloudProject, number: int, payload: dict[str, object]
    ) -> dict[str, Any]:
        repository = self._repository(project)
        if project.task_provider == "gitlab":
            if isinstance(payload.get("labels"), list):
                payload["labels"] = ",".join(payload["labels"])
            if "state" in payload:
                payload["state_event"] = (
                    "close" if payload.pop("state") == "closed" else "reopen"
                )
        path = (
            f"/repos/{repository}/issues/{number}"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues/{number}"
        )
        return self._request(
            project,
            "PATCH" if project.task_provider == "github" else "PUT",
            path,
            json=payload,
        )

    def _create_comment(
        self, project: CloudProject, number: int, body: str
    ) -> dict[str, object]:
        repository = self._repository(project)
        path = (
            f"/repos/{repository}/issues/{number}/comments"
            if project.task_provider == "github"
            else f"/projects/{quote(repository, safe='')}/issues/{number}/notes"
        )
        response = self._request(
            project,
            "POST",
            path,
            json={"body": body},
        )
        return {
            "id": str(response.get("id") or ""),
            "body": str(response.get("body") or ""),
            "author": str(
                (response.get("user") or response.get("author") or {}).get(
                    "login" if project.task_provider == "github" else "username"
                )
                or ""
            ),
            "web_url": response.get("html_url") or response.get("web_url"),
            "created_at": str(response.get("created_at") or self._now()),
            "updated_at": str(
                response.get("updated_at") or response.get("created_at") or self._now()
            ),
        }

    @staticmethod
    def _number(issue: dict[str, Any]) -> int:
        return int(issue.get("number") or issue.get("iid") or 0)

    @staticmethod
    def _labels(issue: dict[str, Any]) -> list[str]:
        labels = issue.get("labels") or []
        return [
            str(
                (label.get("name") or label.get("title") or "")
                if isinstance(label, dict)
                else label
            )
            for label in labels
        ]

    @staticmethod
    def _creator_label(labels: list[str]) -> str | None:
        return next(
            (label for label in labels if label.startswith(CREATOR_PREFIX)), None
        )

    @classmethod
    def _creator_id(cls, labels: list[str]) -> int:
        label = cls._creator_label(labels)
        if not label:
            return 0
        try:
            return int(label.removeprefix(CREATOR_PREFIX).split(":", 1)[0])
        except ValueError:
            return 0

    @classmethod
    def _creator_name(cls, labels: list[str]) -> str | None:
        label = cls._creator_label(labels)
        if not label:
            return None
        parts = label.removeprefix(CREATOR_PREFIX).split(":", 1)
        return parts[1].strip() if len(parts) == 2 and parts[1].strip() else None

    @staticmethod
    def _assignee_label(kind: str, assignee_id: str, name: str | None) -> str:
        # Keep the label short: GitHub rejects label names longer than 50
        # characters. The assignee name is resolved from local records.
        return f"{ASSIGNEE_PREFIX}{kind}:{assignee_id}"

    @classmethod
    def _assignee_from_labels(cls, labels: list[str]) -> dict[str, str] | None:
        label = next(
            (
                candidate
                for candidate in labels
                if candidate.startswith(ASSIGNEE_PREFIX)
            ),
            None,
        )
        if label is None:
            return None
        parts = label.removeprefix(ASSIGNEE_PREFIX).split(":", 2)
        if len(parts) < 2 or parts[0] not in {"user", "agent", "team"} or not parts[1]:
            return None
        return {
            "type": parts[0],
            "id": parts[1],
            "name": parts[2].strip() if len(parts) == 3 and parts[2].strip() else "",
        }

    @staticmethod
    def _public_tags(labels: list[str]) -> list[str]:
        return [
            label
            for label in labels
            if not label.startswith(
                (PRIORITY_PREFIX, STATUS_PREFIX, CREATOR_PREFIX, ASSIGNEE_PREFIX)
            )
        ]

    @staticmethod
    def _labels_for_write(
        tags: list[str],
        priority: str,
        item_status: str,
        assignee: str | None = None,
    ) -> list[str]:
        labels = [
            tag
            for tag in tags
            if not tag.startswith((PRIORITY_PREFIX, STATUS_PREFIX, ASSIGNEE_PREFIX))
        ]
        if priority != "none":
            labels.append(f"{PRIORITY_PREFIX}{priority}")
        labels.append(f"{STATUS_PREFIX}{item_status}")
        if assignee:
            labels.append(assignee)
        return list(dict.fromkeys(labels))

    @staticmethod
    def _status(labels: list[str], provider_state: str) -> str:
        value = next(
            (
                label.removeprefix(STATUS_PREFIX)
                for label in labels
                if label.startswith(STATUS_PREFIX)
            ),
            "pending",
        )
        return (
            value
            if value in {"inbox", "pending", "in_progress", "in_review", "completed"}
            else "pending"
        )

    @staticmethod
    def _priority(labels: list[str]) -> str:
        value = next(
            (
                label.removeprefix(PRIORITY_PREFIX)
                for label in labels
                if label.startswith(PRIORITY_PREFIX)
            ),
            "none",
        )
        return value if value in {"low", "medium", "high", "urgent"} else "none"

    @staticmethod
    def _body_key(project: CloudProject) -> str:
        return "body" if project.task_provider == "github" else "description"

    @staticmethod
    def _open_state(project: CloudProject) -> str:
        return "open" if project.task_provider == "github" else "opened"

    @staticmethod
    def _with_parent(description: str, parent_id: str | None) -> str:
        content = "\n".join(
            line
            for line in description.splitlines()
            if not line.strip().startswith(PARENT_MARKER)
        ).rstrip()
        return (
            f"{content}\n\n{PARENT_MARKER} {parent_id}".strip()
            if parent_id
            else content
        )

    @staticmethod
    def _parent_id(project: CloudProject, description: str) -> str | None:
        for line in description.splitlines():
            if line.strip().startswith(PARENT_MARKER):
                raw = line.strip().removeprefix(PARENT_MARKER).strip()
                if raw.isdigit():
                    return f"{project.project_key}-{raw}"
                if raw:
                    return raw
        return None

    @staticmethod
    def _safe_name(name: str) -> str:
        return name.replace(":", " ").replace(",", " ").strip()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()


external_loop_item_provider = ExternalLoopItemProvider()
