# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Human ownership and review for directly assigned native cloud Issues."""

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.human_issue_work import (
    HumanWorkReview,
    HumanWorkStart,
    HumanWorkSubmit,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.issue_assignments import AssignmentEvent, issue_assignment_service
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_status_history import (
    project_board_statuses,
    write_status_change,
)
from app.services.loop_item_unread import advance_content_revision
from app.services.wework_notifications import create_notification
from shared.telemetry.decorators import trace_sync

HUMAN_WORK_KEY = "human_work"


class HumanIssueWorkService:
    def _assignment(
        self, db: Session, item: LoopItem, *, strict: bool = False
    ) -> AssignmentEvent | None:
        project = db.get(CloudProject, item.cloud_project_id)
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        if (
            project is None
            or project.task_provider != "local"
            or metadata.get("workflow")
            or metadata.get("external_index")
            or metadata.get("external_shadow")
        ):
            return None
        active = issue_assignment_service.active_for_issue(db, item.id)
        if len(active) != 1:
            if strict and active:
                raise HTTPException(
                    409, "Exactly one active human assignment is required"
                )
            return None
        assignment = active[0]
        if (
            assignment.member_type != "human"
            or assignment.metadata.get("trigger") == "default"
            or assignment.workflow_step
            or str(item.assignee_user_id or "") != assignment.member_id
        ):
            return None
        return assignment

    def is_direct_human_assignment(self, db: Session, item: LoopItem) -> bool:
        return self._assignment(db, item) is not None

    def _reviewer_id(
        self, db: Session, item: LoopItem, assignment: AssignmentEvent
    ) -> int | None:
        assigner_id = assignment.assigned_by_user_id
        if assigner_id == item.assignee_user_id:
            return None
        try:
            access = require_cloud_project_role(
                db, int(item.cloud_project_id), assigner_id, BaseRole.Reporter
            )
        except HTTPException:
            return None
        return assigner_id if not access.is_public_visitor else None

    def _fallback_reviewer_ids(self, db: Session, item: LoopItem) -> set[int]:
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            return set()
        ids = {int(project.created_by_user_id)}
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
        for member in rows:
            if member.role in {BaseRole.Owner.value, BaseRole.Maintainer.value}:
                try:
                    ids.add(int(member.entity_id))
                except (TypeError, ValueError):
                    continue
        return ids

    def view(self, db: Session, item: LoopItem, user_id: int) -> dict | None:
        assignment = self._assignment(db, item)
        if assignment is None:
            return None
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        stored = metadata.get(HUMAN_WORK_KEY)
        work = stored if isinstance(stored, dict) else {}
        reviewer_id = self._reviewer_id(db, item, assignment)
        is_assignee = item.assignee_user_id == user_id
        can_review = (
            item.status == "in_review"
            and work.get("state") == "submitted"
            and work.get("assignment_id") == assignment.id
            and (
                reviewer_id == user_id
                if reviewer_id is not None
                else user_id in self._fallback_reviewer_ids(db, item)
            )
        )
        return {
            "assignment_id": assignment.id,
            "assignee_user_id": item.assignee_user_id,
            "reviewer_user_id": reviewer_id,
            "submission_message_id": work.get("submission_message_id"),
            "submitted_by_user_id": work.get("submitted_by_user_id"),
            "state": (
                work.get("state", "none")
                if work.get("assignment_id") == assignment.id
                else "none"
            ),
            "can_start": is_assignee and item.status in {"inbox", "pending"},
            "can_submit": is_assignee and item.status == "in_progress",
            "can_review": can_review,
        }

    def _item(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        item = (
            db.query(LoopItem).filter(LoopItem.id == item_id).with_for_update().first()
        )
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        require_cloud_project_role(
            db, int(item.cloud_project_id), user_id, BaseRole.Reporter
        )
        return item

    def _require_assignment(self, db: Session, item: LoopItem) -> AssignmentEvent:
        assignment = self._assignment(db, item, strict=True)
        if assignment is None:
            raise HTTPException(409, "Issue has no direct human assignee")
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(404, "Project not found")
        status_ids = {entry_id for entry_id, _ in project_board_statuses(project)}
        if not {"in_progress", "in_review", "completed"}.issubset(status_ids):
            raise HTTPException(409, "Issue board lacks human work statuses")
        return assignment

    @staticmethod
    def _check_version(item: LoopItem, version: int) -> None:
        if item.version != version:
            raise HTTPException(409, "Issue changed; refresh before continuing")

    @staticmethod
    def _transition(
        db: Session, item: LoopItem, *, to_status: str, user_id: int, trigger: str
    ) -> None:
        previous_status = item.status
        project = db.get(CloudProject, item.cloud_project_id)
        metadata = dict(item.metadata_json or {})
        write_status_change(
            metadata,
            project=project,
            from_status=previous_status,
            to_status=to_status,
            trigger=trigger,
            by_user_id=user_id,
        )
        item.metadata_json = advance_content_revision(metadata, actor_user_id=user_id)
        item.status = to_status
        item.sort_order = 0
        item.completed_at = (
            datetime.now(timezone.utc).replace(tzinfo=None)
            if to_status == "completed"
            else None
        )
        item.version += 1
        from app.services.workspace_cleanup_intents import sync_issue_status

        sync_issue_status(
            db,
            item=item,
            previous_status=previous_status,
            next_status=to_status,
            next_version=item.version,
            completed_at=item.completed_at,
        )

    @staticmethod
    def _message(
        db: Session,
        item: LoopItem,
        *,
        user_id: int,
        request_id: str,
        content: str,
        action: str,
        assignment_id: str,
    ) -> ProjectChatMessage:
        actor = db.get(User, user_id)
        message_id = str(uuid4())
        message = ProjectChatMessage(
            message_id=message_id,
            client_message_id=request_id,
            project_id=str(item.cloud_project_id),
            task_id=item.id,
            sender_type="user",
            sender_id=str(user_id),
            sender_name=actor.user_name if actor else str(user_id),
            message_type="text",
            content=content,
            metadata_json={
                "human_work_action": action,
                "assignment_id": assignment_id,
            },
            status="completed",
        )
        db.add(message)
        db.flush()
        return message

    @staticmethod
    def _existing_message(
        db: Session, item: LoopItem, user_id: int, request_id: str
    ) -> ProjectChatMessage | None:
        return (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.task_id == item.id,
                ProjectChatMessage.sender_type == "user",
                ProjectChatMessage.sender_id == str(user_id),
                ProjectChatMessage.client_message_id == request_id,
            )
            .first()
        )

    @staticmethod
    def _notify(
        db: Session,
        item: LoopItem,
        *,
        recipients: set[int],
        actor_id: int,
        title: str,
        body: str,
    ) -> None:
        for recipient_id in recipients:
            create_notification(
                db,
                user_id=recipient_id,
                actor_user_id=actor_id,
                title=title,
                body=body,
                project_id=str(item.cloud_project_id),
                item_id=item.id,
                kind="human_work",
                payload={"itemId": item.id, "projectId": str(item.cloud_project_id)},
            )

    @trace_sync("human_issue_work.start", tracer_name="backend")
    def start(
        self, db: Session, item_id: str, user_id: int, values: HumanWorkStart
    ) -> LoopItem:
        item = self._item(db, item_id, user_id)
        self._require_assignment(db, item)
        self._check_version(item, values.version)
        if item.assignee_user_id != user_id:
            raise HTTPException(403, "Only the assignee can start work")
        if item.status not in {"inbox", "pending"}:
            raise HTTPException(409, "Issue cannot start from its current status")
        self._transition(
            db, item, to_status="in_progress", user_id=user_id, trigger="human_started"
        )
        db.commit()
        db.refresh(item)
        publish_loop_item_changed(
            db, item=item, reason="human_started", actor_user_id=user_id
        )
        return item

    @trace_sync("human_issue_work.submit", tracer_name="backend")
    def submit(
        self, db: Session, item_id: str, user_id: int, values: HumanWorkSubmit
    ) -> tuple[LoopItem, ProjectChatMessage, bool]:
        item = self._item(db, item_id, user_id)
        assignment = self._require_assignment(db, item)
        existing = self._existing_message(db, item, user_id, values.request_id)
        if existing is not None:
            prior = existing.metadata_json or {}
            if (
                prior.get("human_work_action") != "submitted"
                or prior.get("assignment_id") != assignment.id
            ):
                raise HTTPException(409, "Request id belongs to another action")
            return item, existing, False
        self._check_version(item, values.version)
        if item.assignee_user_id != user_id:
            raise HTTPException(403, "Only the assignee can submit work")
        if item.status != "in_progress":
            raise HTTPException(409, "Issue is not in progress")
        if not values.summary.strip():
            raise HTTPException(422, "Submission summary is required")
        message = self._message(
            db,
            item,
            user_id=user_id,
            request_id=values.request_id,
            content=values.summary.strip(),
            action="submitted",
            assignment_id=assignment.id,
        )
        reviewer_id = self._reviewer_id(db, item, assignment)
        self._transition(
            db, item, to_status="in_review", user_id=user_id, trigger="human_submitted"
        )
        metadata = dict(item.metadata_json or {})
        metadata[HUMAN_WORK_KEY] = {
            "assignment_id": assignment.id,
            "submission_message_id": message.message_id,
            "submitted_by_user_id": user_id,
            "reviewer_user_id": reviewer_id,
            "state": "submitted",
        }
        item.metadata_json = metadata
        recipients = (
            {reviewer_id}
            if reviewer_id is not None
            else self._fallback_reviewer_ids(db, item)
        )
        self._notify(
            db,
            item,
            recipients=recipients,
            actor_id=user_id,
            title="Issue 待验收",
            body=f"{item.title} 已提交处理结果，请验收。",
        )
        db.commit()
        db.refresh(item)
        db.refresh(message)
        publish_loop_item_changed(
            db, item=item, reason="human_submitted", actor_user_id=user_id
        )
        return item, message, True

    @trace_sync("human_issue_work.review", tracer_name="backend")
    def review(
        self, db: Session, item_id: str, user_id: int, values: HumanWorkReview
    ) -> tuple[LoopItem, ProjectChatMessage, bool]:
        item = self._item(db, item_id, user_id)
        assignment = self._require_assignment(db, item)
        existing = self._existing_message(db, item, user_id, values.request_id)
        if existing is not None:
            prior = existing.metadata_json or {}
            if (
                prior.get("human_work_action") != values.decision
                or prior.get("assignment_id") != assignment.id
            ):
                raise HTTPException(409, "Request id belongs to another action")
            return item, existing, False
        self._check_version(item, values.version)
        if not self.view(db, item, user_id)["can_review"]:
            raise HTTPException(403, "Only the reviewer can review submitted work")
        reason = (values.reason or "").strip()
        content = reason or "验收通过"
        message = self._message(
            db,
            item,
            user_id=user_id,
            request_id=values.request_id,
            content=content,
            action=values.decision,
            assignment_id=assignment.id,
        )
        accepted = values.decision == "accept"
        self._transition(
            db,
            item,
            to_status="completed" if accepted else "in_progress",
            user_id=user_id,
            trigger="human_accepted" if accepted else "human_changes_requested",
        )
        metadata = dict(item.metadata_json or {})
        metadata[HUMAN_WORK_KEY] = {
            **metadata[HUMAN_WORK_KEY],
            "state": "accepted" if accepted else "changes_requested",
            "reviewed_by_user_id": user_id,
            "review_message_id": message.message_id,
        }
        item.metadata_json = metadata
        self._notify(
            db,
            item,
            recipients={int(item.assignee_user_id)},
            actor_id=user_id,
            title="Issue 验收通过" if accepted else "Issue 已退回",
            body=(
                f"{item.title} 已验收通过。"
                if accepted
                else f"{item.title} 已退回：{reason}"
            ),
        )
        db.commit()
        db.refresh(item)
        db.refresh(message)
        publish_loop_item_changed(
            db, item=item, reason="human_reviewed", actor_user_id=user_id
        )
        return item, message, True


human_issue_work_service = HumanIssueWorkService()
