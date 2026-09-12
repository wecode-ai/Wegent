# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Issue assignments stored as structured LoopItemComment events."""

from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import (
    IssueAction,
    require_cloud_project_role,
    require_issue_action,
)
from app.services.workspaces.storage import workspace_id_for_project

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
        require_cloud_project_role(db, project_id, user_id, BaseRole.RestrictedAnalyst)
        self._require_issue_project(db, project_id, issue_id)
        return list(self._active_events(db, issue_id).values())

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
        project_id: int | str,
        issue_id: str,
        member_type: str,
        member_id: str,
        assigned_by_user_id: int,
        workflow_step: str | None,
        notify: bool,
        trigger: str,
        comment_id: str | None = None,
        comment_body: str | None = None,
    ) -> tuple[AssignmentEvent, bool]:
        del workspace_id
        normalized_type = self._member_type(member_type)
        normalized_id = member_id.strip()
        existing = self.active(
            db,
            issue_id=issue_id,
            member_type=normalized_type,
            member_id=normalized_id,
            workflow_step=workflow_step,
        )
        if existing is not None:
            return existing, False
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
        }
        comment = db.get(LoopItemComment, comment_id) if comment_id else None
        if comment is None:
            comment = LoopItemComment(
                cloud_project_id=str(project_id),
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
        return AssignmentEvent(comment=comment, metadata=metadata), True

    def remove(
        self,
        db: Session,
        *,
        project_id: int,
        issue_id: str,
        assignment_id: str,
        user_id: int,
    ) -> AssignmentEvent:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.RestrictedAnalyst
        )
        item = self._require_issue_project(db, project_id, issue_id)
        require_issue_action(
            access,
            action=IssueAction.ASSIGN,
            issue_creator_user_id=item.created_by_user_id,
            user_id=user_id,
        )
        assignment = next(
            (
                event
                for event in self._active_events(db, issue_id).values()
                if event.id == str(assignment_id)
            ),
            None,
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Assignment not found")
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
            cloud_project_id=str(project_id),
            loop_item_id=issue_id,
            description="",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            status="active",
            metadata_json=metadata,
        )
        db.add(comment)
        db.flush()
        return assignment

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
            if user_id not in self._project_member_ids(db, project):
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
        workspace_id = workspace_id_for_project(db, project.id)
        if team_id_value is None or workspace_id is None:
            return "agent", agent.id
        try:
            team_id = int(team_id_value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Project Agent has an invalid Team binding",
            ) from exc
        from app.services.workspaces import workspace_service

        workspace_service.require_agent_authorized(
            db, workspace_id=workspace_id, team_id=team_id
        )
        return "agent", agent.id

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
            "status": "active",
            "created_at": assignment.created_at,
            "updated_at": assignment.updated_at,
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
        require_cloud_project_role(
            db, int(project.id), user_id, BaseRole.RestrictedAnalyst
        )
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
        self, db: Session, issue_id: str
    ) -> dict[tuple[str, str, str], AssignmentEvent]:
        comments = (
            db.query(LoopItemComment)
            .filter(
                LoopItemComment.loop_item_id == issue_id,
                loop_datetime_is_unset(LoopItemComment.deleted_at),
            )
            .order_by(LoopItemComment.created_at, LoopItemComment.id)
            .all()
        )
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
        active: dict[tuple[str, str, str], AssignmentEvent] = {}
        for comment in comments:
            metadata = (
                comment.metadata_json if isinstance(comment.metadata_json, dict) else {}
            )
            if metadata.get("event_type") != ASSIGNMENT_EVENT_TYPE:
                continue
            action = metadata.get("action")
            if action == "assign":
                key = (
                    self._member_type(str(metadata.get("target_type") or "")),
                    str(metadata.get("target_id") or ""),
                    self._workflow_step(str(metadata.get("workflow_step") or "")),
                )
                event = AssignmentEvent(comment=comment, metadata=metadata)
                if event.id not in cancelled_event_ids:
                    active[key] = event
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

    @staticmethod
    def _project_member_ids(db: Session, project: CloudProject) -> set[int]:
        member_ids = {int(project.created_by_user_id or 0)}
        rows = (
            db.query(ResourceMember.entity_id)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == project.id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        for (entity_id,) in rows:
            try:
                member_ids.add(int(entity_id))
            except (TypeError, ValueError):
                continue
        member_ids.discard(0)
        return member_ids


issue_assignment_service = IssueAssignmentService()
