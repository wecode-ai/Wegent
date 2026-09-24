# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Query, presentation, and project configuration support for Issue dispatch."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    IssueDispatch,
    IssueDispatchRound,
    IssueDispatchTask,
    LoopItem,
    ProjectChatAgent,
    loop_datetime_value_is_unset,
)
from app.models.user import User
from app.schemas.issue_dispatch import (
    IssueDispatchRoundView,
    IssueDispatchTaskView,
    IssueDispatchView,
)
from app.services.issue_dispatch_repository import issue_dispatch_repository
from app.services.issue_dispatch_state_machine import issue_dispatch_state_machine
from app.services.loop_item_status_history import (
    project_board_statuses,
    write_status_change,
)
from app.services.loop_item_unread import advance_content_revision
from app.services.workspaces import workspace_service


class IssueDispatchSupport:
    """Resolve project targets and serialize the dispatch aggregate."""

    def validate_target(
        self,
        db: Session,
        *,
        project: CloudProject,
        project_members: list[dict[str, Any]],
        project_groups: list[dict[str, Any]],
        target_type: str,
        target_id: str,
    ) -> tuple[str, dict[str, object] | None, str]:
        if target_type == "human":
            try:
                target_user_id = int(target_id)
            except ValueError as exc:
                raise HTTPException(422, "Dispatch user id must be numeric") from exc
            target = db.get(User, target_user_id)
            if target is None:
                raise HTTPException(422, "Dispatch user was not found")
            if not any(str(value["user_id"]) == target_id for value in project_members):
                raise HTTPException(422, "Dispatch user is not a project member")
            return target.user_name, None, "human"
        if target_type == "agent":
            agent = db.get(ProjectChatAgent, target_id)
            if (
                agent is None
                or agent.cloud_project_id != str(project.id)
                or agent.status != "active"
            ):
                raise HTTPException(422, "Dispatch agent is not active in this project")
            return (
                str(agent.title or agent.name or agent.id),
                None,
                self.agent_execution_location(agent),
            )
        group = self.project_group(project_groups, target_id)
        leader = group.get("leader")
        if not isinstance(leader, dict):
            raise HTTPException(422, "Dispatch collaboration group has no leader")
        return str(group.get("name") or target_id), dict(leader), "mixed"

    @staticmethod
    def transition_issue(
        *,
        issue: LoopItem,
        project: CloudProject,
        target_status: str,
        actor_user_id: int,
        trigger: str,
    ) -> None:
        if issue.status == target_status:
            return
        valid_statuses = {entry_id for entry_id, _ in project_board_statuses(project)}
        if target_status not in valid_statuses:
            raise HTTPException(409, f"Project board lacks status {target_status}")
        metadata = dict(issue.metadata_json or {})
        write_status_change(
            metadata,
            project=project,
            from_status=str(issue.status or ""),
            to_status=target_status,
            trigger=trigger,
            by_user_id=actor_user_id,
        )
        issue.metadata_json = advance_content_revision(
            metadata, actor_user_id=actor_user_id
        )
        issue.status = target_status
        issue.completed_at = (
            issue_dispatch_state_machine.now() if target_status == "completed" else None
        )
        issue.sort_order = 0
        issue.version += 1

    def view(self, db: Session, dispatch: IssueDispatch) -> IssueDispatchView:
        metadata = self.metadata(dispatch)
        leader = metadata.get("leader")
        leader_value = leader if isinstance(leader, dict) else {}
        return IssueDispatchView(
            id=dispatch.id,
            project_id=str(dispatch.cloud_project_id),
            issue_id=str(dispatch.parent_id),
            target_type=str(metadata.get("target_type") or "human"),
            target_id=str(metadata.get("target_id") or ""),
            target_name=str(metadata.get("target_name") or ""),
            status=dispatch.status,
            leader_type=leader_value.get("kind"),
            leader_id=(str(leader_value.get("id")) if leader_value.get("id") else None),
            leader_name=(
                self.member_name(
                    db,
                    str(leader_value.get("kind")),
                    str(leader_value.get("id")),
                )
                if leader_value.get("kind") in {"human", "agent"}
                and leader_value.get("id")
                else None
            ),
            manager_turn_count=int(metadata.get("manager_turn_count") or 0),
            execution_location=str(metadata.get("execution_location") or ""),
            active_round_id=metadata.get("active_round_id"),
            rounds=[
                self.round_view(db, value)
                for value in issue_dispatch_repository.rounds(db, dispatch.id)
            ],
            created_at=dispatch.created_at,
            updated_at=dispatch.updated_at,
            completed_at=self.completed_at(dispatch.completed_at),
        )

    def round_view(
        self, db: Session, round_record: IssueDispatchRound
    ) -> IssueDispatchRoundView:
        return IssueDispatchRoundView(
            id=round_record.id,
            sequence=int(round_record.sort_order or 0),
            status=round_record.status,
            tasks=[
                self.task_view(task)
                for task in issue_dispatch_repository.tasks(db, round_record.id)
            ],
            created_at=round_record.created_at,
            updated_at=round_record.updated_at,
            completed_at=self.completed_at(round_record.completed_at),
        )

    def task_view(self, task: IssueDispatchTask) -> IssueDispatchTaskView:
        metadata = self.metadata(task)
        return IssueDispatchTaskView(
            id=task.id,
            task_title=task.title,
            instructions=str(metadata.get("instructions") or ""),
            assignee_type=str(metadata.get("assignee_type") or "human"),
            assignee_id=str(metadata.get("assignee_id") or ""),
            assignee_name=str(metadata.get("assignee_name") or ""),
            workflow_stage_id=(
                str(metadata.get("workflow_stage_id"))
                if metadata.get("workflow_stage_id")
                else None
            ),
            status=task.status,
            linked_item_id=str(task.loop_item_id) if task.loop_item_id else None,
            execution_id=(
                int(metadata["execution_id"]) if metadata.get("execution_id") else None
            ),
            execution_location=(
                str(metadata.get("execution_location"))
                if metadata.get("execution_location") in {"local", "cloud"}
                else None
            ),
            delivery_id=(
                str(task.current_delivery_id) if task.current_delivery_id else None
            ),
            summary=task.description or "",
            created_at=task.created_at,
            updated_at=task.updated_at,
        )

    def group(
        self,
        db: Session,
        project: CloudProject,
        dispatch: IssueDispatch,
    ) -> dict[str, Any]:
        groups = workspace_service.list_project_collaboration_groups(
            db, project.id, int(dispatch.created_by_user_id or 0)
        )
        return self.project_group(
            groups,
            str(self.metadata(dispatch).get("target_id") or ""),
        )

    @staticmethod
    def project_group(groups: list[dict[str, Any]], group_id: str) -> dict[str, Any]:
        group = next(
            (value for value in groups if str(value.get("id")) == group_id),
            None,
        )
        if group is None:
            raise HTTPException(422, "Dispatch collaboration group was not found")
        return group

    @staticmethod
    def workflow_stage_ids(project: CloudProject) -> set[str]:
        definition = IssueDispatchSupport.workflow_definition(project)
        nodes = definition.get("nodes") if definition else None
        if not isinstance(nodes, list):
            return set()
        return {
            str(node["id"])
            for node in nodes
            if isinstance(node, dict)
            and node.get("id")
            and str(node.get("node_type") or "task") not in {"event", "loop_start"}
        }

    @staticmethod
    def project_workflow_rules(project: CloudProject) -> str:
        definition = IssueDispatchSupport.workflow_definition(project)
        stages = definition.get("nodes") if definition else None
        if not isinstance(stages, list):
            return ""
        lines = [
            f"- {stage.get('name') or stage.get('id')}: "
            f"{stage.get('description') or ''}"
            for stage in stages
            if isinstance(stage, dict)
            and stage.get("id")
            and str(stage.get("node_type") or "task") not in {"event", "loop_start"}
        ]
        return "Configured workflow stages:\n" + "\n".join(lines) if lines else ""

    @staticmethod
    def workflow_definition(project: CloudProject) -> dict[str, Any]:
        metadata = (
            project.metadata_json if isinstance(project.metadata_json, dict) else {}
        )
        definition = metadata.get("workflow_definition")
        return definition if isinstance(definition, dict) else {}

    @staticmethod
    def member_name(db: Session, assignee_type: str, assignee_id: str) -> str:
        if assignee_type == "human":
            user = db.get(User, int(assignee_id))
            return user.user_name if user is not None else assignee_id
        agent = db.get(ProjectChatAgent, assignee_id)
        return (
            str(agent.title or agent.name or agent.id)
            if agent is not None
            else assignee_id
        )

    @staticmethod
    def agent_execution_location(agent: ProjectChatAgent) -> str:
        metadata = agent.metadata_json if isinstance(agent.metadata_json, dict) else {}
        if metadata.get("runtime") == "wegent":
            return "cloud"
        return str(metadata.get("execution_environment") or "local")

    @staticmethod
    def metadata(record: Any) -> dict[str, Any]:
        return issue_dispatch_state_machine.metadata(record)

    @staticmethod
    def completed_at(value: Any) -> Any:
        return None if loop_datetime_value_is_unset(value) else value


issue_dispatch_support = IssueDispatchSupport()
