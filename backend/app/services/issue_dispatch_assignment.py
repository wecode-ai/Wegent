# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Round assignment and manager-turn coordination for Issue dispatch."""

from __future__ import annotations

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    IssueDispatch,
    IssueDispatchRound,
    IssueDispatchTask,
    LoopItem,
    LoopItemComment,
    ProjectChatAgent,
)
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_dispatch import IssueDispatchRoundTaskCreate
from app.schemas.project_chat import LoopItemAssign
from app.services.issue_dispatch_domain import (
    DispatchConflict,
    prepare_next_round,
    require_stage_for_group_task,
)
from app.services.issue_dispatch_repository import issue_dispatch_repository
from app.services.issue_dispatch_state_machine import issue_dispatch_state_machine
from app.services.issue_dispatch_support import issue_dispatch_support
from app.services.loop_items.service import loop_item_service
from app.services.wework_notifications import create_notification

MANAGER_SYSTEM_INSTRUCTIONS = """You are the manager for one Issue dispatch.
Use management tools to create one concurrent round at a time. Every assignment
must include a concrete task title, instructions, assignee, and the configured
project stage when stages exist. Never execute member work yourself. After all
tasks in a round finish, inspect their outcomes and either create another round
or explicitly update the Issue status. Only you may decide the Issue status."""


class IssueDispatchAssignment:
    """Create concurrent rounds and hand control back to the group leader."""

    def open_round(
        self,
        db: Session,
        *,
        issue: LoopItem,
        project: CloudProject,
        dispatch: IssueDispatch,
        user_id: int,
        idempotency_key: str,
        tasks: list[IssueDispatchRoundTaskCreate],
        direct: bool,
    ) -> IssueDispatchRound:
        active_round = issue_dispatch_repository.active_round(db, dispatch.id)
        try:
            close_previous = prepare_next_round(
                active_round.status if active_round is not None else None
            )
        except DispatchConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        if close_previous and active_round is not None:
            issue_dispatch_state_machine.close_round(active_round)

        sequence = len(issue_dispatch_repository.rounds(db, dispatch.id)) + 1
        round_record = IssueDispatchRound(
            id=str(uuid4()),
            cloud_project_id=str(project.id),
            parent_id=dispatch.id,
            loop_item_id=issue.id,
            title=f"Round {sequence}",
            description="",
            status="planning",
            sort_order=sequence,
            created_by_user_id=user_id,
            metadata_json={
                "idempotency_key": idempotency_key,
                "direct": direct,
            },
        )
        db.add(round_record)
        db.flush()
        members = self._round_members(db, project, dispatch, direct=direct)
        stage_ids = issue_dispatch_support.workflow_stage_ids(project)
        for index, task in enumerate(tasks):
            self._validate_round_task(
                task,
                direct=direct,
                members=members,
                stage_ids=stage_ids,
            )
            self._create_task(
                db,
                project=project,
                issue=issue,
                dispatch=dispatch,
                round_record=round_record,
                user_id=user_id,
                task=task,
                sort_order=index,
            )
        issue_dispatch_state_machine.begin_round(round_record, dispatch)
        self._event(
            db,
            issue=issue,
            actor_user_id=user_id,
            event_type="dispatch.round_assigned",
            metadata={
                "dispatch_id": dispatch.id,
                "round_id": round_record.id,
                "sequence": sequence,
                "assignments": [
                    {
                        "task_title": task.task_title,
                        "assignee_type": task.assignee_type,
                        "assignee_id": task.assignee_id,
                        "assignee_name": issue_dispatch_support.member_name(
                            db, task.assignee_type, task.assignee_id
                        ),
                        "workflow_stage_id": task.workflow_stage_id,
                    }
                    for task in tasks
                ],
            },
        )
        return round_record

    def request_leader_turn(
        self,
        db: Session,
        *,
        issue: LoopItem,
        project: CloudProject,
        dispatch: IssueDispatch,
        actor_user_id: int,
        reason: str,
    ) -> None:
        leader = issue_dispatch_support.metadata(dispatch).get("leader")
        if not isinstance(leader, dict):
            raise HTTPException(409, "Collaboration group has no leader")
        leader_kind = str(leader.get("kind") or "")
        leader_id = str(leader.get("id") or "")
        if leader_kind == "human":
            self._notify_human_leader(
                db,
                issue=issue,
                project=project,
                dispatch=dispatch,
                leader_id=leader_id,
                actor_user_id=actor_user_id,
                reason=reason,
            )
        elif leader_kind == "agent":
            self._queue_agent_leader(
                db,
                issue=issue,
                project=project,
                dispatch=dispatch,
                leader_id=leader_id,
                actor_user_id=actor_user_id,
                reason=reason,
            )
        else:
            raise HTTPException(409, "Collaboration group leader is invalid")
        metadata = issue_dispatch_support.metadata(dispatch)
        dispatch.metadata_json = {
            **metadata,
            "manager_turn_count": int(metadata.get("manager_turn_count") or 0) + 1,
        }

    def _create_task(
        self,
        db: Session,
        *,
        project: CloudProject,
        issue: LoopItem,
        dispatch: IssueDispatch,
        round_record: IssueDispatchRound,
        user_id: int,
        task: IssueDispatchRoundTaskCreate,
        sort_order: int,
    ) -> IssueDispatchTask:
        linked_item = loop_item_service.create(
            db,
            project.id,
            user_id,
            LoopItemCreate(
                title=task.task_title,
                description=task.instructions,
                priority=issue.priority,
                parent_id=issue.id,
                notify_assignee=False,
            ),
            commit=False,
            assign_creator_if_unassigned=False,
            apply_project_workflow=False,
        )
        linked_item.metadata_json = {
            **issue_dispatch_support.metadata(linked_item),
            **{
                "dispatch_id": dispatch.id,
                "dispatch_round_id": round_record.id,
                "dispatch_child": True,
                "workflow_stage_id": task.workflow_stage_id,
            },
        }
        db.flush()
        assignee_name = issue_dispatch_support.member_name(
            db, task.assignee_type, task.assignee_id
        )
        execution_location = self._execution_location(db, task)
        dispatch_task = IssueDispatchTask(
            id=str(uuid4()),
            cloud_project_id=str(project.id),
            parent_id=round_record.id,
            loop_item_id=linked_item.id,
            title=task.task_title,
            description="",
            status="assigned" if task.assignee_type == "human" else "queued",
            sort_order=sort_order,
            created_by_user_id=user_id,
            metadata_json={
                "instructions": task.instructions,
                "assignee_type": task.assignee_type,
                "assignee_id": task.assignee_id,
                "assignee_name": assignee_name,
                "workflow_stage_id": task.workflow_stage_id,
                "execution_location": execution_location,
            },
        )
        db.add(dispatch_task)
        db.flush()
        loop_item_service.assign(
            db,
            project_id=project.id,
            item_id=linked_item.id,
            user_id=user_id,
            values=LoopItemAssign(
                version=linked_item.version,
                assignee_type=("user" if task.assignee_type == "human" else "agent"),
                assignee_id=task.assignee_id,
                workflow_step=task.workflow_stage_id,
                notify_assignee=False,
                trigger="automation",
            ),
            instruction=task.instructions,
            automation_context=self._executor_context(
                db, dispatch, dispatch_task, task
            ),
            commit=False,
            authorization="issue_dispatch",
        )
        if task.assignee_type == "human":
            self._notify_human_task(
                db,
                project=project,
                issue=issue,
                dispatch=dispatch,
                round_record=round_record,
                dispatch_task=dispatch_task,
                user_id=user_id,
                assignee_name=assignee_name,
            )
        return dispatch_task

    def _queue_agent_leader(
        self,
        db: Session,
        *,
        issue: LoopItem,
        project: CloudProject,
        dispatch: IssueDispatch,
        leader_id: str,
        actor_user_id: int,
        reason: str,
    ) -> None:
        manager_item = self._create_manager_turn(
            db,
            issue=issue,
            project=project,
            dispatch=dispatch,
            leader_agent_id=leader_id,
            actor_user_id=actor_user_id,
            reason=reason,
        )
        metadata = issue_dispatch_support.metadata(dispatch)
        pending = list(metadata.get("pending_manager_item_ids") or [])
        pending.append(manager_item.id)
        dispatch.metadata_json = {
            **metadata,
            "pending_manager_item_ids": pending,
        }
        dispatch.version += 1

    def _create_manager_turn(
        self,
        db: Session,
        *,
        issue: LoopItem,
        project: CloudProject,
        dispatch: IssueDispatch,
        leader_agent_id: str,
        actor_user_id: int,
        reason: str,
    ) -> LoopItem:
        group = issue_dispatch_support.group(db, project, dispatch)
        rules = "\n\n".join(
            value
            for value in (
                str(group.get("instructions") or "").strip(),
                issue_dispatch_support.project_workflow_rules(project),
            )
            if value
        )
        outcomes = self._outcome_summary(db, dispatch.id)
        user_prompt = "\n\n".join(
            value
            for value in (
                f"Issue: {issue.title}",
                f"Issue description:\n{issue.description or ''}",
                f"Reason for this manager turn: {reason}",
                f"Project collaboration rules and workflow:\n{rules}",
                f"Completed round outcomes:\n{outcomes}" if outcomes else "",
            )
            if value
        )
        manager_item = loop_item_service.create(
            db,
            project.id,
            actor_user_id,
            LoopItemCreate(
                title=f"负责人评估：{issue.title}",
                description=user_prompt,
                priority=issue.priority,
                parent_id=issue.id,
                notify_assignee=False,
            ),
            commit=False,
            assign_creator_if_unassigned=False,
            apply_project_workflow=False,
        )
        manager_item.metadata_json = {
            **issue_dispatch_support.metadata(manager_item),
            **{
                "dispatch_manager_turn": True,
                "dispatch_id": dispatch.id,
                "dispatch_reason": reason,
            },
        }
        db.flush()
        loop_item_service.assign(
            db,
            project_id=project.id,
            item_id=manager_item.id,
            user_id=actor_user_id,
            values=LoopItemAssign(
                version=manager_item.version,
                assignee_type="agent",
                assignee_id=leader_agent_id,
                notify_assignee=False,
                trigger="automation",
            ),
            instruction=user_prompt,
            automation_context={
                "source": "issue_dispatch_manager",
                "dispatch_id": dispatch.id,
                "dispatch_task_id": manager_item.id,
                "dispatch_role": "manager",
                "manager_agent_id": leader_agent_id,
                "system_prompt": MANAGER_SYSTEM_INSTRUCTIONS,
            },
            commit=False,
        )
        self._event(
            db,
            issue=issue,
            actor_user_id=actor_user_id,
            event_type="dispatch.manager_turn_started",
            metadata={
                "dispatch_id": dispatch.id,
                "leader_agent_id": leader_agent_id,
                "reason": reason,
                "manager_item_id": manager_item.id,
            },
        )
        return manager_item

    @staticmethod
    def _round_members(
        db: Session,
        project: CloudProject,
        dispatch: IssueDispatch,
        *,
        direct: bool,
    ) -> set[tuple[str, str]]:
        if direct:
            return set()
        group = issue_dispatch_support.group(db, project, dispatch)
        return {
            (str(value.get("kind") or ""), str(value.get("id") or ""))
            for value in group.get("members", [])
            if isinstance(value, dict)
        }

    @staticmethod
    def _validate_round_task(
        task: IssueDispatchRoundTaskCreate,
        *,
        direct: bool,
        members: set[tuple[str, str]],
        stage_ids: set[str],
    ) -> None:
        if not direct and (task.assignee_type, task.assignee_id) not in members:
            raise HTTPException(422, "Dispatch task assignee is not a group member")
        if direct:
            return
        try:
            require_stage_for_group_task(stage_ids, task.workflow_stage_id)
        except DispatchConflict as exc:
            raise HTTPException(422, str(exc)) from exc

    @staticmethod
    def _execution_location(
        db: Session, task: IssueDispatchRoundTaskCreate
    ) -> str | None:
        if task.assignee_type != "agent":
            return None
        agent = db.get(ProjectChatAgent, task.assignee_id)
        return (
            issue_dispatch_support.agent_execution_location(agent)
            if agent is not None
            else None
        )

    @staticmethod
    def _executor_context(
        db: Session,
        dispatch: IssueDispatch,
        dispatch_task: IssueDispatchTask,
        task: IssueDispatchRoundTaskCreate,
    ) -> dict[str, object] | None:
        if task.assignee_type == "human":
            return None
        agent = db.get(ProjectChatAgent, task.assignee_id)
        if agent is None:
            raise HTTPException(422, "Dispatch agent is unavailable")
        leader = issue_dispatch_support.metadata(dispatch).get("leader")
        manager_agent_id = (
            str(leader.get("id") or "")
            if isinstance(leader, dict) and leader.get("kind") == "agent"
            else ""
        )
        return {
            "source": "issue_dispatch",
            "dispatch_id": dispatch.id,
            "dispatch_task_id": dispatch_task.id,
            "dispatch_role": "executor",
            "manager_agent_id": manager_agent_id,
            "runtime_subject_user_id": int(agent.created_by_user_id or 0),
        }

    @staticmethod
    def _notify_human_task(
        db: Session,
        *,
        project: CloudProject,
        issue: LoopItem,
        dispatch: IssueDispatch,
        round_record: IssueDispatchRound,
        dispatch_task: IssueDispatchTask,
        user_id: int,
        assignee_name: str,
    ) -> None:
        create_notification(
            db,
            user_id=int(issue_dispatch_support.metadata(dispatch_task)["assignee_id"]),
            actor_user_id=user_id,
            kind="issue_dispatch_assignment",
            title=f"新任务：{dispatch_task.title}",
            body=f"{assignee_name}，负责人向你分配了协作任务。",
            project_id=str(project.id),
            item_id=str(dispatch_task.loop_item_id),
            payload={
                "projectId": str(project.id),
                "itemId": str(dispatch_task.loop_item_id),
                "issueId": issue.id,
                "dispatchId": dispatch.id,
                "roundId": round_record.id,
                "dispatchTaskId": dispatch_task.id,
                "action": "create_personal_task",
                "idempotencyKey": f"dispatch-task:{dispatch_task.id}",
            },
        )

    @staticmethod
    def _notify_human_leader(
        db: Session,
        *,
        issue: LoopItem,
        project: CloudProject,
        dispatch: IssueDispatch,
        leader_id: str,
        actor_user_id: int,
        reason: str,
    ) -> None:
        create_notification(
            db,
            user_id=int(leader_id),
            actor_user_id=actor_user_id,
            kind="issue_dispatch_manager_turn",
            title=f"需要负责人处理：{issue.title}",
            body=(
                "请分配本轮任务。"
                if reason == "dispatch_created"
                else "本轮任务已结束，请评估结果并决定下一步。"
            ),
            project_id=str(project.id),
            item_id=issue.id,
            payload={
                "projectId": str(project.id),
                "itemId": issue.id,
                "dispatchId": dispatch.id,
                "action": "manage_dispatch",
            },
        )

    @staticmethod
    def _outcome_summary(db: Session, dispatch_id: str) -> str:
        lines: list[str] = []
        for round_record in issue_dispatch_repository.rounds(db, dispatch_id):
            for task in issue_dispatch_repository.tasks(db, round_record.id):
                if task.status not in {
                    "submitted",
                    "failed",
                    "needs_rework",
                    "cancelled",
                }:
                    continue
                lines.append(
                    f"- Round {round_record.sort_order}: {task.title} "
                    f"[{task.status}] {task.description or ''}".strip()
                )
        return "\n".join(lines)

    @staticmethod
    def _event(
        db: Session,
        *,
        issue: LoopItem,
        actor_user_id: int,
        event_type: str,
        metadata: dict[str, object],
    ) -> None:
        db.add(
            LoopItemComment(
                id=str(uuid4()),
                cloud_project_id=str(issue.cloud_project_id),
                loop_item_id=issue.id,
                description="",
                created_by_user_id=actor_user_id,
                updated_by_user_id=actor_user_id,
                status="active",
                metadata_json={"event_type": event_type, **metadata},
            )
        )


issue_dispatch_assignment = IssueDispatchAssignment()
