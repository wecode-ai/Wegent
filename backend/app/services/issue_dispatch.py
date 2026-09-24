# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Application service for explicit human, agent, and group dispatch."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    Delivery,
    IssueDispatch,
    IssueDispatchOutcome,
    IssueDispatchRound,
    IssueDispatchTask,
    LoopItem,
    LoopItemComment,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.schemas.issue_dispatch import (
    IssueDispatchCreate,
    IssueDispatchDecisionCreate,
    IssueDispatchOutcomeCreate,
    IssueDispatchRoundCreate,
    IssueDispatchRoundTaskCreate,
    IssueDispatchRoundView,
    IssueDispatchTaskView,
    IssueDispatchView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.service import cloud_project_service
from app.services.issue_dispatch_assignment import (
    MANAGER_SYSTEM_INSTRUCTIONS,
    issue_dispatch_assignment,
)
from app.services.issue_dispatch_domain import (
    DispatchConflict,
    direct_outcome,
    evaluate_round_barrier,
)
from app.services.issue_dispatch_repository import (
    DispatchChain,
    DispatchTaskChain,
    issue_dispatch_repository,
)
from app.services.issue_dispatch_state_machine import issue_dispatch_state_machine
from app.services.issue_dispatch_support import issue_dispatch_support
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_status_history import project_board_statuses
from app.services.workspaces import workspace_service
from shared.telemetry.decorators import trace_sync


class IssueDispatchService:
    """Own the dispatch state machines and delegate execution to runtime ports."""

    def active(self, db: Session, issue_id: str) -> IssueDispatch | None:
        return issue_dispatch_repository.active(db, issue_id)

    def list(self, db: Session, *, issue_id: str, user_id: int) -> list[IssueDispatch]:
        self._issue(db, issue_id, user_id)
        return issue_dispatch_repository.list(db, issue_id)

    def get(self, db: Session, *, dispatch_id: str, user_id: int) -> IssueDispatch:
        chain = issue_dispatch_repository.chain(db, dispatch_id)
        if chain is None:
            raise HTTPException(404, "Issue dispatch not found")
        project = self._project_for_issue(db, chain.issue)
        require_cloud_project_role(db, project.id, user_id, BaseRole.Viewer)
        return chain.dispatch

    def candidates(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
        target_type: str | None = None,
    ) -> list[dict[str, str]]:
        _issue, project = self._issue(db, issue_id, user_id)
        humans = [
            {
                "target_type": "human",
                "target_id": str(member["user_id"]),
                "name": str(member["user_name"]),
                "execution_location": "human",
            }
            for member in cloud_project_service.list_members(db, project.id, user_id)
        ]
        agents = [
            {
                "target_type": "agent",
                "target_id": str(agent.id),
                "name": str(agent.title or agent.name or agent.id),
                "execution_location": (
                    issue_dispatch_support.agent_execution_location(agent)
                ),
            }
            for agent in (
                db.query(ProjectChatAgent)
                .filter(
                    ProjectChatAgent.cloud_project_id == str(project.id),
                    ProjectChatAgent.status == "active",
                )
                .order_by(ProjectChatAgent.created_at, ProjectChatAgent.id)
                .all()
            )
        ]
        groups = [
            {
                "target_type": "group",
                "target_id": str(group["id"]),
                "name": str(group.get("name") or group["id"]),
                "execution_location": "mixed",
            }
            for group in workspace_service.list_project_collaboration_groups(
                db, project.id, user_id
            )
        ]
        candidates = [*humans, *agents, *groups]
        if target_type is None:
            return candidates
        return [
            candidate
            for candidate in candidates
            if candidate["target_type"] == target_type
        ]

    @trace_sync("issue_dispatch.create", tracer_name="backend")
    def create(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
        values: IssueDispatchCreate,
    ) -> tuple[IssueDispatch, bool]:
        issue, project = self._issue(db, issue_id, user_id, for_update=True)
        existing = issue_dispatch_repository.by_idempotency(
            db, issue.id, values.idempotency_key
        )
        if existing is not None:
            return existing, False
        if issue_dispatch_repository.active(db, issue.id) is not None:
            raise HTTPException(409, "Issue already has an active dispatch")

        target_name, leader, execution_location = (
            issue_dispatch_support.validate_target(
                db,
                project=project,
                project_members=(
                    cloud_project_service.list_members(db, project.id, user_id)
                    if values.target_type == "human"
                    else []
                ),
                project_groups=(
                    workspace_service.list_project_collaboration_groups(
                        db, project.id, user_id
                    )
                    if values.target_type == "group"
                    else []
                ),
                target_type=values.target_type,
                target_id=values.target_id,
            )
        )
        dispatch = IssueDispatch(
            id=str(uuid4()),
            cloud_project_id=str(project.id),
            parent_id=issue.id,
            title=values.task_title or issue.title,
            description=values.instructions,
            status="active",
            created_by_user_id=user_id,
            metadata_json={
                "target_type": values.target_type,
                "target_id": values.target_id,
                "target_name": target_name,
                "idempotency_key": values.idempotency_key,
                "leader": leader,
                "execution_location": execution_location,
                "active_round_id": None,
                "manager_turn_count": 0,
            },
        )
        db.add(dispatch)
        db.flush()
        issue_dispatch_support.transition_issue(
            issue=issue,
            project=project,
            target_status="in_progress",
            actor_user_id=user_id,
            trigger="dispatch_started",
        )
        self._event(
            db,
            issue=issue,
            actor_user_id=user_id,
            event_type="dispatch.created",
            metadata={
                "dispatch_id": dispatch.id,
                "target_type": values.target_type,
                "target_id": values.target_id,
                "target_name": target_name,
                "task_title": dispatch.title,
            },
        )
        if values.target_type in {"human", "agent"}:
            task = IssueDispatchRoundTaskCreate(
                task_title=dispatch.title,
                instructions=values.instructions or dispatch.title,
                assignee_type=values.target_type,
                assignee_id=values.target_id,
            )
            issue_dispatch_assignment.open_round(
                db,
                issue=issue,
                project=project,
                dispatch=dispatch,
                user_id=user_id,
                idempotency_key=f"direct:{values.idempotency_key}",
                tasks=[task],
                direct=True,
            )
        else:
            issue_dispatch_assignment.request_leader_turn(
                db,
                issue=issue,
                project=project,
                dispatch=dispatch,
                actor_user_id=user_id,
                reason="dispatch_created",
            )
        db.commit()
        db.refresh(dispatch)
        db.refresh(issue)
        publish_loop_item_changed(
            db, item=issue, reason="dispatch_created", actor_user_id=user_id
        )
        return dispatch, True

    @trace_sync("issue_dispatch.create_round", tracer_name="backend")
    def create_round(
        self,
        db: Session,
        *,
        dispatch_id: str,
        user_id: int,
        values: IssueDispatchRoundCreate,
        actor_agent_id: str | None = None,
        actor_dispatch_role: str | None = None,
    ) -> IssueDispatchRound:
        chain, project = self._dispatch(db, dispatch_id, user_id, for_update=True)
        self._require_group(chain.dispatch)
        self._require_leader(
            chain.dispatch,
            user_id=user_id,
            actor_agent_id=actor_agent_id,
            actor_dispatch_role=actor_dispatch_role,
        )
        existing = issue_dispatch_repository.round_by_idempotency(
            db, dispatch_id, values.idempotency_key
        )
        if existing is not None:
            return existing
        round_record = issue_dispatch_assignment.open_round(
            db,
            issue=chain.issue,
            project=project,
            dispatch=chain.dispatch,
            user_id=user_id,
            idempotency_key=values.idempotency_key,
            tasks=values.tasks,
            direct=False,
        )
        db.commit()
        db.refresh(round_record)
        publish_loop_item_changed(
            db,
            item=chain.issue,
            reason="dispatch_round_created",
            actor_user_id=user_id,
        )
        return round_record

    def activate(self, db: Session, dispatch: IssueDispatch) -> None:
        """Schedule every queued execution created by this dispatch command."""

        linked_ids = [
            str(task.loop_item_id)
            for round_record in issue_dispatch_repository.rounds(db, dispatch.id)
            for task in issue_dispatch_repository.tasks(db, round_record.id)
            if task.status == "queued" and task.loop_item_id
        ]
        metadata = self._metadata(dispatch)
        linked_ids.extend(
            str(value)
            for value in metadata.get("pending_manager_item_ids", [])
            if value
        )
        if not linked_ids:
            return
        from app.services.board_team_execution import schedule_board_robot_execution

        for item_id in dict.fromkeys(linked_ids):
            execution = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.loop_item_id == item_id,
                    LoopItemExecution.status == "queued",
                )
                .order_by(LoopItemExecution.id.desc())
                .first()
            )
            if execution is not None:
                schedule_board_robot_execution(db, execution)

    @trace_sync("issue_dispatch.report_outcome", tracer_name="backend")
    def report_outcome(
        self,
        db: Session,
        *,
        task_id: str,
        user_id: int,
        values: IssueDispatchOutcomeCreate,
        source_delivery: Delivery | None = None,
    ) -> IssueDispatchOutcome:
        chain = issue_dispatch_repository.task_chain(db, task_id, for_update=True)
        if chain is None:
            raise HTTPException(404, "Dispatch task not found")
        project = self._project_for_issue(db, chain.issue)
        require_cloud_project_role(db, project.id, user_id, BaseRole.Developer)
        existing = issue_dispatch_repository.outcome_by_event(
            db, chain.task.id, values.event_id
        )
        if existing is not None:
            return existing
        task_metadata = self._metadata(chain.task)
        if task_metadata.get("assignee_type") == "human":
            if str(task_metadata.get("assignee_id") or "") != str(user_id):
                raise HTTPException(
                    403, "Only the assigned human can report this outcome"
                )
            if (
                source_delivery is None
                or values.status != "submitted"
                or values.delivery_id != str(source_delivery.id)
                or source_delivery.status != "delivered"
                or str(source_delivery.loop_item_id)
                != str(chain.task.loop_item_id or "")
                or source_delivery.created_by_user_id != user_id
            ):
                raise HTTPException(
                    422,
                    "Human dispatch outcomes must come from the assigned "
                    "task's finalized Delivery",
                )
        outcome = IssueDispatchOutcome(
            id=str(
                uuid5(
                    NAMESPACE_URL,
                    f"issue-dispatch-outcome:{chain.task.id}:{values.event_id}",
                )
            ),
            cloud_project_id=chain.task.cloud_project_id,
            parent_id=chain.task.id,
            loop_item_id=chain.issue.id,
            delivery_id=values.delivery_id,
            title=chain.task.title,
            description=values.summary,
            status=values.status,
            created_by_user_id=user_id,
            metadata_json={
                "event_id": values.event_id,
                "evidence": values.evidence,
            },
        )
        db.add(outcome)
        try:
            issue_dispatch_state_machine.finish_task(
                chain.task,
                status=values.status,
                summary=values.summary,
                delivery_id=values.delivery_id,
            )
        except DispatchConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            existing = issue_dispatch_repository.outcome_by_event(
                db, task_id, values.event_id
            )
            if existing is not None:
                return existing
            raise
        self._event(
            db,
            issue=chain.issue,
            actor_user_id=user_id,
            event_type="dispatch.task_finished",
            metadata={
                "dispatch_id": chain.dispatch.id,
                "round_id": chain.round.id,
                "dispatch_task_id": chain.task.id,
                "task_title": chain.task.title,
                "assignee_type": task_metadata.get("assignee_type"),
                "assignee_id": task_metadata.get("assignee_id"),
                "assignee_name": task_metadata.get("assignee_name"),
                "status": values.status,
                "delivery_id": values.delivery_id,
            },
        )
        db.flush()
        self._apply_barrier(
            db,
            project=project,
            chain=chain,
            actor_user_id=user_id,
        )
        db.commit()
        db.refresh(outcome)
        publish_loop_item_changed(
            db, item=chain.issue, reason="dispatch_outcome", actor_user_id=user_id
        )
        return outcome

    def cancel_task(
        self, db: Session, *, task_id: str, user_id: int, reason: str = ""
    ) -> IssueDispatchTask:
        chain = self._task_chain(db, task_id, user_id)
        if chain.task.status in {"submitted", "failed", "needs_rework", "cancelled"}:
            return chain.task
        execution = self._task_execution(db, chain.task)
        if execution is not None:
            from app.services.loop_item_executions.service import (
                loop_item_execution_service,
            )

            cancelled_execution = loop_item_execution_service.cancel(
                db,
                execution_id=execution.id,
                note=reason or "Issue dispatch task cancelled",
                commit=False,
            )
            db.refresh(chain.task)
        if chain.task.status in {
            "submitted",
            "failed",
            "needs_rework",
            "cancelled",
        }:
            return chain.task
        if execution is not None:
            db.commit()
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations([cancelled_execution])
            return chain.task
        task_metadata = self._metadata(chain.task)
        issue_dispatch_state_machine.cancel_task(chain.task)
        self._event(
            db,
            issue=chain.issue,
            actor_user_id=user_id,
            event_type="dispatch.task_finished",
            metadata={
                "dispatch_id": chain.dispatch.id,
                "round_id": chain.round.id,
                "dispatch_task_id": chain.task.id,
                "task_title": chain.task.title,
                "assignee_type": task_metadata.get("assignee_type"),
                "assignee_id": task_metadata.get("assignee_id"),
                "assignee_name": task_metadata.get("assignee_name"),
                "status": "cancelled",
                "delivery_id": None,
            },
        )
        db.flush()
        self._apply_barrier(
            db,
            project=self._project_for_issue(db, chain.issue),
            chain=chain,
            actor_user_id=user_id,
        )
        db.commit()
        db.refresh(chain.task)
        publish_loop_item_changed(
            db,
            item=chain.issue,
            reason="dispatch_task_cancelled",
            actor_user_id=user_id,
        )
        return chain.task

    def retry_task(
        self, db: Session, *, task_id: str, user_id: int
    ) -> IssueDispatchRound:
        chain = self._task_chain(db, task_id, user_id)
        self._require_direct(chain.dispatch)
        if chain.task.status not in {"failed", "needs_rework", "cancelled"}:
            raise HTTPException(409, "Only an unsuccessful task can be retried")
        metadata = self._metadata(chain.task)
        direct = self._metadata(chain.dispatch).get("target_type") in {
            "human",
            "agent",
        }
        round_record = issue_dispatch_assignment.open_round(
            db,
            issue=chain.issue,
            project=self._project_for_issue(db, chain.issue),
            dispatch=chain.dispatch,
            user_id=user_id,
            idempotency_key=f"retry:{task_id}:{chain.task.version}",
            tasks=[
                IssueDispatchRoundTaskCreate(
                    task_title=chain.task.title,
                    instructions=str(metadata.get("instructions") or chain.task.title),
                    assignee_type=str(metadata.get("assignee_type") or "human"),
                    assignee_id=str(metadata.get("assignee_id") or ""),
                    workflow_stage_id=metadata.get("workflow_stage_id"),
                )
            ],
            direct=direct,
        )
        db.commit()
        db.refresh(round_record)
        return round_record

    def retry(self, db: Session, *, dispatch_id: str, user_id: int) -> IssueDispatch:
        chain, _project = self._dispatch(db, dispatch_id, user_id, for_update=True)
        retryable = next(
            (
                task
                for round_record in reversed(
                    issue_dispatch_repository.rounds(db, chain.dispatch.id)
                )
                for task in reversed(
                    issue_dispatch_repository.tasks(db, round_record.id)
                )
                if task.status in {"failed", "needs_rework", "cancelled"}
            ),
            None,
        )
        if retryable is None:
            raise HTTPException(409, "Dispatch has no retryable task")
        self.retry_task(db, task_id=retryable.id, user_id=user_id)
        db.refresh(chain.dispatch)
        return chain.dispatch

    def return_for_rework(
        self, db: Session, *, task_id: str, user_id: int, reason: str = ""
    ) -> IssueDispatchTask:
        chain = self._task_chain(db, task_id, user_id, require_active=False)
        self._require_direct(chain.dispatch)
        project = self._project_for_issue(db, chain.issue)
        try:
            issue_dispatch_state_machine.return_task_for_rework(
                chain.task, reason=reason
            )
            reopened = issue_dispatch_state_machine.reopen_dispatch(chain.dispatch)
        except DispatchConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        if reopened:
            issue_dispatch_support.transition_issue(
                issue=chain.issue,
                project=project,
                target_status="in_progress",
                actor_user_id=user_id,
                trigger="dispatch_returned_for_rework",
            )
        self._event(
            db,
            issue=chain.issue,
            actor_user_id=user_id,
            event_type="dispatch.task_returned",
            metadata={
                "dispatch_id": chain.dispatch.id,
                "dispatch_task_id": chain.task.id,
                "reason": reason,
            },
        )
        db.commit()
        db.refresh(chain.task)
        return chain.task

    def return_dispatch_for_rework(
        self,
        db: Session,
        *,
        dispatch_id: str,
        user_id: int,
        reason: str = "",
    ) -> IssueDispatch:
        chain, _project = self._dispatch(db, dispatch_id, user_id, for_update=True)
        submitted = next(
            (
                task
                for round_record in reversed(
                    issue_dispatch_repository.rounds(db, chain.dispatch.id)
                )
                for task in reversed(
                    issue_dispatch_repository.tasks(db, round_record.id)
                )
                if task.status == "submitted"
            ),
            None,
        )
        if submitted is None:
            raise HTTPException(409, "Dispatch has no submitted task")
        self.return_for_rework(
            db,
            task_id=submitted.id,
            user_id=user_id,
            reason=reason,
        )
        db.refresh(chain.dispatch)
        return chain.dispatch

    def dispatch_for_task(
        self, db: Session, *, task_id: str, user_id: int
    ) -> IssueDispatch:
        return self._task_chain(db, task_id, user_id, require_active=False).dispatch

    @trace_sync("issue_dispatch.decide", tracer_name="backend")
    def decide(
        self,
        db: Session,
        *,
        dispatch_id: str,
        user_id: int,
        values: IssueDispatchDecisionCreate,
        actor_agent_id: str | None = None,
        actor_dispatch_role: str | None = None,
    ) -> IssueDispatch:
        chain, project = self._dispatch(db, dispatch_id, user_id, for_update=True)
        self._require_group(chain.dispatch)
        self._require_leader(
            chain.dispatch,
            user_id=user_id,
            actor_agent_id=actor_agent_id,
            actor_dispatch_role=actor_dispatch_role,
        )
        metadata = self._metadata(chain.dispatch)
        decisions = list(metadata.get("decisions") or [])
        if any(
            isinstance(value, dict)
            and value.get("idempotency_key") == values.idempotency_key
            for value in decisions
        ):
            return chain.dispatch
        valid_statuses = {entry_id for entry_id, _ in project_board_statuses(project)}
        if values.target_status not in valid_statuses:
            raise HTTPException(422, "Issue status is not configured for this project")
        issue_dispatch_support.transition_issue(
            issue=chain.issue,
            project=project,
            target_status=values.target_status,
            actor_user_id=user_id,
            trigger="dispatch_leader_decision",
        )
        active_round = issue_dispatch_repository.active_round(db, chain.dispatch.id)
        if active_round is not None:
            if active_round.status != "evaluating":
                raise HTTPException(
                    409, "The current round has not reached its barrier"
                )
            try:
                issue_dispatch_state_machine.close_round(active_round)
            except DispatchConflict as exc:
                raise HTTPException(409, str(exc)) from exc
        decisions.append(
            {
                "idempotency_key": values.idempotency_key,
                "target_status": values.target_status,
                "reason": values.reason,
                "actor_user_id": user_id,
                "actor_agent_id": actor_agent_id,
                "at": self._now().isoformat(),
            }
        )
        chain.dispatch.metadata_json = {
            **metadata,
            "active_round_id": None,
            "decisions": decisions,
        }
        try:
            issue_dispatch_state_machine.complete_dispatch(chain.dispatch)
        except DispatchConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        self._event(
            db,
            issue=chain.issue,
            actor_user_id=user_id,
            event_type="dispatch.decision",
            metadata={
                "dispatch_id": chain.dispatch.id,
                "to_status": values.target_status,
                "reason": values.reason,
            },
        )
        db.commit()
        db.refresh(chain.dispatch)
        publish_loop_item_changed(
            db,
            item=chain.issue,
            reason="dispatch_decision",
            actor_user_id=user_id,
        )
        return chain.dispatch

    @trace_sync("issue_dispatch.cancel", tracer_name="backend")
    def cancel(self, db: Session, *, dispatch_id: str, user_id: int) -> IssueDispatch:
        chain, _project = self._dispatch(db, dispatch_id, user_id, for_update=True)
        executions: list[LoopItemExecution] = []
        for round_record in issue_dispatch_repository.rounds(db, chain.dispatch.id):
            issue_dispatch_state_machine.cancel_round(round_record)
            for task in issue_dispatch_repository.tasks(db, round_record.id):
                if task.status in {"submitted", "failed", "needs_rework", "cancelled"}:
                    continue
                issue_dispatch_state_machine.cancel_task(task)
                if task.loop_item_id:
                    execution = (
                        db.query(LoopItemExecution)
                        .filter(
                            LoopItemExecution.loop_item_id == str(task.loop_item_id),
                            LoopItemExecution.status.in_(
                                {
                                    "pending_approval",
                                    "waiting_runtime",
                                    "queued",
                                    "claimed",
                                    "running",
                                    "cancel_requested",
                                }
                            ),
                        )
                        .order_by(LoopItemExecution.id.desc())
                        .first()
                    )
                    if execution is not None:
                        from app.services.loop_item_executions.service import (
                            loop_item_execution_service,
                        )

                        executions.append(
                            loop_item_execution_service.cancel(
                                db,
                                execution_id=execution.id,
                                note="Issue dispatch cancelled by user",
                                commit=False,
                            )
                        )
        try:
            issue_dispatch_state_machine.cancel_dispatch(chain.dispatch)
        except DispatchConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        self._event(
            db,
            issue=chain.issue,
            actor_user_id=user_id,
            event_type="dispatch.cancelled",
            metadata={"dispatch_id": chain.dispatch.id},
        )
        db.commit()
        if executions:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(executions)
        publish_loop_item_changed(
            db,
            item=chain.issue,
            reason="dispatch_cancelled",
            actor_user_id=user_id,
        )
        return chain.dispatch

    def task_for_linked_item(
        self, db: Session, linked_item_id: str
    ) -> IssueDispatchTask | None:
        return issue_dispatch_repository.task_for_linked_item(db, linked_item_id)

    def on_delivery_finalized(
        self, db: Session, *, delivery: Delivery, user_id: int
    ) -> None:
        task = issue_dispatch_repository.task_for_linked_item(
            db, str(delivery.loop_item_id)
        )
        if task is None:
            return
        self.report_outcome(
            db,
            task_id=task.id,
            user_id=user_id,
            values=IssueDispatchOutcomeCreate(
                event_id=f"delivery:{delivery.id}",
                status="submitted",
                summary=delivery.description or "Delivery submitted",
                delivery_id=str(delivery.id),
            ),
            source_delivery=delivery,
        )

    def on_execution_terminal(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        summary: str,
    ) -> None:
        task = issue_dispatch_repository.task_for_linked_item(
            db, execution.loop_item_id
        )
        if task is None:
            return
        chain = issue_dispatch_repository.task_chain(db, task.id)
        if chain is None:
            return
        outcome_status = {
            "completed": "submitted",
            "failed": "failed",
            "cancelled": "cancelled",
        }.get(execution.status)
        if outcome_status is None:
            return
        self.report_outcome(
            db,
            task_id=task.id,
            user_id=int(
                chain.dispatch.created_by_user_id or execution.assigner_user_id
            ),
            values=IssueDispatchOutcomeCreate(
                event_id=f"execution:{execution.id}:{execution.status}",
                status=outcome_status,
                summary=summary,
            ),
        )

    def on_execution_running(
        self, db: Session, *, execution: LoopItemExecution
    ) -> None:
        task = issue_dispatch_repository.task_for_linked_item(
            db, execution.loop_item_id
        )
        if task is None or task.status == "running":
            return
        issue_dispatch_state_machine.start_task(task)
        db.flush()

    def view(self, db: Session, dispatch: IssueDispatch) -> IssueDispatchView:
        return issue_dispatch_support.view(db, dispatch)

    def round_view(
        self, db: Session, round_record: IssueDispatchRound
    ) -> IssueDispatchRoundView:
        return issue_dispatch_support.round_view(db, round_record)

    def task_view(self, task: IssueDispatchTask) -> IssueDispatchTaskView:
        return issue_dispatch_support.task_view(task)

    def _apply_barrier(
        self,
        db: Session,
        *,
        project: CloudProject,
        chain: DispatchTaskChain,
        actor_user_id: int,
    ) -> None:
        tasks = issue_dispatch_repository.tasks(db, chain.round.id)
        barrier = evaluate_round_barrier([task.status for task in tasks])
        issue_dispatch_state_machine.apply_round_barrier(
            chain.round, status=barrier.round_status
        )
        if not barrier.request_leader_turn:
            return
        metadata = self._metadata(chain.dispatch)
        if metadata.get("target_type") in {"human", "agent"}:
            outcome = direct_outcome(chain.task.status)
            if outcome.issue_status:
                issue_dispatch_support.transition_issue(
                    issue=chain.issue,
                    project=project,
                    target_status=outcome.issue_status,
                    actor_user_id=actor_user_id,
                    trigger="dispatch_direct_outcome",
                )
                issue_dispatch_state_machine.close_round(chain.round)
                issue_dispatch_state_machine.complete_dispatch(chain.dispatch)
            return
        self._event(
            db,
            issue=chain.issue,
            actor_user_id=actor_user_id,
            event_type="dispatch.round_finished",
            metadata={
                "dispatch_id": chain.dispatch.id,
                "round_id": chain.round.id,
                "sequence": chain.round.sort_order,
            },
        )
        issue_dispatch_assignment.request_leader_turn(
            db,
            issue=chain.issue,
            project=project,
            dispatch=chain.dispatch,
            actor_user_id=actor_user_id,
            reason="round_finished",
        )

    def _dispatch(
        self,
        db: Session,
        dispatch_id: str,
        user_id: int,
        *,
        for_update: bool,
    ) -> tuple[DispatchChain, CloudProject]:
        chain = issue_dispatch_repository.chain(db, dispatch_id, for_update=for_update)
        if chain is None:
            raise HTTPException(404, "Issue dispatch not found")
        project = self._project_for_issue(db, chain.issue)
        require_cloud_project_role(db, project.id, user_id, BaseRole.Developer)
        if chain.dispatch.status != "active":
            raise HTTPException(409, "Issue dispatch is not active")
        return chain, project

    def _task_chain(
        self,
        db: Session,
        task_id: str,
        user_id: int,
        *,
        require_active: bool = True,
    ) -> DispatchTaskChain:
        chain = issue_dispatch_repository.task_chain(db, task_id, for_update=True)
        if chain is None:
            raise HTTPException(404, "Dispatch task not found")
        project = self._project_for_issue(db, chain.issue)
        require_cloud_project_role(db, project.id, user_id, BaseRole.Developer)
        if require_active and chain.dispatch.status != "active":
            raise HTTPException(409, "Issue dispatch is not active")
        return chain

    @staticmethod
    def _task_execution(
        db: Session, task: IssueDispatchTask
    ) -> LoopItemExecution | None:
        if not task.loop_item_id:
            return None
        return (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.loop_item_id == str(task.loop_item_id))
            .order_by(LoopItemExecution.id.desc())
            .first()
        )

    def _issue(
        self,
        db: Session,
        issue_id: str,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> tuple[LoopItem, CloudProject]:
        query = db.query(LoopItem).filter(
            LoopItem.id == issue_id,
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        if for_update:
            query = query.with_for_update()
        issue = query.one_or_none()
        if issue is None:
            raise HTTPException(404, "Issue not found")
        project = self._project_for_issue(db, issue)
        require_cloud_project_role(db, project.id, user_id, BaseRole.Developer)
        return issue, project

    @staticmethod
    def _project_for_issue(db: Session, issue: LoopItem) -> CloudProject:
        project = db.get(CloudProject, int(issue.cloud_project_id))
        if project is None:
            raise HTTPException(404, "Project not found")
        return project

    @staticmethod
    def _require_group(dispatch: IssueDispatch) -> None:
        if IssueDispatchService._metadata(dispatch).get("target_type") != "group":
            raise HTTPException(409, "Dispatch does not target a collaboration group")

    @staticmethod
    def _require_direct(dispatch: IssueDispatch) -> None:
        if IssueDispatchService._metadata(dispatch).get("target_type") == "group":
            raise HTTPException(
                409,
                "Collaboration group rework must be planned by its leader",
            )

    @staticmethod
    def _require_leader(
        dispatch: IssueDispatch,
        *,
        user_id: int,
        actor_agent_id: str | None,
        actor_dispatch_role: str | None = None,
    ) -> None:
        leader = IssueDispatchService._metadata(dispatch).get("leader")
        if not isinstance(leader, dict):
            raise HTTPException(409, "Dispatch has no leader")
        leader_kind = str(leader.get("kind") or "")
        leader_id = str(leader.get("id") or "")
        if leader_kind == "human" and leader_id == str(user_id):
            return
        if (
            leader_kind == "agent"
            and actor_dispatch_role == "manager"
            and leader_id == str(actor_agent_id or "")
        ):
            return
        raise HTTPException(403, "Only the collaboration group leader can act")

    @staticmethod
    def _metadata(record: Any) -> dict[str, Any]:
        return issue_dispatch_support.metadata(record)

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

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


issue_dispatch_service = IssueDispatchService()
