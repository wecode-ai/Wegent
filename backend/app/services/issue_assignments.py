# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Issue assignments stored as structured LoopItemComment events."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.db.timezone import database_datetime_as_utc
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemActiveAssignment,
    LoopItemComment,
    LoopNode,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.access import (
    IssueAction,
    require_issue_action,
)
from app.services.loop_item_history_actor import automation_history_actor
from app.services.loop_items.access import can_view_item

ASSIGNMENT_EVENT_TYPE = "assignment"


@dataclass(frozen=True)
class AssignmentEvent:
    comment: LoopItemComment
    metadata: dict[str, object]

    @property
    def id(self) -> str:
        return str(self.comment.id)

    @property
    def loop_item_id(self) -> str:
        return str(self.comment.loop_item_id)

    @property
    def member_type(self) -> str:
        return str(self.metadata.get("target_type") or "")

    @property
    def member_id(self) -> str:
        return str(self.metadata.get("target_id") or "")

    @property
    def workflow_step(self) -> str:
        return str(self.metadata.get("workflow_step") or "")

    @property
    def assigned_by_user_id(self) -> int:
        return int(self.comment.created_by_user_id or 0)

    @property
    def comment_id(self) -> str:
        return self.id

    @property
    def created_at(self) -> datetime:
        return self.comment.created_at

    @property
    def updated_at(self) -> datetime:
        return self.comment.updated_at


class IssueAssignmentService:
    """Treat the Issue activity stream as the assignment source of truth."""

    def list(
        self,
        db: Session,
        *,
        project_id: int,
        issue_id: str,
        user_id: int,
    ) -> list[AssignmentEvent]:
        item = self._require_issue_project(db, project_id, issue_id)
        from app.services.loop_items.access import require_item_access

        access = require_item_access(db, item, user_id)
        if access.project.task_provider in {"github", "gitlab"}:
            from app.services.loop_items.external_provider import (
                external_loop_item_provider,
            )

            external_loop_item_provider.get(db, issue_id, user_id)
        elif not can_view_item(db, access, item, user_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        return list(self._active_events(db, issue_id).values())

    def active_for_issue(self, db: Session, issue_id: str) -> list[AssignmentEvent]:
        """Return active assignments in activity order without a second data source."""
        return list(self._active_events(db, issue_id).values())

    def active_for_issues(
        self, db: Session, issue_ids: list[str]
    ) -> dict[str, list[AssignmentEvent]]:
        """Read assignment histories together and apply the same event reduction."""
        grouped: dict[str, list[LoopItemComment]] = {key: [] for key in issue_ids}
        if issue_ids:
            comments = self._assignment_comments(db, issue_ids)
            for comment in comments:
                grouped[comment.loop_item_id].append(comment)
        return {
            key: list(self._reduce_events(comments).values())
            for key, comments in grouped.items()
        }

    def active(
        self,
        db: Session,
        *,
        issue_id: str,
        member_type: str,
        member_id: str,
        workflow_step: str | None,
    ) -> AssignmentEvent | None:
        key = (
            self._member_type(member_type),
            member_id.strip(),
            self._workflow_step(workflow_step),
        )
        return self._active_events(db, issue_id).get(key)

    def record(
        self,
        db: Session,
        *,
        workspace_id: int | None = None,
        project_id: int | str | None,
        issue_id: str,
        member_type: str,
        member_id: str,
        assigned_by_user_id: int,
        workflow_step: str | None,
        notify: bool,
        trigger: str,
        comment_id: str | None = None,
        comment_body: str | None = None,
        replace_root_assignments: bool = False,
        redeliver: bool = False,
        initial_assignment: bool = False,
        automation_context: dict | None = None,
    ) -> tuple[AssignmentEvent, bool]:
        del workspace_id
        self._lock_issue(db, issue_id)
        normalized_type = self._member_type(member_type)
        normalized_id = member_id.strip()
        # A newly inserted Issue cannot have history or index rows. Locking that
        # absent range would block independent first assignments in InnoDB.
        active = (
            []
            if initial_assignment
            else self._uncancelled_events(
                self._assignment_comments(db, [issue_id], for_update=True)
            )
        )
        current = {self._event_key(event): event for event in active}
        key = (normalized_type, normalized_id, self._workflow_step(workflow_step))
        existing = current.get(key)
        if (
            existing is not None
            and not replace_root_assignments
            and not redeliver
            and not (
                existing.metadata.get("trigger") == "default" and trigger != "default"
            )
        ):
            return existing, False
        if (
            normalized_type == "human" or replace_root_assignments
        ) and not self._workflow_step(workflow_step):
            for previous in active:
                if previous.workflow_step or (
                    redeliver and self._event_key(previous) != key
                ):
                    continue
                self._cancel_dispatch(previous, "superseded")
                db.add(
                    LoopItemComment(
                        cloud_project_id=str(project_id) if project_id else None,
                        loop_item_id=issue_id,
                        description="",
                        created_by_user_id=assigned_by_user_id,
                        updated_by_user_id=assigned_by_user_id,
                        status="active",
                        metadata_json={
                            "event_type": ASSIGNMENT_EVENT_TYPE,
                            "action": "unassign",
                            "assignment_event_id": previous.id,
                            "target_type": previous.member_type,
                            "target_id": previous.member_id,
                            "workflow_step": previous.workflow_step,
                            "notify": False,
                            "trigger": "reassignment",
                        },
                    )
                )
        target_name = self._target_name(db, normalized_type, normalized_id)
        metadata = {
            "event_type": ASSIGNMENT_EVENT_TYPE,
            "action": "assign",
            "target_type": normalized_type,
            "target_id": normalized_id,
            "target_name": target_name,
            "workflow_step": self._workflow_step(workflow_step),
            "notify": bool(notify),
            "trigger": trigger,
            **automation_history_actor(automation_context),
        }
        if project_id:
            metadata["receipt_tracking"] = True
        comment = db.get(LoopItemComment, comment_id) if comment_id else None
        if comment is None:
            comment = LoopItemComment(
                cloud_project_id=str(project_id) if project_id else None,
                loop_item_id=issue_id,
                description=comment_body or "",
                created_by_user_id=assigned_by_user_id,
                updated_by_user_id=assigned_by_user_id,
                status="active",
                metadata_json=metadata,
            )
            db.add(comment)
        else:
            comment.metadata_json = metadata
        db.flush()
        if (
            normalized_type == "human"
            and project_id
            and notify
            and not workflow_step
            and trigger != "collaboration_round"
        ):
            from app.services.collaboration_human_assignments import (
                direct_human_assignment_id,
            )

            metadata = {
                **metadata,
                "dispatch_receipt": {
                    "projectId": str(project_id),
                    "issueId": issue_id,
                    "humanAssignmentId": direct_human_assignment_id(
                        issue_id=issue_id, assignment_id=str(comment.id)
                    ),
                    "ownerUserId": int(normalized_id),
                    "state": "queued",
                    "reasonCode": "awaiting_device_ack",
                    "runtimeTaskId": None,
                    "deliveryId": None,
                    "updatedAt": datetime.now(timezone.utc).isoformat(),
                },
            }
            comment.metadata_json = metadata
            # Index refresh reloads comments with populate_existing.
            db.flush()
        event = AssignmentEvent(comment=comment, metadata=metadata)
        if initial_assignment:
            self._insert_active_index(db, issue_id, [event])
        else:
            self._refresh_active_index(db, issue_id)
        return event, True

    def remove(
        self,
        db: Session,
        *,
        project_id: int,
        issue_id: str,
        assignment_id: str,
        user_id: int,
    ) -> AssignmentEvent:
        self._lock_issue(db, issue_id)
        item = self._require_issue_project(db, project_id, issue_id)
        from app.services.loop_items.service import loop_item_service

        access = loop_item_service._require_item_access(db, item, user_id)
        require_issue_action(
            access,
            action=IssueAction.ASSIGN,
            issue_creator_user_id=item.created_by_user_id,
            user_id=user_id,
        )
        assignment = next(
            (
                event
                for event in self._active_events(db, issue_id, for_update=True).values()
                if event.id == str(assignment_id)
            ),
            None,
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Assignment not found")
        self._unassign(db, item, assignment, user_id)
        db.flush()
        self._refresh_active_index(db, issue_id)
        return assignment

    def clear_direct_humans(self, db: Session, *, item: LoopItem, user_id: int) -> None:
        """Append cancellation events under the caller's authorized Issue lock."""
        direct = [
            assignment
            for assignment in self._uncancelled_events(
                self._assignment_comments(db, [item.id], for_update=True)
            )
            if self._member_type(assignment.member_type) == "human"
            and not assignment.workflow_step
        ]
        if direct:
            for assignment in direct:
                self._unassign(db, item, assignment, user_id)
            db.flush()
            self._refresh_active_index(db, item.id)

    def _unassign(
        self, db: Session, item: LoopItem, assignment: AssignmentEvent, user_id: int
    ) -> None:
        self._cancel_dispatch(assignment, "assignment_cancelled")
        metadata = {
            "event_type": ASSIGNMENT_EVENT_TYPE,
            "action": "unassign",
            "assignment_event_id": assignment.id,
            "target_type": assignment.member_type,
            "target_id": assignment.member_id,
            "target_name": assignment.metadata.get("target_name") or "",
            "workflow_step": assignment.workflow_step,
            "notify": False,
            "trigger": "manual",
        }
        comment = LoopItemComment(
            cloud_project_id=item.cloud_project_id or None,
            loop_item_id=item.id,
            description="",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            status="active",
            metadata_json=metadata,
        )
        db.add(comment)

    @staticmethod
    def _lock_issue(db: Session, issue_id: str) -> None:
        db.query(LoopItem.id).filter(LoopItem.id == issue_id).with_for_update().one()

    def _refresh_active_index(self, db: Session, issue_id: str) -> None:
        """Rebuild only on assignment changes, never on receipt reads or writes."""
        active = self._active_events(db, issue_id, for_update=True)
        db.query(LoopItemActiveAssignment).filter(
            LoopItemActiveAssignment.parent_id == issue_id,
            LoopItemActiveAssignment.resource_type == "assignment_index",
        ).delete(synchronize_session=False)
        self._insert_active_index(db, issue_id, list(active.values()))

    @staticmethod
    def _insert_active_index(
        db: Session, issue_id: str, active: list[AssignmentEvent]
    ) -> None:
        db.add_all(
            [
                LoopItemActiveAssignment(
                    id=sha256(f"assignment-index:{issue_id}".encode()).hexdigest(),
                    parent_id=issue_id,
                )
            ]
            + [
                LoopItemActiveAssignment(
                    id=sha256(f"active-assignment:{event.id}".encode()).hexdigest(),
                    parent_id=issue_id,
                    loop_item_id=event.id,
                    sort_order=position,
                )
                for position, event in enumerate(active)
            ]
        )
        db.flush()

    def require_canonical_member(
        self,
        db: Session,
        *,
        project: CloudProject,
        member_type: str,
        member_id: str,
    ) -> tuple[str, str]:
        if member_type == "human":
            try:
                user_id = int(member_id)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Human member id must be numeric",
                ) from exc
            if project.task_provider == "local":
                from app.services.loop_items.access import require_active_issue_user

                require_active_issue_user(db, user_id)
            elif user_id not in project_participant_ids(
                db, project, required_role=BaseRole.Developer
            ):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Assignee is not a member of this Project",
                )
            return "user", str(user_id)
        agent = db.get(ProjectChatAgent, member_id)
        if (
            agent is None
            or str(agent.cloud_project_id) != str(project.id)
            or agent.status != "active"
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Agent is not active in this Project",
            )
        metadata = agent.metadata_json if isinstance(agent.metadata_json, dict) else {}
        team_id_value = metadata.get("wegent_team_id")
        if team_id_value is None:
            return "agent", agent.id
        try:
            int(team_id_value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Project Agent has an invalid Team binding",
            ) from exc
        return "agent", agent.id

    @staticmethod
    def _cancel_dispatch(assignment: AssignmentEvent, reason: str) -> None:
        receipt = assignment.metadata.get("dispatch_receipt")
        if not isinstance(receipt, dict):
            return
        metadata = {
            **assignment.metadata,
            "dispatch_receipt": {
                **receipt,
                "state": "cancelled",
                "reasonCode": reason,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            },
        }
        assignment.comment.metadata_json = metadata

    @staticmethod
    def response_values(db: Session, assignment: AssignmentEvent) -> dict[str, object]:
        creator = db.get(User, assignment.assigned_by_user_id)
        return {
            "id": assignment.id,
            "issue_id": assignment.loop_item_id,
            "target_type": assignment.member_type,
            "target_id": assignment.member_id,
            "target_name": str(assignment.metadata.get("target_name") or ""),
            "workflow_step": assignment.workflow_step or None,
            "body": assignment.comment.description or "",
            "comment_id": assignment.id,
            "created_by_user_id": assignment.assigned_by_user_id,
            "created_by_user_name": creator.user_name if creator is not None else None,
            "automation": assignment.metadata.get("automation"),
            **(
                {"dispatch_receipt": assignment.metadata["dispatch_receipt"]}
                if "dispatch_receipt" in assignment.metadata
                else {}
            ),
            "status": "active",
            "created_at": database_datetime_as_utc(db, assignment.created_at),
            "updated_at": database_datetime_as_utc(db, assignment.updated_at),
        }

    def project_for_issue(
        self, db: Session, *, issue_id: str, user_id: int
    ) -> tuple[CloudProject, LoopItem]:
        item = db.get(LoopItem, issue_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        from app.services.loop_items.service import loop_item_service

        loop_item_service._require_item_access(db, item, user_id)
        return project, item

    def project_legacy_assignment(self, db: Session, *, item: LoopItem) -> None:
        active = list(self._active_events(db, item.id).values())
        latest = active[-1] if active else None
        item.assignee_user_id = None
        item.assignee_agent_id = ""
        item.assignee_team_id = None
        if latest is not None and latest.member_type == "human":
            try:
                item.assignee_user_id = int(latest.member_id)
            except ValueError:
                pass
        elif latest is not None and db.get(ProjectChatAgent, latest.member_id):
            item.assignee_agent_id = latest.member_id
        elif latest is not None:
            try:
                item.assignee_team_id = int(latest.member_id)
            except ValueError:
                pass
        item.version += 1

    def _active_events(
        self, db: Session, issue_id: str, *, for_update: bool = False
    ) -> dict[tuple[str, str, str], AssignmentEvent]:
        if for_update:
            return self._reduce_events(
                self._assignment_comments(db, [issue_id], for_update=True)
            )
        return {
            (event.member_type, event.member_id, event.workflow_step): event
            for event in self.active_for_issues(db, [issue_id])[issue_id]
        }

    @staticmethod
    def _assignment_comments(
        db: Session, issue_ids: list[str], *, for_update: bool = False
    ) -> list[LoopItemComment]:
        model = LoopNode if for_update else LoopItemComment
        query = (
            db.query(model)
            .filter(model.loop_item_id.in_(issue_ids))
            .order_by(model.created_at, model.id)
        )
        if for_update:
            # Lock by Issue identity alone: subtype/deletion indexes can scan
            # another Issue's uncommitted rows before applying the Issue filter.
            nodes = query.populate_existing().with_for_update().all()
            return [
                node
                for node in nodes
                if isinstance(node, LoopItemComment)
                and loop_datetime_value_is_unset(node.deleted_at)
                and isinstance(node.metadata_json, dict)
                and node.metadata_json.get("event_type") == ASSIGNMENT_EVENT_TYPE
            ]
        return query.filter(
            loop_datetime_is_unset(LoopItemComment.deleted_at),
            LoopItemComment.metadata_json["event_type"].as_string()
            == ASSIGNMENT_EVENT_TYPE,
        ).all()

    def _reduce_events(
        self, comments: list[LoopItemComment]
    ) -> dict[tuple[str, str, str], AssignmentEvent]:
        return {
            self._event_key(event): event
            for event in self._uncancelled_events(comments)
        }

    def _event_key(self, event: AssignmentEvent) -> tuple[str, str, str]:
        return (
            self._member_type(event.member_type),
            event.member_id,
            self._workflow_step(event.workflow_step),
        )

    @staticmethod
    def _uncancelled_events(comments: list[LoopItemComment]) -> list[AssignmentEvent]:
        cancelled_event_ids = {
            str(metadata.get("assignment_event_id") or "")
            for comment in comments
            if (
                isinstance(comment.metadata_json, dict)
                and (metadata := comment.metadata_json).get("event_type")
                == ASSIGNMENT_EVENT_TYPE
                and metadata.get("action") == "unassign"
            )
        }
        active: list[AssignmentEvent] = []
        for comment in comments:
            metadata = (
                comment.metadata_json if isinstance(comment.metadata_json, dict) else {}
            )
            if metadata.get("event_type") != ASSIGNMENT_EVENT_TYPE:
                continue
            action = metadata.get("action")
            if action == "assign":
                event = AssignmentEvent(comment=comment, metadata=metadata)
                if event.id not in cancelled_event_ids:
                    active.append(event)
        return active

    @staticmethod
    def _target_name(db: Session, member_type: str, member_id: str) -> str:
        if member_type == "human":
            try:
                user = db.get(User, int(member_id))
            except ValueError:
                user = None
            return user.user_name if user is not None else ""
        agent = db.get(ProjectChatAgent, member_id)
        if agent is not None:
            return str(agent.title or agent.name or "")
        try:
            team = db.get(Kind, int(member_id))
        except ValueError:
            team = None
        return team.name if team is not None else ""

    @staticmethod
    def _member_type(value: str) -> str:
        if value in {"user", "human"}:
            return "human"
        if value in {"agent", "team"}:
            return "agent"
        raise ValueError(f"Unsupported assignment member type: {value}")

    @staticmethod
    def _workflow_step(value: str | None) -> str:
        return value.strip() if value else ""

    @staticmethod
    def _require_issue_project(db: Session, project_id: int, issue_id: str) -> LoopItem:
        item = db.get(LoopItem, issue_id)
        if item is None or str(item.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        return item


issue_assignment_service = IssueAssignmentService()
