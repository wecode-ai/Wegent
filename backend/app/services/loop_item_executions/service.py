# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project robot queue execution records.

The queue is a derived view over `loop_item_executions`: any row in a
non-terminal state is part of the queue. This service owns the run lifecycle
(assignment -> approval -> queued -> capacity-gated claim -> running ->
terminal) plus lease-based recovery so multi-device local pullers and
multi-worker cloud dispatchers never double-claim a run.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution

logger = logging.getLogger(__name__)

STATUS_PENDING_APPROVAL = "pending_approval"
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

TERMINAL_STATUSES = {STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED}
ACTIVE_STATUSES = {STATUS_PENDING_APPROVAL, STATUS_QUEUED, STATUS_RUNNING}

PRIORITY_WEIGHTS = {
    "none": 0,
    "low": 10,
    "medium": 20,
    "high": 30,
    "urgent": 40,
}

DEFAULT_MAX_RETRIES = 1
DEFAULT_LEASE_SECONDS = 5 * 60


def priority_weight(priority: Optional[str]) -> int:
    """Map a task priority label to a queue order weight (higher jumps first)."""

    return PRIORITY_WEIGHTS.get(priority or "none", 0)


def utcnow() -> datetime:
    """Naive UTC timestamp matching the loop_items convention."""

    return datetime.now(timezone.utc).replace(tzinfo=None)


class LoopItemExecutionService:
    """Lifecycle and claiming operations for robot queue runs."""

    # ------------------------------------------------------------------
    # Creation and approval
    # ------------------------------------------------------------------

    def create_for_assignment(
        self,
        db: Session,
        *,
        item: LoopItem,
        agent: ProjectChatAgent,
        assigner_user_id: int,
        environment: str,
        execution_device_id: Optional[str],
        priority: Optional[str],
    ) -> LoopItemExecution:
        """Create a run row when a task is assigned to a robot.

        A manual-approval robot starts in `pending_approval`; an auto robot
        enters the queue immediately.
        """

        from app.services.project_chat.service import bot_config

        mode = str(bot_config(agent).get("execution_mode") or "auto")
        now = utcnow()
        row = LoopItemExecution(
            loop_item_id=item.id,
            cloud_project_id=item.cloud_project_id,
            agent_id=agent.id,
            execution_environment=environment,
            execution_device_id=execution_device_id,
            assigner_user_id=assigner_user_id,
            status=(
                STATUS_PENDING_APPROVAL if mode == "manual_approval" else STATUS_QUEUED
            ),
            priority_weight=priority_weight(priority),
            queued_at=now,
            max_retries=DEFAULT_MAX_RETRIES,
            approval_status=("pending" if mode == "manual_approval" else None),
        )
        db.add(row)
        db.flush()
        return row

    def approve(
        self, db: Session, *, execution_id: int, user_id: int
    ) -> LoopItemExecution:
        """Approve a pending run; only the robot creator may do this."""

        row = self._get_for_creator(db, execution_id, user_id)
        if row.status != STATUS_PENDING_APPROVAL:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Run is not waiting for robot approval"
            )
        now = utcnow()
        row.status = STATUS_QUEUED
        row.queued_at = now
        row.approval_status = "approved"
        row.approved_by_user_id = user_id
        row.approved_at = now
        row.execution_note = ""
        db.commit()
        db.refresh(row)
        return row

    def reject(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
        reason: Optional[str] = None,
    ) -> LoopItemExecution:
        """Reject a pending run; only the robot creator may do this."""

        row = self._get_for_creator(db, execution_id, user_id)
        if row.status != STATUS_PENDING_APPROVAL:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Run is not waiting for robot approval"
            )
        now = utcnow()
        row.status = STATUS_CANCELLED
        row.approval_status = "rejected"
        row.rejected_reason = reason
        row.execution_note = reason or "Robot creator rejected the run"
        row.completed_at = now
        db.commit()
        db.refresh(row)
        return row

    def cancel(
        self, db: Session, *, execution_id: int, note: Optional[str] = None
    ) -> LoopItemExecution:
        """Cancel a run that is queued or stuck (for example on unassign)."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        if row.status in TERMINAL_STATUSES:
            return row
        now = utcnow()
        row.status = STATUS_CANCELLED
        row.completed_at = now
        if note:
            row.execution_note = note
        db.commit()
        db.refresh(row)
        return row

    # ------------------------------------------------------------------
    # Capacity-gated claiming
    # ------------------------------------------------------------------

    def claim(
        self,
        db: Session,
        *,
        agent_id: str,
        execution_device_id: str,
        environment: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
        assigner_filter: Optional[int] = None,
    ) -> Optional[LoopItemExecution]:
        """Atomically claim the next queued run for one robot on one device.

        Returns None when the robot's queue is empty or the device has no free
        capacity. The caller is responsible for holding the per-device Redis
        lock when multiple workers/pullers race (cloud dispatchers); the CAS
        below keeps a single claim atomic even without it.
        """

        running_count = (
            db.query(func.count(LoopItemExecution.id))
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .scalar()
            or 0
        )
        if running_count >= device_capacity:
            return None
        already_running = (
            db.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.agent_id == agent_id,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .first()
        )
        if already_running is not None:
            return None

        query = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.agent_id == agent_id,
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(1)
        )
        if assigner_filter is not None:
            query = query.filter(LoopItemExecution.assigner_user_id == assigner_filter)
        candidate = query.first()
        if candidate is None:
            return None

        now = utcnow()
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        return candidate

    def claim_next_for_device(
        self,
        db: Session,
        *,
        execution_device_id: str,
        environment: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
    ) -> Optional[LoopItemExecution]:
        """Claim one queued run for any robot bound to a device.

        Used by the cloud dispatcher after acquiring the per-device Redis lock.
        The caller loops until this returns None to drain the device up to its
        capacity (each robot still runs one task at a time).
        """

        running_count = (
            db.query(func.count(LoopItemExecution.id))
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .scalar()
            or 0
        )
        if running_count >= device_capacity:
            return None
        running_agents = {
            agent_id
            for (agent_id,) in db.query(LoopItemExecution.agent_id)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .all()
        }
        candidate = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_QUEUED,
                (
                    LoopItemExecution.agent_id.notin_(running_agents)
                    if running_agents
                    else True
                ),
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(1)
            .first()
        )
        if candidate is None:
            return None
        now = utcnow()
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        return candidate

    def claim_next_unbound_local(
        self,
        db: Session,
        *,
        creator_user_id: int,
        execution_device_id: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Claim the next queued local run whose robot has no bound device.

        Robots created before device binding existed have an empty
        execution_device_id; they run on any of the creator's local devices.
        The claim binds the device so future capacity accounting is stable.
        """

        from app.models.delivery import ProjectChatAgent

        candidate = (
            db.query(LoopItemExecution)
            .join(ProjectChatAgent, ProjectChatAgent.id == LoopItemExecution.agent_id)
            .filter(
                ProjectChatAgent.created_by_user_id == creator_user_id,
                ProjectChatAgent.status == "active",
                LoopItemExecution.execution_environment == "local",
                LoopItemExecution.status == STATUS_QUEUED,
                or_(
                    LoopItemExecution.execution_device_id.is_(None),
                    LoopItemExecution.execution_device_id == "",
                ),
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(1)
            .first()
        )
        if candidate is None:
            return None
        now = utcnow()
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "execution_device_id": execution_device_id,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        return candidate

    # ------------------------------------------------------------------
    # Runtime write-back
    # ------------------------------------------------------------------

    def heartbeat(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_device_id: Optional[str] = None,
        runtime_task_id: Optional[str] = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Extend the lease of a running execution."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status != STATUS_RUNNING:
            return None
        now = utcnow()
        row.heartbeat_at = now
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        if runtime_device_id:
            row.runtime_device_id = runtime_device_id
        if runtime_task_id:
            row.runtime_task_id = runtime_task_id
        db.commit()
        db.refresh(row)
        return row

    def complete(
        self, db: Session, *, execution_id: int, note: Optional[str] = None
    ) -> Optional[LoopItemExecution]:
        """Mark a run completed and release its device slot."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status in TERMINAL_STATUSES:
            return row
        row.status = STATUS_COMPLETED
        row.completed_at = utcnow()
        row.lease_expires_at = None
        if note:
            row.execution_note = note
        db.commit()
        db.refresh(row)
        return row

    def fail(
        self,
        db: Session,
        *,
        execution_id: int,
        error: str,
        note: Optional[str] = None,
        requeue: bool = False,
    ) -> Optional[LoopItemExecution]:
        """Mark a run failed (or requeue it when retries remain)."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status in TERMINAL_STATUSES:
            return row
        now = utcnow()
        if requeue and row.retry_attempt < row.max_retries:
            row.retry_attempt += 1
            row.status = STATUS_QUEUED
            row.queued_at = now
            row.lease_expires_at = None
            row.error_message = self._error_text(error)[:2000]
        else:
            row.status = STATUS_FAILED
            row.completed_at = now
            row.lease_expires_at = None
            row.error_message = self._error_text(error)[:2000]
        if note:
            row.execution_note = note
        db.commit()
        db.refresh(row)
        return row

    @staticmethod
    def _error_text(error: Any) -> str:
        """Normalize a runtime error value to a readable one-line string."""

        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            for key in ("message", "error", "detail"):
                message = error.get(key)
                if isinstance(message, str) and message:
                    return message
            try:
                return json.dumps(error, ensure_ascii=False)[:2000]
            except (TypeError, ValueError):
                pass
        return str(error)

    def handle_runtime_event(
        self,
        db: Session,
        *,
        device_id: str,
        runtime_task_id: str,
        event_name: str,
        payload: dict,
    ) -> Optional[LoopItemExecution]:
        """Project device runtime events onto the matching running execution.

        Streaming events extend the lease (the device is alive); terminal
        events complete or fail the run. This is the write-back path shared by
        cloud dispatches and cloud-project local pulls.
        """

        row = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.runtime_device_id == device_id,
                LoopItemExecution.runtime_task_id == runtime_task_id,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if row is None:
            return None
        now = utcnow()
        row.heartbeat_at = now
        terminal = self._terminal_status(event_name, payload)
        if terminal == STATUS_COMPLETED:
            row.status = STATUS_COMPLETED
            row.completed_at = now
            row.lease_expires_at = None
        elif terminal in {STATUS_FAILED, STATUS_CANCELLED}:
            db.flush()
            data = payload.get("data")
            data = data if isinstance(data, dict) else {}
            error_value = (
                payload.get("error")
                or data.get("error")
                or f"Runtime task ended with {terminal}"
            )
            return self.fail(
                db,
                execution_id=row.id,
                error=self._error_text(error_value),
                requeue=True,
            )
        db.commit()
        db.refresh(row)
        return row

    def build_runtime_payload(
        self, db: Session, *, execution: LoopItemExecution
    ) -> Optional[dict]:
        """Build the runtime.tasks.create payload for a claimed run.

        Replayed by the cloud dispatcher and the local App puller, so both
        sides create the exact task the App would have created.
        """

        from app.models.delivery import LoopItem, ProjectChatAgent
        from app.models.user import User
        from app.services.project_chat.service import bot_config

        item = db.get(LoopItem, execution.loop_item_id)
        agent = db.get(ProjectChatAgent, execution.agent_id)
        if item is None or agent is None:
            return None
        creator = (
            db.get(User, agent.created_by_user_id) if agent.created_by_user_id else None
        )
        if creator is None:
            return None
        team = self._resolve_default_team(db, creator.id)
        model = bot_config(agent).get("model")
        model_config = {}
        if isinstance(model, str) and model:
            from app.services.chat.trigger.unified import (
                _build_cloud_gateway_model_config,
                _build_codex_runtime_model_config,
            )

            resolved = _build_codex_runtime_model_config(
                model,
                {},
                db=db,
                user_id=creator.id,
            )
            gateway_config = _build_cloud_gateway_model_config(
                db,
                model_name=model,
                creator=creator,
                upstream_api_format=resolved.get("upstream_api_format"),
            )
            # Public/group cloud models route through the backend LLM gateway
            # (same as an App send); everything else keeps its direct config.
            model_config = gateway_config or resolved
        return self._build_runtime_payload(
            item=item,
            agent=agent,
            creator=creator,
            team=team,
            prompt=self.build_robot_prompt(item, agent),
            model_config=model_config,
        )

    @staticmethod
    def build_robot_prompt(item: object, agent: object) -> str:
        """Mirror the App-side initial prompt for a task robot run."""

        from app.services.project_chat.service import bot_config

        system_prompt = bot_config(agent).get("system_prompt") or ""
        title = getattr(item, "title", None) or getattr(item, "name", None) or ""
        description = getattr(item, "description", "") or ""
        agent_name = (
            getattr(agent, "title", None) or getattr(agent, "name", None) or "AI"
        )
        identity = (
            f"你是 {agent_name}，这个项目任务的 AI 执行者。\n{system_prompt}"
            if system_prompt
            else f"你是 {agent_name}，这个项目任务的 AI 执行者。"
        )
        parts = [
            f"请开始执行任务 {getattr(item, 'id', '')}：{title}",
            description.strip(),
            identity,
            "完成后请总结实际改动、验证结果、未完成事项和风险，提交给人类验收。",
        ]
        return "\n\n".join(part for part in parts if part)

    @staticmethod
    def _resolve_default_team(db: Session, user_id: int) -> Optional[object]:
        """Resolve the user's default Wework team (same source as the App)."""

        from app.api.endpoints.users import parse_default_team_config
        from app.core.config import settings
        from app.models.kind import Kind

        config = parse_default_team_config(settings.DEFAULT_TEAM_WEWORK)
        if config is None:
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.name == config.name,
                Kind.namespace == config.namespace,
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .first()
        )

    @staticmethod
    def _build_runtime_payload(
        *,
        item: object,
        agent: object,
        creator: object,
        team: Optional[object],
        prompt: str,
        model_config: Optional[dict] = None,
    ) -> dict:
        """Build the same runtime.tasks.create payload the App sends."""

        from app.services.project_chat.service import bot_config

        config = bot_config(agent)
        system_prompt = config.get("system_prompt") or ""
        model = config.get("model")
        model = model if isinstance(model, str) else None
        task_id = f"codex-robot-{getattr(item, 'id', '')}"
        subtask_id = f"{task_id}-assistant"
        team_id = int(getattr(team, "id", 0) or 0)
        team_name = getattr(team, "name", "") or ""
        team_namespace = getattr(team, "namespace", "default") or "default"
        agent_name = (
            getattr(agent, "title", None) or getattr(agent, "name", None) or "AI"
        )
        title = getattr(item, "title", None) or getattr(item, "name", None) or ""
        identity = (
            f"你是 {agent_name}，这个项目任务的 AI 执行者。\n{system_prompt}"
            if system_prompt
            else f"你是 {agent_name}，这个项目任务的 AI 执行者。"
        )
        execution_request = {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "team_id": team_id,
            "team_name": team_name,
            "team_namespace": team_namespace,
            "task_title": title,
            "subtask_title": f"{title} - Assistant",
            "user_id": creator.id,
            "user_name": creator.user_name,
            "user": {
                "id": creator.id,
                "name": creator.user_name,
                "user_name": creator.user_name,
            },
            "bot": [
                {
                    "id": agent.id,
                    "name": agent_name,
                    "shell_type": "codex",
                    "system_prompt": identity,
                }
            ],
            "system_prompt": identity,
            "prompt": prompt,
            "model_config": model_config or {},
            "standalone_chat_workspace": True,
            "enable_tools": True,
            "enable_web_search": False,
            "enable_deep_thinking": True,
            "skill_names": [],
            "mcp_servers": [],
        }
        return {
            "taskId": task_id,
            "teamId": team_id,
            "runtime": "codex",
            "message": prompt,
            "title": title,
            **({"modelId": model} if model else {}),
            "ephemeral": True,
            "cloudProjectId": str(getattr(item, "cloud_project_id", "")),
            "executionRequest": execution_request,
            "additionalContext": {
                "projectChat": {
                    "kind": "application",
                    "value": (
                        f"Reply to task cloud://projects/{getattr(item, 'cloud_project_id', '')}"
                        f"/todos/{getattr(item, 'id', '')}. Your final response is a reviewable "
                        "task comment. Report actual changes, verification, unfinished work, and risks."
                    ),
                },
                "projectChatAgent": {
                    "kind": "application",
                    "value": identity,
                },
            },
        }

    @staticmethod
    def _terminal_status(event_name: str, payload: dict) -> Optional[str]:
        from app.services.project_chat.service import ProjectChatService

        data = payload.get("data")
        data = data if isinstance(data, dict) else {}
        return ProjectChatService._project_chat_terminal_status(
            event_name, payload, data
        )

    # ------------------------------------------------------------------
    # Queue queries and recovery
    # ------------------------------------------------------------------

    def list_queue(
        self,
        db: Session,
        *,
        project_id: str,
        agent_id: Optional[str] = None,
        assigner_user_id: Optional[int] = None,
        status_filter: Optional[str] = None,
        include_terminal: bool = False,
        limit: int = 200,
    ) -> list[dict]:
        """Return queue rows joined with their task display data."""

        query = db.query(LoopItemExecution, LoopItem).join(
            LoopItem, LoopItem.id == LoopItemExecution.loop_item_id
        )
        if agent_id:
            query = query.filter(LoopItemExecution.agent_id == agent_id)
        if assigner_user_id is not None:
            query = query.filter(LoopItemExecution.assigner_user_id == assigner_user_id)
        if status_filter:
            query = query.filter(LoopItemExecution.status == status_filter)
        elif not include_terminal:
            query = query.filter(LoopItemExecution.status.in_(ACTIVE_STATUSES))
        rows = (
            query.order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(limit)
            .all()
        )
        return [
            {
                "id": execution.id,
                "loop_item_id": item.id,
                "cloud_project_id": item.cloud_project_id,
                "task_title": item.title or item.name or "",
                "task_status": item.status,
                "task_priority": item.priority,
                "agent_id": execution.agent_id,
                "assigner_user_id": execution.assigner_user_id,
                "execution_environment": execution.execution_environment,
                "execution_device_id": execution.execution_device_id,
                "status": execution.status,
                "priority_weight": execution.priority_weight,
                "queued_at": execution.queued_at,
                "started_at": execution.started_at,
                "completed_at": execution.completed_at,
                "lease_expires_at": execution.lease_expires_at,
                "heartbeat_at": execution.heartbeat_at,
                "retry_attempt": execution.retry_attempt,
                "error_message": execution.error_message,
                "execution_note": execution.execution_note,
                "approval_status": execution.approval_status,
                "approved_by_user_id": execution.approved_by_user_id,
                "rejected_reason": execution.rejected_reason,
                "runtime_device_id": execution.runtime_device_id,
                "runtime_task_id": execution.runtime_task_id,
                "version": execution.version,
                "created_at": execution.created_at,
                "updated_at": execution.updated_at,
            }
            for execution, item in rows
        ]

    def active_for_item(
        self, db: Session, *, item_id: str
    ) -> Optional[LoopItemExecution]:
        """Return the newest active run for a task (used by task details)."""

        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == item_id,
                LoopItemExecution.status.in_(ACTIVE_STATUSES),
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )

    def recovery_scan(
        self,
        db: Session,
        *,
        now: Optional[datetime] = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> tuple[int, int]:
        """Recover runs whose lease expired (crashed devices/workers).

        Returns (requeued, failed) counts. A run is requeued when it has not
        exceeded its retry budget, otherwise it is marked failed.
        """

        current = now or utcnow()
        stale_threshold = current - timedelta(seconds=lease_seconds)
        stale_rows = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.status == STATUS_RUNNING,
                LoopItemExecution.lease_expires_at.is_not(None),
                LoopItemExecution.lease_expires_at < stale_threshold,
            )
            .all()
        )
        requeued = 0
        failed = 0
        for row in stale_rows:
            self.fail(
                db,
                execution_id=row.id,
                error="Run lease expired; execution environment did not heartbeat",
                requeue=True,
            )
            if row.status == STATUS_QUEUED:
                requeued += 1
            else:
                failed += 1
        return requeued, failed

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_for_creator(
        self, db: Session, execution_id: int, user_id: int
    ) -> LoopItemExecution:
        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        agent = db.get(ProjectChatAgent, row.agent_id)
        if agent is None or agent.created_by_user_id != user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only the robot creator can approve or reject this run",
            )
        return row


loop_item_execution_service = LoopItemExecutionService()
