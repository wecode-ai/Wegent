# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cloud TODO lifecycle and runtime Task associations."""

from __future__ import annotations

import hashlib
import logging
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Any, BinaryIO

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.cloud_project import (
    CloudProject,
    LoopItemTaskBinding,
)
from app.models.delivery import (
    LoopItem,
    LoopItemAttachment,
    LoopItemCollaborator,
    ProjectChatAgent,
    adapt_loop_node_values_for_dialect,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
    loop_node_non_nullable_attributes,
)
from app.models.kind import Kind
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.delivery import (
    LoopItemCreate,
    LoopItemReorder,
    LoopItemTaskBind,
    LoopItemUpdate,
)
from app.schemas.issue_workflow import ProjectWorkflowDefinition, instantiate_workflow
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
from app.services.loop_item_executions.wake import wake_robot_creator
from app.services.loop_item_status_history import (
    STATUS_HISTORY_KEY,
    project_board_statuses,
    write_status_change,
)
from app.services.loop_item_unread import (
    advance_content_revision,
    content_revision,
    initialize_content_revision,
    is_unread,
    mark_loop_item_read,
)
from app.services.loop_items.assignment_notification import (
    notify_project_task_assignee,
)
from app.services.project_automation_domain import runnable_wegent_team
from app.services.project_chat.service import ProjectChatService, bot_config
from app.stores.tasks import task_store

TASK_AI_STATE_KEY = "ai_state"
ASSIGNMENT_HISTORY_KEY = "assignment_history"

logger = logging.getLogger(__name__)


class LoopItemService:
    @staticmethod
    def _project_status_ids(project: CloudProject) -> list[str]:
        return [status_id for status_id, _ in project_board_statuses(project)]

    def _require_internal_task_project(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        required_role: BaseRole = BaseRole.Reporter,
        *,
        allow_public_visitor: bool = False,
    ) -> CloudProjectAccess:
        access = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        if access.is_public_visitor:
            if not allow_public_visitor:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN, "Insufficient permission"
                )
        elif not has_permission(access.role, required_role):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        project = access.project
        if project.task_provider != "local":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                (
                    f"Project tasks are provided by {project.task_provider}; "
                    "use the local Issue provider"
                ),
            )
        return access

    @staticmethod
    def _item_permissions(
        access: CloudProjectAccess, item: LoopItem, user_id: int
    ) -> tuple[bool, bool]:
        if access.is_public_visitor:
            owns_item = item.created_by_user_id == user_id
            return owns_item, owns_item
        return True, has_permission(access.role, BaseRole.Developer)

    def response_values(
        self,
        db: Session,
        item: LoopItem,
        user_id: int,
        access: CloudProjectAccess | None = None,
    ) -> dict[str, object]:
        access = access or require_cloud_project_role(
            db, item.cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        can_view_detail, can_edit = self._item_permissions(access, item, user_id)
        values = {
            **item.__dict__,
            "can_view_detail": can_view_detail,
            "can_edit": can_edit,
        }
        if item.assignee_user_id:
            assignee = db.get(User, item.assignee_user_id)
            values["assignee_name"] = assignee.user_name if assignee else None
        if item.assignee_agent_id:
            agent = db.get(ProjectChatAgent, item.assignee_agent_id)
            values["assignee_agent_name"] = agent.name if agent else None
        if item.assignee_team_id:
            team = db.get(Kind, item.assignee_team_id)
            values["assignee_team_name"] = team.name if team else None
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        values["content_revision"] = content_revision(metadata)
        values["is_unread"] = is_unread(metadata, user_id)
        automation = metadata.get("automation")
        values["automation"] = automation if isinstance(automation, dict) else None
        ai_state = metadata.get(TASK_AI_STATE_KEY)
        values["ai_state"] = self._present_cached_ai_state(db, item, ai_state)
        assignment_history = metadata.get(ASSIGNMENT_HISTORY_KEY)
        values["assignment_history"] = (
            assignment_history if isinstance(assignment_history, list) else []
        )
        status_history = metadata.get(STATUS_HISTORY_KEY)
        values["status_history"] = (
            status_history if isinstance(status_history, list) else []
        )
        # Surface the newest run even after it ends, so a terminal failure is
        # visible to the UI instead of silently disappearing from the task.
        execution = loop_item_execution_service.latest_for_item(db, item_id=item.id)
        values["execution_id"] = execution.id if execution else None
        values["execution_state"] = (
            execution_display_state(execution) if execution else None
        )
        values["execution_control_state"] = execution.status if execution else None
        values["execution_observed_state"] = (
            execution.observed_state if execution else None
        )
        values["execution_sync_state"] = execution.sync_state if execution else None
        values["execution_attempt_no"] = execution.attempt_no if execution else None
        values["execution_last_event_seq"] = (
            execution.last_event_seq if execution else None
        )
        values["queued_at"] = execution.queued_at if execution else None
        values["execution_note"] = (
            execution.execution_note or None if execution else None
        )
        values["execution_error"] = (
            execution.error_message or None if execution else None
        )
        values["can_approve"] = self._can_approve_run(
            db, item=item, execution=execution, user_id=user_id
        )
        values["approval"] = self._approval_view(execution)
        if execution is not None:
            values["ai_state"] = execution_ai_state(
                db,
                execution,
                existing=values["ai_state"],
            )
        projected_ai_state = values["ai_state"]
        if isinstance(projected_ai_state, dict):
            logger.info(
                "[LoopItem] Response includes task AI state: "
                "project_id=%s task_id=%s task_status=%s ai_status=%s "
                "message_id=%s runtime_device_id=%s runtime_task_id=%s "
                "lease_expires_at=%s",
                item.cloud_project_id,
                item.id,
                item.status,
                projected_ai_state.get("status"),
                projected_ai_state.get("project_chat_message_id"),
                projected_ai_state.get("runtime_device_id"),
                projected_ai_state.get("runtime_task_id"),
                projected_ai_state.get("lease_expires_at"),
            )
        if not can_view_detail:
            values["description"] = ""
        return values

    def _present_cached_ai_state(
        self,
        db: Session,
        item: LoopItem,
        ai_state: object,
    ) -> dict[str, object] | None:
        """Return a read-only presentation for legacy task AI metadata."""

        if not isinstance(ai_state, dict):
            return None
        state: dict[str, object] = dict(ai_state)
        normalized = str(state.get("status") or "").lower()
        terminal = {
            "completed": "succeeded",
            "success": "succeeded",
            "succeeded": "succeeded",
            "error": "failed",
            "failed": "failed",
            "failure": "failed",
            "interrupted": "failed",
            "canceled": "cancelled",
            "cancelled": "cancelled",
        }.get(normalized)
        if terminal is not None:
            state["status"] = terminal
            return state

        message_id = state.get("project_chat_message_id")
        message = None
        if isinstance(message_id, str) and message_id:
            message = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.message_id == message_id,
                    ProjectChatMessage.task_id == item.id,
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .first()
            )
        if message is not None and message.status in {"completed", "failed"}:
            state["status"] = "succeeded" if message.status == "completed" else "failed"
            state["lease_expires_at"] = None
            state["completed_at"] = message.updated_at.isoformat()
            state["updated_at"] = message.updated_at.isoformat()
            if message.status == "failed" and message.content:
                state["last_error"] = message.content[:10_000]
            return state

        lease_expires_at = state.get("lease_expires_at")
        parsed_expiry = (
            self._parse_ai_state_datetime(lease_expires_at)
            if isinstance(lease_expires_at, str)
            else None
        )
        if message is None or parsed_expiry is None or parsed_expiry < self._now():
            state["status"] = "unknown"
            state["sync_state"] = "stale"
        return state

    @staticmethod
    def _loop_unset_datetime(db: Session) -> object:
        values = adapt_loop_node_values_for_dialect(
            {"completed_at": None}, db.get_bind().dialect.name
        )
        return values["completed_at"]

    @staticmethod
    def _parse_ai_state_datetime(value: str) -> datetime | None:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed

    def _get_item_row(
        self, db: Session, item_id: str, *, include_deleted: bool = False
    ) -> LoopItem:
        query = db.query(LoopItem).filter(LoopItem.id == item_id)
        if not include_deleted:
            query = query.filter(loop_datetime_is_unset(LoopItem.deleted_at))
        item = query.first()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return item

    def _require_item_access(
        self,
        db: Session,
        item: LoopItem,
        user_id: int,
        *,
        edit: bool = False,
    ) -> CloudProjectAccess:
        access = require_cloud_project_role(
            db, item.cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        can_view_detail, can_edit = self._item_permissions(access, item, user_id)
        if edit and not can_edit:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        if not edit and not can_view_detail:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return access

    def ensure_collaborator(
        self,
        db: Session,
        item: LoopItem,
        collaborator_user_id: int,
        added_by_user_id: int,
        source: str,
        *,
        commit: bool = True,
    ) -> LoopItemCollaborator:
        """Ensure one project member participates in a TODO."""

        require_cloud_project_role(
            db,
            item.cloud_project_id,
            collaborator_user_id,
            BaseRole.RestrictedAnalyst,
        )
        collaborator = (
            db.query(LoopItemCollaborator)
            .filter(
                LoopItemCollaborator.loop_item_id == item.id,
                LoopItemCollaborator.user_id == collaborator_user_id,
            )
            .first()
        )
        if collaborator is None:
            collaborator = LoopItemCollaborator(
                loop_item_id=item.id,
                user_id=collaborator_user_id,
                source=source,
                added_by_user_id=added_by_user_id,
            )
            db.add(collaborator)
            if commit:
                db.commit()
                db.refresh(collaborator)
        return collaborator

    def list_collaborators(
        self, db: Session, item_id: str, user_id: int
    ) -> list[dict[str, object]]:
        self.get(db, item_id, user_id)
        rows = (
            db.query(LoopItemCollaborator, User)
            .join(User, User.id == LoopItemCollaborator.user_id)
            .filter(LoopItemCollaborator.loop_item_id == item_id)
            .order_by(LoopItemCollaborator.created_at, LoopItemCollaborator.id)
            .all()
        )
        return [
            {
                **collaborator.__dict__,
                "user_name": collaborator_user.user_name,
                "email": collaborator_user.email,
            }
            for collaborator, collaborator_user in rows
        ]

    def add_collaborator(
        self, db: Session, item_id: str, collaborator_user_id: int, user_id: int
    ) -> dict[str, object]:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        self.ensure_collaborator(db, item, collaborator_user_id, user_id, "manual")
        return next(
            row
            for row in self.list_collaborators(db, item_id, user_id)
            if row["user_id"] == collaborator_user_id
        )

    def remove_collaborator(
        self, db: Session, item_id: str, collaborator_user_id: int, user_id: int
    ) -> None:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        collaborator = (
            db.query(LoopItemCollaborator)
            .filter(
                LoopItemCollaborator.loop_item_id == item_id,
                LoopItemCollaborator.user_id == collaborator_user_id,
            )
            .first()
        )
        if collaborator is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Collaborator not found")
        db.delete(collaborator)
        db.commit()

    def create(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: LoopItemCreate,
        *,
        commit: bool = True,
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
        assign_creator_if_unassigned: bool = True,
    ) -> LoopItem:
        self._require_internal_task_project(
            db,
            cloud_project_id,
            user_id,
            BaseRole.Developer,
            allow_public_visitor=True,
        )
        if values.parent_id is not None:
            self._require_parent(db, values.parent_id, cloud_project_id)
        project = (
            db.query(CloudProject)
            .filter(CloudProject.id == cloud_project_id)
            .with_for_update()
            .one()
        )
        sequence = project.next_item_number
        project.next_item_number += 1
        payload = values.model_dump()
        tags = payload.pop("tags")
        explicit_workflow = values.workflow
        payload.pop("workflow", None)
        agent_id = payload.get("assignee_agent_id")
        team_id = payload.get("assignee_team_id")
        payload["assignee_agent_id"] = agent_id or ""
        task_metadata: dict = {}
        if explicit_workflow is not None:
            task_metadata["workflow"] = explicit_workflow.model_dump()
        elif values.parent_id is None:
            project_metadata = (
                project.metadata_json if isinstance(project.metadata_json, dict) else {}
            )
            raw_definition = project_metadata.get("workflow_definition")
            if isinstance(raw_definition, dict):
                definition = ProjectWorkflowDefinition.model_validate(raw_definition)
                if (
                    definition.stage_mode == "dag"
                    or definition.advancement_policy == "ai"
                ):
                    task_metadata["workflow"] = instantiate_workflow(
                        definition
                    ).model_dump()
        if automation_context is not None:
            task_metadata["automation"] = {
                **automation_context,
                **({"prompt": instruction} if instruction is not None else {}),
            }
        if agent_id:
            agent = db.get(ProjectChatAgent, agent_id)
            if (
                agent is None
                or str(agent.cloud_project_id) != str(cloud_project_id)
                or agent.status != "active"
            ):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "AI assignee is not active in this project",
                )
            payload["assignee_user_id"] = None
            payload["assignee_team_id"] = None
            self._write_assignment_change(
                task_metadata,
                user_id,
                "agent",
                agent.id,
                agent.title or agent.name,
            )
        elif team_id:
            team = runnable_wegent_team(db, user_id, team_id)
            payload["assignee_user_id"] = None
            payload["assignee_agent_id"] = ""
            self._write_assignment_change(
                task_metadata,
                user_id,
                "team",
                str(team.id),
                team.name,
            )
        elif payload.get("assignee_user_id") is None and assign_creator_if_unassigned:
            payload["assignee_user_id"] = user_id
            self._write_assignment_change(
                task_metadata,
                user_id,
                "user",
                str(user_id),
                None,
            )
        elif payload.get("assignee_user_id"):
            self._write_assignment_change(
                task_metadata,
                user_id,
                "user",
                str(payload["assignee_user_id"]),
                None,
            )
        configured_statuses = self._project_status_ids(project)
        requested_status = payload.get("status")
        if requested_status is None:
            payload["status"] = configured_statuses[0] if configured_statuses else ""
        elif requested_status not in configured_statuses:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown board status"
            )
        if payload["status"]:
            write_status_change(
                task_metadata,
                project=project,
                from_status="",
                to_status=payload["status"],
                trigger="create",
                by_user_id=user_id,
            )
        task_metadata = initialize_content_revision(task_metadata, user_id)
        item = LoopItem(
            id=f"{project.project_key}-{sequence}",
            cloud_project_id=project.id,
            sequence_number=sequence,
            created_by_user_id=user_id,
            metadata_json=task_metadata or None,
            **payload,
        )
        if tags:
            item.metadata_json = {**task_metadata, "tags": tags}
        if item.status == "completed":
            item.completed_at = self._now()
        db.add(item)
        if agent_id:
            db.flush()
            agent = db.get(ProjectChatAgent, agent_id)
            if agent is not None:
                config = bot_config(agent)
                loop_item_execution_service.create_for_assignment(
                    db,
                    loop_item_id=item.id,
                    cloud_project_id=item.cloud_project_id,
                    agent=agent,
                    assigner_user_id=user_id,
                    environment=str(config.get("execution_environment") or "local"),
                    execution_device_id=(
                        config.get("execution_device_id")
                        if isinstance(config.get("execution_device_id"), str)
                        else None
                    ),
                    priority=item.priority,
                    automation_context=automation_context,
                    instruction=instruction,
                )
        elif team_id:
            db.flush()
            team = db.get(Kind, team_id)
            if team is not None:
                loop_item_execution_service.create_for_team_assignment(
                    db,
                    loop_item_id=item.id,
                    cloud_project_id=item.cloud_project_id,
                    team=team,
                    assigner_user_id=user_id,
                    priority=item.priority,
                )
        if commit:
            db.commit()
            db.refresh(item)
        else:
            db.flush()
        return item

    def list(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        *,
        assignee_type: str | None = None,
        assignee_id: str | None = None,
        execution_state: str | None = None,
    ) -> list[LoopItem]:
        self._require_internal_task_project(
            db, cloud_project_id, user_id, allow_public_visitor=True
        )
        query = db.query(LoopItem).filter(
            LoopItem.cloud_project_id == cloud_project_id,
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        if assignee_type == "user" and assignee_id:
            try:
                assignee_user_id = int(assignee_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "User assignee id must be numeric",
                ) from exc
            query = query.filter(LoopItem.assignee_user_id == assignee_user_id)
        elif assignee_type == "agent" and assignee_id:
            query = query.filter(LoopItem.assignee_agent_id == assignee_id)
        elif assignee_type == "team" and assignee_id:
            try:
                assignee_team_id = int(assignee_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Team assignee id must be numeric",
                ) from exc
            query = query.filter(LoopItem.assignee_team_id == assignee_team_id)
        if execution_state:
            from app.models.loop_item_execution import LoopItemExecution

            query = query.filter(
                LoopItem.id.in_(
                    select(LoopItemExecution.loop_item_id).where(
                        LoopItemExecution.status == execution_state
                    )
                )
            )
        return query.order_by(LoopItem.sort_order, LoopItem.updated_at.desc()).all()

    def reorder(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: LoopItemReorder,
    ) -> list[LoopItem]:
        """Persist the manual order of the TODOs in one board lane."""

        self._require_internal_task_project(
            db, cloud_project_id, user_id, BaseRole.Developer
        )
        if values.parent_id is None:
            # MySQL stores unset parent ids as empty strings, so match both.
            parent_filter = or_(LoopItem.parent_id.is_(None), LoopItem.parent_id == "")
        else:
            parent_filter = LoopItem.parent_id == values.parent_id
        lane = (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id == cloud_project_id,
                LoopItem.status == values.status,
                parent_filter,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .order_by(LoopItem.sort_order, LoopItem.updated_at.desc())
            .all()
        )
        by_id = {item.id: item for item in lane}
        requested_ids = [item_id for item_id in values.item_ids if item_id in by_id]
        if not requested_ids:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "TODO not found in lane"
            )
        # Lane members missing from the request (e.g. created concurrently)
        # keep their relative order at the end of the lane.
        ordered = [by_id[item_id] for item_id in requested_ids] + [
            item for item in lane if item.id not in requested_ids
        ]
        for position, item in enumerate(ordered):
            if item.sort_order != position:
                item.sort_order = position
                item.version += 1
        db.commit()
        for item in ordered:
            db.refresh(item)
        return ordered

    def get(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        item = self._get_item_row(db, item_id)
        self._require_item_access(db, item, user_id)
        return item

    def list_attachments(
        self, db: Session, item_id: str, user_id: int
    ) -> list[LoopItemAttachment]:
        self.get(db, item_id, user_id)
        return (
            db.query(LoopItemAttachment)
            .filter(LoopItemAttachment.loop_item_id == item_id)
            .order_by(LoopItemAttachment.created_at.desc())
            .all()
        )

    def add_attachment(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        display_name: str,
        content_type: str,
        source: BinaryIO,
    ) -> LoopItemAttachment:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")

        return self._store_attachment(
            db,
            item,
            project,
            user_id,
            display_name,
            content_type,
            source,
            settings.DELIVERY_MAX_ASSET_SIZE_MB,
        )

    def has_attachment(self, db: Session, item_id: str, display_name: str) -> bool:
        return (
            db.query(LoopItemAttachment)
            .filter(
                LoopItemAttachment.loop_item_id == item_id,
                LoopItemAttachment.display_name == display_name,
            )
            .first()
            is not None
        )

    def add_feedback_attachment(
        self,
        db: Session,
        item: LoopItem,
        user_id: int,
        display_name: str,
        content_type: str,
        source: BinaryIO,
    ) -> LoopItemAttachment:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        if item.created_by_user_id != user_id or not metadata.get("feedback_report_id"):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Invalid feedback attachment"
            )
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        return self._store_attachment(
            db,
            item,
            project,
            user_id,
            display_name,
            content_type,
            source,
            settings.WEWORK_FEEDBACK_MAX_BUNDLE_SIZE_MB,
        )

    @staticmethod
    def _store_attachment(
        db: Session,
        item: LoopItem,
        project: CloudProject,
        user_id: int,
        display_name: str,
        content_type: str,
        source: BinaryIO,
        max_size_mb: int,
    ) -> LoopItemAttachment:

        attachment_id = str(uuid.uuid4())
        object_key = (
            f"projects/{project.public_id}/loop-items/{item.id}/attachments/"
            f"{attachment_id}"
        )
        digest = hashlib.sha256()
        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                staged.write(chunk)
                length += len(chunk)
                if length > max_size_mb * 1024 * 1024:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "TODO attachment is too large",
                    )
            staged.seek(0)
            delivery_storage.put_stream(object_key, staged, length, content_type)

        attachment = LoopItemAttachment(
            id=attachment_id,
            loop_item_id=item.id,
            display_name=display_name[:255],
            object_key=object_key,
            content_type=content_type,
            size_bytes=length,
            sha256=digest.hexdigest(),
            created_by_user_id=user_id,
        )
        try:
            db.add(attachment)
            db.commit()
            db.refresh(attachment)
            return attachment
        except Exception:
            db.rollback()
            delivery_storage.remove_objects([object_key])
            raise

    def attachment_access_url(
        self, db: Session, attachment_id: str, user_id: int
    ) -> str:
        attachment = self._get_attachment(db, attachment_id, user_id)
        return delivery_storage.download_url(attachment.object_key)

    def attachment_content(
        self, db: Session, attachment_id: str, user_id: int
    ) -> tuple[bytes, str, str]:
        attachment = self._get_attachment(db, attachment_id, user_id)
        return (
            delivery_storage.get_bytes(attachment.object_key),
            attachment.content_type or "application/octet-stream",
            attachment.display_name,
        )

    def require_attachment_access(
        self, db: Session, attachment_id: str, user_id: int
    ) -> None:
        self._get_attachment(db, attachment_id, user_id)

    def delete_attachment(self, db: Session, attachment_id: str, user_id: int) -> None:
        attachment = self._get_attachment(db, attachment_id, user_id)
        item = self.get(db, attachment.loop_item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        delivery_storage.remove_objects([attachment.object_key])
        db.delete(attachment)
        db.commit()

    def _get_attachment(
        self, db: Session, attachment_id: str, user_id: int
    ) -> LoopItemAttachment:
        attachment = db.get(LoopItemAttachment, attachment_id)
        if attachment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO attachment not found")
        self.get(db, attachment.loop_item_id, user_id)
        return attachment

    def update(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        values: LoopItemUpdate,
    ) -> LoopItem:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        updates = values.model_dump(exclude={"version"}, exclude_unset=True)
        meaningful_change = any(
            field in values.model_fields_set
            and (
                field in {"tags", "workflow"}
                or getattr(item, field, None) != getattr(values, field)
            )
            for field in (
                "title",
                "description",
                "status",
                "assignee_user_id",
                "assignee_agent_id",
                "assignee_team_id",
                "priority",
                "due_at",
                "parent_id",
                "tags",
                "workflow",
            )
        )
        if "assignee_team_id" in values.model_fields_set:
            team_id = values.assignee_team_id
            if team_id:
                runnable_wegent_team(db, user_id, team_id)
                updates["assignee_user_id"] = None
                updates["assignee_agent_id"] = ""
        elif "assignee_agent_id" in values.model_fields_set:
            agent_id = values.assignee_agent_id
            updates["assignee_agent_id"] = agent_id or ""
            if agent_id:
                agent = db.get(ProjectChatAgent, agent_id)
                if (
                    agent is None
                    or agent.cloud_project_id != item.cloud_project_id
                    or agent.status != "active"
                ):
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                        "AI assignee is not active in this project",
                    )
                updates["assignee_user_id"] = None
                updates["assignee_team_id"] = None
        elif "assignee_user_id" in values.model_fields_set and values.assignee_user_id:
            updates["assignee_agent_id"] = ""
            updates["assignee_team_id"] = None
        if "parent_id" in values.model_fields_set:
            self._validate_parent_change(db, item, values.parent_id)
        if "tags" in values.model_fields_set or "workflow" in values.model_fields_set:
            # Tags live inside the metadata JSON column; merge so other
            # metadata keys survive the update.
            metadata = dict(item.metadata_json or {})
            if "tags" in values.model_fields_set:
                metadata["tags"] = updates.pop("tags") or []
            if "workflow" in values.model_fields_set:
                workflow = values.workflow
                metadata["workflow"] = (
                    workflow.model_dump(mode="json") if workflow is not None else None
                )
                updates.pop("workflow", None)
            updates["metadata_json"] = metadata
        cancelled_runs: list = []
        assignee_changed = (
            "assignee_agent_id" in values.model_fields_set
            or "assignee_user_id" in values.model_fields_set
            or "assignee_team_id" in values.model_fields_set
        )
        if assignee_changed:
            # Legacy assignment path: record the chain and derive the queue
            # state on the task itself so every queue view stays a projection
            # of assigned-but-not-completed tasks instead of a stored entity.
            metadata = dict(item.metadata_json or {})
            if isinstance(updates.get("metadata_json"), dict):
                metadata = dict(updates["metadata_json"])
            if updates.get("assignee_team_id"):
                target_type = "team"
                target_id = str(updates["assignee_team_id"])
            elif updates.get("assignee_agent_id"):
                target_type = "agent"
                target_id = str(updates["assignee_agent_id"])
            else:
                target_type = "user"
                target_id = (
                    str(updates["assignee_user_id"])
                    if updates.get("assignee_user_id")
                    else None
                )
            if target_id is None:
                self._write_assignment_change(metadata, user_id, None, None, None)
            elif target_type == "agent":
                agent = db.get(ProjectChatAgent, target_id)
                self._write_assignment_change(
                    metadata,
                    user_id,
                    "agent",
                    target_id,
                    agent.title or agent.name if agent is not None else None,
                )
            elif target_type == "team":
                team = db.get(Kind, int(target_id))
                self._write_assignment_change(
                    metadata,
                    user_id,
                    "team",
                    target_id,
                    team.name if team is not None else None,
                )
            else:
                self._write_assignment_change(
                    metadata,
                    user_id,
                    "user",
                    target_id,
                    None,
                )
            updates["metadata_json"] = metadata
            cancelled_runs = self._sync_execution_for_assignment(
                db,
                item=item,
                user_id=user_id,
                target_type=target_type,
                target_id=target_id,
                agent=(
                    db.get(ProjectChatAgent, target_id)
                    if target_type == "agent"
                    else None
                ),
                team=(
                    db.get(Kind, int(target_id))
                    if target_type == "team" and target_id is not None
                    else None
                ),
                priority=item.priority,
            )
        next_status = updates.get("status")
        if "status" in values.model_fields_set and next_status is not None:
            project = db.get(CloudProject, item.cloud_project_id)
            if project is None or next_status not in self._project_status_ids(project):
                if next_status != "":
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown board status"
                    )
        if "status" in values.model_fields_set and updates.get("status") != item.status:
            project = db.get(CloudProject, item.cloud_project_id)
            if project is not None:
                metadata = updates.get("metadata_json")
                if not isinstance(metadata, dict):
                    metadata = dict(item.metadata_json or {})
                write_status_change(
                    metadata,
                    project=project,
                    from_status=item.status,
                    to_status=updates["status"] or "",
                    trigger="user_update",
                    by_user_id=user_id,
                )
                updates["metadata_json"] = metadata
        if next_status and next_status != item.status:
            updates["completed_at"] = (
                self._now() if next_status == "completed" else None
            )
            # Reset the manual lane position so the TODO lands at the top of
            # its new lane instead of an arbitrary stale position.
            updates["sort_order"] = 0
        if meaningful_change:
            metadata = updates.get("metadata_json")
            if not isinstance(metadata, dict):
                metadata = dict(item.metadata_json or {})
            updates["metadata_json"] = advance_content_revision(
                metadata, actor_user_id=user_id
            )
        updates = adapt_loop_node_values_for_dialect(
            updates,
            db.get_bind().dialect.name,
            loop_node_non_nullable_attributes(db.connection()),
        )
        updated = (
            db.query(LoopItem)
            .filter(LoopItem.id == item.id, LoopItem.version == values.version)
            .update({**updates, "version": LoopItem.version + 1})
        )
        if updated != 1:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO changed")
        db.commit()
        db.refresh(item)
        if cancelled_runs:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(cancelled_runs)
        return item

    def mark_read(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        item = self.get(db, item_id, user_id)
        mark_loop_item_read(db, item_id=item.id, user_id=user_id)
        db.commit()
        db.expire(item)
        db.refresh(item)
        return item

    def assign(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        values: LoopItemAssign,
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
    ) -> LoopItem:
        """Assign a task to a project member, project robot, or Wegent Team.

        The task itself records who assigned it to whom (the chain) and the
        derived execution state. There is no separate queue storage: a task
        assigned to someone and not completed is simply part of that target's
        queue.
        """

        access = self._require_internal_task_project(
            db, project_id, user_id, BaseRole.Maintainer
        )
        project = access.project
        item = self.get(db, item_id, user_id)
        if item.cloud_project_id != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        previous_assignee_user_id = item.assignee_user_id
        metadata = dict(item.metadata_json or {})
        if values.assignee_type == "agent":
            agent = db.get(ProjectChatAgent, values.assignee_id)
            if (
                agent is None
                or agent.cloud_project_id != str(project_id)
                or agent.status != "active"
            ):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Robot is not active in this project",
                )
            access = require_cloud_project_role(
                db, project_id, user_id, BaseRole.Reporter
            )
            if not self._agent_visible_to_user(agent, user_id, access.role):
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "Robot is not visible to you",
                )
            assignee_updates = {
                "assignee_agent_id": agent.id,
                "assignee_user_id": None,
                "assignee_team_id": None,
            }
            self._write_assignment_change(
                metadata,
                user_id,
                "agent",
                agent.id,
                agent.title or agent.name,
            )
            cancelled_runs = self._sync_execution_for_assignment(
                db,
                item=item,
                user_id=user_id,
                target_type="agent",
                target_id=agent.id,
                agent=agent,
                team=None,
                priority=item.priority,
                automation_context=automation_context,
                instruction=instruction,
            )
        elif values.assignee_type == "user":
            try:
                target_user_id = int(values.assignee_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "User assignee id must be numeric",
                ) from exc
            member_ids = self._project_member_ids(db, project_id)
            if target_user_id not in member_ids:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Assignee is not a member of this project",
                )
            assignee_updates = {
                "assignee_user_id": target_user_id,
                "assignee_agent_id": "",
                "assignee_team_id": None,
            }
            target = db.get(User, target_user_id)
            self._write_assignment_change(
                metadata,
                user_id,
                "user",
                str(target_user_id),
                target.user_name if target else None,
            )
            cancelled_runs = self._sync_execution_for_assignment(
                db,
                item=item,
                user_id=user_id,
                target_type="user",
                target_id=str(target_user_id),
                agent=None,
                team=None,
                priority=item.priority,
                automation_context=automation_context,
                instruction=instruction,
            )
        elif values.assignee_type == "team":
            try:
                target_team_id = int(values.assignee_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Team assignee id must be numeric",
                ) from exc
            team = runnable_wegent_team(db, user_id, target_team_id)
            assignee_updates = {
                "assignee_user_id": None,
                "assignee_agent_id": "",
                "assignee_team_id": team.id,
            }
            self._write_assignment_change(
                metadata,
                user_id,
                "team",
                str(team.id),
                team.name,
            )
            cancelled_runs = self._sync_execution_for_assignment(
                db,
                item=item,
                user_id=user_id,
                target_type="team",
                target_id=str(team.id),
                agent=None,
                team=team,
                priority=item.priority,
                automation_context=automation_context,
                instruction=instruction,
            )
        else:  # pragma: no cover - pydantic constrains assignee_type
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown assignee type"
            )

        metadata = advance_content_revision(metadata, actor_user_id=user_id)
        updated = self._versioned_metadata_update(
            db, item, values.version, metadata, **assignee_updates
        )
        if cancelled_runs:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(cancelled_runs)
        if values.assignee_type == "agent":
            agent = db.get(ProjectChatAgent, values.assignee_id)
            if agent is not None and agent.created_by_user_id:
                wake_robot_creator(
                    user_id=agent.created_by_user_id,
                    project_id=str(project_id),
                    agent_id=agent.id,
                )
        elif (
            values.assignee_type == "user"
            and target_user_id != user_id
            and previous_assignee_user_id != target_user_id
        ):
            assigner = db.get(User, user_id)
            notify_project_task_assignee(
                user_id=target_user_id,
                project_id=str(project_id),
                project_name=project.name or "",
                item_id=item.id,
                item_title=item.title or item.id,
                assigner_name=assigner.user_name if assigner else str(user_id),
            )
        return updated

    def approve_run(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        values: LoopItemApproval,
    ) -> LoopItem:
        """Approve a pending robot run. Only the robot creator can approve."""

        item = self.get(db, item_id, user_id)
        self._require_bot_creator_scope(db, project_id, item, user_id)
        execution = loop_item_execution_service.active_for_item(db, item_id=item.id)
        if execution is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task is not assigned to a robot",
            )
        if item.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO changed")
        loop_item_execution_service.approve(
            db, execution_id=execution.id, user_id=user_id
        )
        metadata = advance_content_revision(item.metadata_json, actor_user_id=user_id)
        # The versioned update commits both the run approval and the item
        # change in one transaction; on a version race it rolls the approval
        # back instead of half-applying it.
        updated = self._versioned_metadata_update(db, item, values.version, metadata)
        agent = (
            db.get(ProjectChatAgent, item.assignee_agent_id)
            if item.assignee_agent_id
            else None
        )
        if agent is not None and agent.created_by_user_id:
            wake_robot_creator(
                user_id=agent.created_by_user_id,
                project_id=str(project_id),
                agent_id=agent.id,
            )
        return updated

    def reject_run(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        values: LoopItemApproval,
    ) -> LoopItem:
        """Reject a pending robot run. Only the robot creator can reject."""

        item = self.get(db, item_id, user_id)
        self._require_bot_creator_scope(db, project_id, item, user_id)
        execution = loop_item_execution_service.active_for_item(db, item_id=item.id)
        if execution is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task is not assigned to a robot",
            )
        if item.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO changed")
        rejected_execution = loop_item_execution_service.reject(
            db,
            execution_id=execution.id,
            user_id=user_id,
            reason=values.reason,
        )
        metadata = advance_content_revision(item.metadata_json, actor_user_id=user_id)
        # Same transaction rule as approve_run: the versioned update owns the
        # commit so a stale-version request cannot half-apply the rejection.
        updated = self._versioned_metadata_update(db, item, values.version, metadata)
        loop_item_execution_service.push_linked_activity_after_commit(
            db, execution=rejected_execution
        )
        agent = (
            db.get(ProjectChatAgent, item.assignee_agent_id)
            if item.assignee_agent_id
            else None
        )
        if agent is not None and agent.created_by_user_id:
            wake_robot_creator(
                user_id=agent.created_by_user_id,
                project_id=str(project_id),
                agent_id=agent.id,
            )
        return updated

    def delete(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        """Soft delete a TODO subtree; rows are kept for the recycle bin."""

        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        archived_at = self._now()
        pending_parent_ids = [item.id]
        archived_items = [item]
        while pending_parent_ids:
            children = (
                db.query(LoopItem)
                .filter(
                    LoopItem.cloud_project_id == item.cloud_project_id,
                    LoopItem.parent_id.in_(pending_parent_ids),
                    loop_datetime_is_unset(LoopItem.deleted_at),
                )
                .all()
            )
            pending_parent_ids = [child.id for child in children]
            archived_items.extend(children)
        for archived_item in archived_items:
            archived_item.deleted_at = archived_at
            archived_item.version += 1
        db.commit()
        db.refresh(item)
        return item

    def restore(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        """Restore a soft-deleted TODO from the recycle bin."""

        item = self._get_item_row(db, item_id, include_deleted=True)
        self._require_item_access(db, item, user_id, edit=True)
        if loop_datetime_value_is_unset(item.deleted_at):
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO is not deleted")
        item.deleted_at = None
        item.version += 1
        db.commit()
        db.refresh(item)
        return item

    def list_deleted(
        self, db: Session, cloud_project_id: int, user_id: int
    ) -> list[LoopItem]:
        """List soft-deleted TODOs of a project, most recently deleted first."""

        access = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        query = db.query(LoopItem).filter(
            LoopItem.cloud_project_id == cloud_project_id,
            ~loop_datetime_is_unset(LoopItem.deleted_at),
        )
        if access.is_public_visitor:
            query = query.filter(LoopItem.created_by_user_id == user_id)
        return query.order_by(LoopItem.deleted_at.desc()).all()

    def _require_parent(
        self, db: Session, parent_id: str, cloud_project_id: int
    ) -> LoopItem:
        parent = db.get(LoopItem, parent_id)
        if parent is None or not loop_datetime_value_is_unset(parent.deleted_at):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Parent TODO not found"
            )
        if str(parent.cloud_project_id) != str(cloud_project_id):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Parent TODO must belong to the same project",
            )
        return parent

    def _validate_parent_change(
        self, db: Session, item: LoopItem, parent_id: str | None
    ) -> None:
        if parent_id is None:
            return
        if parent_id == item.id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "TODO cannot be its own parent"
            )
        parent = self._require_parent(db, parent_id, item.cloud_project_id)
        visited = {item.id}
        while parent is not None:
            if parent.id in visited:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "TODO hierarchy cannot contain a cycle",
                )
            visited.add(parent.id)
            parent = db.get(LoopItem, parent.parent_id) if parent.parent_id else None

    def bind_task(
        self,
        db: Session,
        item_id: str,
        values: LoopItemTaskBind,
        user_id: int,
    ) -> LoopItemTaskBinding:
        return self._bind_task(
            db,
            item_id=item_id,
            values=values,
            user_id=user_id,
            allow_automated_stage=False,
        )

    def bind_execution_task(
        self,
        db: Session,
        *,
        item_id: str,
        values: LoopItemTaskBind,
        user_id: int,
        stage_snapshot: dict[str, Any],
        commit: bool = True,
    ) -> LoopItemTaskBinding:
        """Bind a trusted queued execution to its workflow stage."""

        if not values.workflow_node_id:
            raise ValueError("Workflow execution binding requires a stage")
        return self._bind_task(
            db,
            item_id=item_id,
            values=values,
            user_id=user_id,
            allow_automated_stage=True,
            stage_snapshot=stage_snapshot,
            commit=commit,
        )

    def _bind_task(
        self,
        db: Session,
        *,
        item_id: str,
        values: LoopItemTaskBind,
        user_id: int,
        allow_automated_stage: bool,
        stage_snapshot: dict[str, Any] | None = None,
        commit: bool = True,
    ) -> LoopItemTaskBinding:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        self._validate_backend_task(db, values.backend_task_id, user_id)
        active = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == values.device_id,
                LoopItemTaskBinding.task_id == values.task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .with_for_update()
            .first()
        )
        if values.workflow_node_id:
            self._validate_workflow_task_binding(
                db,
                item,
                values.workflow_node_id,
                (
                    active
                    if active is not None and active.loop_item_id == item_id
                    else None
                ),
                allow_automated_stage=allow_automated_stage,
            )
        if active is not None:
            if active.loop_item_id == item_id:
                if values.task_title and active.task_title != values.task_title:
                    active.task_title = values.task_title
                if values.workflow_node_id:
                    active.metadata_json = {
                        **(
                            active.metadata_json
                            if isinstance(active.metadata_json, dict)
                            else {}
                        ),
                        "workflow_node_id": values.workflow_node_id,
                    }
                    from app.services.workflow_stage_context import (
                        workflow_stage_context_resolver,
                    )

                    if workflow_stage_context_resolver.binding_snapshot(active) is None:
                        workflow_stage_context_resolver.freeze_binding(
                            active,
                            stage_snapshot
                            or workflow_stage_context_resolver.resolve(
                                db, item=item, target_node_id=values.workflow_node_id
                            ),
                        )
                self.ensure_collaborator(
                    db, item, user_id, user_id, "task", commit=False
                )
                if commit:
                    db.commit()
                    db.refresh(active)
                else:
                    db.flush()
                return active
            active.unlinked_at = self._now()
        binding = LoopItemTaskBinding(
            cloud_project_id=item.cloud_project_id,
            loop_item_id=item_id,
            task_user_id=user_id,
            device_id=values.device_id,
            task_id=values.task_id,
            task_title=values.task_title,
            backend_task_id=values.backend_task_id,
            linked_by_user_id=user_id,
            linked_at=self._now(),
            metadata_json=(
                {"workflow_node_id": values.workflow_node_id}
                if values.workflow_node_id
                else None
            ),
        )
        if values.workflow_node_id:
            from app.services.workflow_stage_context import (
                workflow_stage_context_resolver,
            )

            workflow_stage_context_resolver.freeze_binding(
                binding,
                stage_snapshot
                or workflow_stage_context_resolver.resolve(
                    db, item=item, target_node_id=values.workflow_node_id
                ),
            )
        db.add(binding)
        self.ensure_collaborator(db, item, user_id, user_id, "task", commit=False)
        if commit:
            db.commit()
            db.refresh(binding)
        else:
            db.flush()
        return binding

    @staticmethod
    def _validate_workflow_task_binding(
        db: Session,
        item: LoopItem,
        workflow_node_id: str,
        active_binding: LoopItemTaskBinding | None,
        *,
        allow_automated_stage: bool = False,
    ) -> None:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        workflow = metadata.get("workflow")
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        node = next(
            (
                candidate
                for candidate in nodes or []
                if isinstance(candidate, dict)
                and candidate.get("id") == workflow_node_id
            ),
            None,
        )
        if node is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")
        if node.get("automation_rule_id") and not allow_automated_stage:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Automated workflow stage does not accept a user task",
            )
        if active_binding is None and node.get("status") not in {
            "ready",
            "queued",
            "running",
            "awaiting_approval",
            "changes_requested",
            "failed",
        }:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow node is not ready",
            )

    def bind_project_task(
        self,
        db: Session,
        cloud_project_id: int,
        values: LoopItemTaskBind,
        user_id: int,
    ) -> LoopItemTaskBinding:
        """Associate a runtime Task with a cloud project without choosing a TODO."""

        require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        self._validate_backend_task(db, values.backend_task_id, user_id)
        active = self._active_task_binding(db, values, user_id, lock=True)
        if active is not None:
            if (
                str(active.cloud_project_id) == str(cloud_project_id)
                and not active.loop_item_id
            ):
                if values.task_title and active.task_title != values.task_title:
                    active.task_title = values.task_title
                db.commit()
                db.refresh(active)
                return active
            active.unlinked_at = self._now()
        binding = LoopItemTaskBinding(
            cloud_project_id=cloud_project_id,
            loop_item_id=None,
            task_user_id=user_id,
            device_id=values.device_id,
            task_id=values.task_id,
            task_title=values.task_title,
            backend_task_id=values.backend_task_id,
            linked_by_user_id=user_id,
            linked_at=self._now(),
        )
        db.add(binding)
        db.commit()
        db.refresh(binding)
        return binding

    def find_cloud_context(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        task_id: str,
    ) -> tuple[LoopItemTaskBinding, CloudProject, LoopItem | None]:
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == device_id,
                LoopItemTaskBinding.task_id == task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud context not found")
        project = db.get(CloudProject, binding.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        item = db.get(LoopItem, binding.loop_item_id) if binding.loop_item_id else None
        return binding, project, item

    def unbind_cloud_context(
        self, db: Session, values: LoopItemTaskBind, user_id: int
    ) -> None:
        binding = self._active_task_binding(db, values, user_id, lock=True)
        if binding is None:
            return
        binding.unlinked_at = self._now()
        db.commit()

    @staticmethod
    def _validate_backend_task(
        db: Session, backend_task_id: int | None, user_id: int
    ) -> None:
        if backend_task_id is None:
            return
        backend_task = task_store.get_task_by_states(
            db,
            task_id=backend_task_id,
            states=TaskResource.is_active_query(),
            user_id=user_id,
        )
        if backend_task is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")

    @staticmethod
    def _active_task_binding(
        db: Session,
        values: LoopItemTaskBind,
        user_id: int,
        *,
        lock: bool,
    ) -> LoopItemTaskBinding | None:
        query = db.query(LoopItemTaskBinding).filter(
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == values.device_id,
            LoopItemTaskBinding.task_id == values.task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        if lock:
            query = query.with_for_update()
        return query.first()

    def list_task_bindings(
        self, db: Session, item_id: str, user_id: int
    ) -> list[LoopItemTaskBinding]:
        self.get(db, item_id, user_id)
        return (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .order_by(
                LoopItemTaskBinding.linked_at.desc(),
                LoopItemTaskBinding.id.desc(),
            )
            .all()
        )

    def list_project_task_bindings(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        *,
        item_ids: list[str],
    ) -> list[LoopItemTaskBinding]:
        require_cloud_project_role(db, project_id, user_id)
        if not item_ids:
            return []
        return (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.cloud_project_id == project_id,
                LoopItemTaskBinding.loop_item_id.in_(item_ids),
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .order_by(
                LoopItemTaskBinding.loop_item_id.asc(),
                LoopItemTaskBinding.linked_at.desc(),
                LoopItemTaskBinding.id.desc(),
            )
            .all()
        )

    def unbind_task(
        self,
        db: Session,
        item_id: str,
        values: LoopItemTaskBind,
        user_id: int,
    ) -> None:
        self.get(db, item_id, user_id)
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == values.device_id,
                LoopItemTaskBinding.task_id == values.task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .with_for_update()
            .first()
        )
        if binding is None:
            return
        binding.unlinked_at = self._now()
        db.commit()

    def find_for_runtime_task(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        task_id: str,
    ) -> LoopItem:
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == device_id,
                LoopItemTaskBinding.task_id == task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Linked TODO not found")
        return self.get(db, binding.loop_item_id, user_id)

    def list_my_work(self, db: Session, user_id: int) -> list[dict[str, object]]:
        memberships = select(ResourceMember.resource_id).where(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        projects = (
            db.query(CloudProject)
            .filter(
                CloudProject.status == "active",
                (CloudProject.created_by_user_id == user_id)
                | CloudProject.id.in_(memberships),
            )
            .all()
        )
        if not projects:
            return []
        project_by_id = {project.id: project for project in projects}
        active_task_items = {
            item_id
            for (item_id,) in db.query(LoopItemTaskBinding.loop_item_id)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .all()
            if item_id
        }
        collaborator_items = {
            item_id
            for (item_id,) in db.query(LoopItemCollaborator.loop_item_id)
            .filter(LoopItemCollaborator.user_id == user_id)
            .all()
        }
        my_agent_ids = {
            agent_id
            for (agent_id,) in db.query(ProjectChatAgent.id)
            .filter(
                ProjectChatAgent.created_by_user_id == user_id,
                ProjectChatAgent.status == "active",
                loop_datetime_is_unset(ProjectChatAgent.deleted_at),
            )
            .all()
            if agent_id
        }
        my_work_membership = or_(
            LoopItem.created_by_user_id == user_id,
            LoopItem.assignee_user_id == user_id,
            LoopItem.id.in_(active_task_items),
            LoopItem.id.in_(collaborator_items),
        )
        if my_agent_ids:
            my_work_membership = or_(
                my_work_membership, LoopItem.assignee_agent_id.in_(my_agent_ids)
            )
        my_work_filters = [
            LoopItem.cloud_project_id.in_(project_by_id),
            loop_datetime_is_unset(LoopItem.deleted_at),
            my_work_membership,
        ]
        items = (
            db.query(LoopItem)
            .filter(*my_work_filters)
            .order_by(LoopItem.updated_at.desc())
            .all()
        )
        result: list[dict[str, object]] = []
        item_ids = [item.id for item in items]
        executions_by_item: dict[str, object] = {}
        if item_ids:
            from app.models.loop_item_execution import LoopItemExecution

            execution_rows = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.loop_item_id.in_(item_ids),
                )
                .order_by(LoopItemExecution.id.desc())
                .all()
            )
            for execution in execution_rows:
                executions_by_item.setdefault(execution.loop_item_id, execution)
        external_index_rows: list[LoopItem] = []
        for item in items:
            metadata = (
                item.metadata_json if isinstance(item.metadata_json, dict) else {}
            )
            if (
                metadata.get("external_index") is True
                or metadata.get("external_shadow") is True
            ):
                external_index_rows.append(item)
                continue
            assignment_history = metadata.get(ASSIGNMENT_HISTORY_KEY)
            status_history = metadata.get(STATUS_HISTORY_KEY)
            execution = executions_by_item.get(item.id)
            cached_ai_state = self._present_cached_ai_state(
                db, item, metadata.get(TASK_AI_STATE_KEY)
            )
            projected_ai_state = (
                execution_ai_state(db, execution, existing=cached_ai_state)
                if execution is not None
                else cached_ai_state
            )
            result.append(
                {
                    **item.__dict__,
                    "project_key": project_by_id[item.cloud_project_id].project_key,
                    "project_name": project_by_id[item.cloud_project_id].name,
                    "has_active_task": item.id in active_task_items,
                    "assignment_history": (
                        assignment_history
                        if isinstance(assignment_history, list)
                        else []
                    ),
                    "status_history": (
                        status_history if isinstance(status_history, list) else []
                    ),
                    "content_revision": content_revision(metadata),
                    "is_unread": is_unread(metadata, user_id),
                    "execution_id": getattr(execution, "id", None),
                    "execution_state": (
                        execution_display_state(execution)
                        if execution is not None
                        else (
                            projected_ai_state.get("status")
                            if isinstance(projected_ai_state, dict)
                            else None
                        )
                    ),
                    "execution_control_state": getattr(execution, "status", None),
                    "execution_observed_state": getattr(
                        execution, "observed_state", None
                    ),
                    "execution_sync_state": getattr(execution, "sync_state", None),
                    "execution_attempt_no": getattr(execution, "attempt_no", None),
                    "execution_last_event_seq": getattr(
                        execution, "last_event_seq", None
                    ),
                    "ai_state": projected_ai_state,
                    "queued_at": getattr(execution, "queued_at", None),
                    "execution_note": (
                        getattr(execution, "execution_note", "") or None
                    ),
                    "execution_error": (
                        getattr(execution, "error_message", "") or None
                    ),
                    "can_approve": self._can_approve_run(
                        db, item=item, execution=execution, user_id=user_id
                    ),
                    "approval": self._approval_view(execution),
                }
            )
        # External provider index rows are local pointers only; their display
        # data comes from the live provider issue (one GET per assigned task).
        if external_index_rows:
            from app.services.loop_items.external_provider import (
                external_loop_item_provider,
            )

            for item in external_index_rows:
                try:
                    view = external_loop_item_provider.get(db, item.id, user_id)
                except Exception:
                    logger.warning(
                        "[MyWork] Skip external index row id=%s",
                        item.id,
                        exc_info=True,
                    )
                    continue
                project = project_by_id.get(str(item.cloud_project_id))
                if project is None:
                    continue
                metadata = (
                    item.metadata_json if isinstance(item.metadata_json, dict) else {}
                )
                assignment_history = metadata.get(ASSIGNMENT_HISTORY_KEY)
                result.append(
                    {
                        **view,
                        "project_key": project.project_key,
                        "project_name": project.name,
                        "has_active_task": item.id in active_task_items,
                        "assignment_history": (
                            assignment_history
                            if isinstance(assignment_history, list)
                            else []
                        ),
                        # External provider tasks never carry status history.
                        "status_history": [],
                    }
                )
        return result

    @staticmethod
    def _can_approve_run(
        db: Session, *, item: LoopItem, execution: Any, user_id: int
    ) -> bool:
        """Whether the current user is the assigned robot's creator and this
        run is waiting for their manual approval."""

        if (
            execution is None
            or getattr(execution, "status", None) != "pending_approval"
        ):
            return False
        if not item.assignee_agent_id:
            return False
        agent = db.get(ProjectChatAgent, item.assignee_agent_id)
        return agent is not None and agent.created_by_user_id == user_id

    @staticmethod
    def _agent_visible_to_user(
        agent: ProjectChatAgent, user_id: int, role: BaseRole
    ) -> bool:
        """Robots are project assets that follow their creator's environment."""

        return ProjectChatService._agent_visible_to_user(agent, user_id, role)

    def _project_member_ids(self, db: Session, project_id: int) -> set[int]:
        project = db.get(CloudProject, project_id)
        member_ids: set[int] = set()
        if project is not None and project.created_by_user_id:
            member_ids.add(project.created_by_user_id)
        rows = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == project_id,
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

    def _require_bot_creator_scope(
        self, db: Session, project_id: int, item: LoopItem, user_id: int
    ) -> None:
        if item.cloud_project_id != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        if not item.assignee_agent_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Task is not assigned to a robot"
            )
        agent = db.get(ProjectChatAgent, item.assignee_agent_id)
        if agent is None or agent.created_by_user_id != user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only the robot creator can approve or reject this run",
            )
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)

    @staticmethod
    def _write_assignment_change(
        metadata: dict,
        user_id: int,
        to_type: str | None,
        to_id: str | None,
        to_name: str | None,
    ) -> None:
        """Record who assigned to whom. Run state lives in the execution table."""

        history = metadata.get(ASSIGNMENT_HISTORY_KEY)
        history = history if isinstance(history, list) else []
        action = "assign" if not history else "reassign"
        if to_id is None:
            action = "unassign"
        now = LoopItemService._now()
        history.append(
            {
                "by_user_id": user_id,
                "to_type": to_type,
                "to_id": to_id,
                "to_name": to_name,
                "action": action,
                "at": now.isoformat(),
            }
        )
        metadata[ASSIGNMENT_HISTORY_KEY] = history

    def _sync_execution_for_assignment(
        self,
        db: Session,
        *,
        item: LoopItem,
        user_id: int,
        target_type: str,
        target_id: str | None,
        agent: ProjectChatAgent | None,
        team: Kind | None,
        priority: str | None,
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
    ) -> list:
        """Create/cancel execution records when the assignee changes.

        Reassigning to a robot cancels any active run and starts a fresh run;
        assigning to a person (or unassigning) cancels robot runs. Returns the
        runs that were cancelled and already handed to a device so callers can
        ask the executor to stop them after the change commits.
        """

        from app.models.loop_item_execution import LoopItemExecution

        cancelled_runs = []
        preserve_run_id = str((automation_context or {}).get("run_id") or "")
        active = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == item.id,
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
                preserve_run_id
                and execution.executor_type == "automation_manager"
                and str(execution.automation_run_id or "") == preserve_run_id
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
        if target_type == "agent" and agent is not None:
            config = bot_config(agent)
            loop_item_execution_service.create_for_assignment(
                db,
                loop_item_id=item.id,
                cloud_project_id=item.cloud_project_id,
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
        elif target_type == "team" and team is not None:
            loop_item_execution_service.create_for_team_assignment(
                db,
                loop_item_id=item.id,
                cloud_project_id=item.cloud_project_id,
                team=team,
                assigner_user_id=user_id,
                priority=priority,
            )
        return cancelled_runs

    @staticmethod
    def _approval_view(execution: object) -> dict | None:
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
    def _versioned_metadata_update(
        db: Session,
        item: LoopItem,
        version: int,
        metadata: dict,
        **updates: object,
    ) -> LoopItem:
        updates = {**updates, "metadata_json": metadata}
        updates = adapt_loop_node_values_for_dialect(
            updates, db.get_bind().dialect.name
        )
        updated = (
            db.query(LoopItem)
            .filter(LoopItem.id == item.id, LoopItem.version == version)
            .update({**updates, "version": LoopItem.version + 1})
        )
        if updated != 1:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO changed")
        db.commit()
        db.refresh(item)
        return item

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


loop_item_service = LoopItemService()
