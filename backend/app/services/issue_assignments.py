# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authoritative non-exclusive Issue assignments."""

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.issue_assignment import IssueAssignment
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.workspace import WorkspaceAgentBinding
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import (
    IssueAction,
    require_cloud_project_role,
    require_issue_action,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class IssueAssignmentService:
    """Persist assignment facts independently from compatibility projections."""

    def list(
        self,
        db: Session,
        *,
        project_id: int,
        issue_id: str,
        user_id: int,
    ) -> list[IssueAssignment]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.RestrictedAnalyst)
        self._require_issue_project(db, project_id, issue_id)
        return (
            db.query(IssueAssignment)
            .filter(
                IssueAssignment.cloud_project_id == str(project_id),
                IssueAssignment.loop_item_id == issue_id,
                IssueAssignment.active_marker == "active",
            )
            .order_by(IssueAssignment.created_at, IssueAssignment.id)
            .all()
        )

    def active(
        self,
        db: Session,
        *,
        issue_id: str,
        member_type: str,
        member_id: str,
        workflow_step: str | None,
    ) -> IssueAssignment | None:
        return (
            db.query(IssueAssignment)
            .filter(
                IssueAssignment.loop_item_id == issue_id,
                IssueAssignment.member_type == member_type,
                IssueAssignment.member_id == member_id,
                IssueAssignment.workflow_step == self._workflow_step(workflow_step),
                IssueAssignment.active_marker == "active",
            )
            .first()
        )

    def record(
        self,
        db: Session,
        *,
        workspace_id: int | None,
        project_id: int | str,
        issue_id: str,
        member_type: str,
        member_id: str,
        assigned_by_user_id: int,
        workflow_step: str | None,
        notify: bool,
        trigger: str,
        comment_id: str | None = None,
    ) -> tuple[IssueAssignment, bool]:
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
        assignment = IssueAssignment(
            workspace_id=workspace_id,
            cloud_project_id=str(project_id),
            loop_item_id=issue_id,
            member_type=normalized_type,
            member_id=normalized_id,
            assigned_by_user_id=assigned_by_user_id,
            workflow_step=self._workflow_step(workflow_step),
            notify=notify,
            comment_id=comment_id,
            trigger=trigger,
            active_marker="active",
        )
        db.add(assignment)
        db.flush()
        return assignment, True

    def remove(
        self,
        db: Session,
        *,
        project_id: int,
        issue_id: str,
        assignment_id: int,
        user_id: int,
    ) -> IssueAssignment:
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
        assignment = (
            db.query(IssueAssignment)
            .filter(
                IssueAssignment.id == assignment_id,
                IssueAssignment.cloud_project_id == str(project_id),
                IssueAssignment.loop_item_id == issue_id,
                IssueAssignment.active_marker == "active",
            )
            .first()
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Assignment not found")
        assignment.remove(user_id=user_id, removed_at=utcnow())
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
        if team_id_value is None or project.workspace_id is None:
            return "agent", agent.id
        try:
            team_id = int(team_id_value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Project Agent has an invalid Team binding",
            ) from exc
        binding = (
            db.query(WorkspaceAgentBinding)
            .join(Kind, Kind.id == WorkspaceAgentBinding.team_id)
            .filter(
                WorkspaceAgentBinding.workspace_id == project.workspace_id,
                WorkspaceAgentBinding.team_id == team_id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Agent is not authorized in this Workspace",
            )
        return "agent", agent.id

    @staticmethod
    def response_values(
        db: Session,
        assignment: IssueAssignment,
    ) -> dict[str, object]:
        creator = db.get(User, assignment.assigned_by_user_id)
        target_name = ""
        if assignment.member_type == "human":
            try:
                target = db.get(User, int(assignment.member_id))
            except ValueError:
                target = None
            if target is not None:
                target_name = target.user_name
        else:
            agent = db.get(ProjectChatAgent, assignment.member_id)
            if agent is not None:
                target_name = str(agent.title or agent.name or "")
            else:
                try:
                    team = db.get(Kind, int(assignment.member_id))
                except ValueError:
                    team = None
                if team is not None:
                    target_name = team.name
        return {
            "id": assignment.id,
            "issue_id": assignment.loop_item_id,
            "target_type": assignment.member_type,
            "target_id": assignment.member_id,
            "target_name": target_name,
            "workflow_step": assignment.workflow_step or None,
            "comment_id": assignment.comment_id,
            "created_by_user_id": assignment.assigned_by_user_id,
            "created_by_user_name": creator.user_name if creator is not None else None,
            "status": "active" if assignment.is_active else "cancelled",
            "created_at": assignment.created_at,
            "updated_at": assignment.updated_at,
        }

    def project_for_issue(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
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

    def project_legacy_assignment(
        self,
        db: Session,
        *,
        item: LoopItem,
    ) -> None:
        """Project the newest active assignment onto legacy singular columns."""

        latest = (
            db.query(IssueAssignment)
            .filter(
                IssueAssignment.loop_item_id == item.id,
                IssueAssignment.active_marker == "active",
            )
            .order_by(IssueAssignment.created_at.desc(), IssueAssignment.id.desc())
            .first()
        )
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
    def _require_issue_project(
        db: Session,
        project_id: int,
        issue_id: str,
    ) -> LoopItem:
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
