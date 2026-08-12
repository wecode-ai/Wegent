# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistence and authorization for shared project chat messages."""

import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectChatAgent,
    adapt_loop_node_values_for_dialect,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import (
    ProjectChatAgentCreate,
    ProjectChatAgentFailure,
    ProjectChatAgentStart,
    ProjectChatAgentUpdate,
    ProjectChatAgentView,
    ProjectChatMessageView,
    ProjectChatSend,
    ProjectChatSubscribe,
)
from app.services.cloud_projects.access import require_cloud_project_role

logger = logging.getLogger(__name__)

PROJECT_CHAT_COMPLETED_EVENTS = {
    "response.completed",
    "chat:done",
    "done",
    "task.done",
    "turn.done",
    "turn.completed",
    "runtime.task.completed",
    "runtime_task.completed",
    "runtime.tasks.completed",
}
PROJECT_CHAT_FAILED_EVENTS = {
    "response.failed",
    "response.incomplete",
    "error",
    "chat:error",
    "failed",
    "task.failed",
    "turn.failed",
    "cancelled",
    "canceled",
    "runtime.task.failed",
    "runtime_task.failed",
    "runtime.tasks.failed",
    "runtime.task.cancelled",
    "runtime_task.cancelled",
    "runtime.tasks.cancelled",
}


def _task_id_filter(column: object, task_id: str | None) -> object:
    """Match a task id in both nullable dev schemas and sentinel schemas."""
    if task_id:
        return column == task_id
    return or_(column.is_(None), column == "")


PROJECT_CHAT_COMPLETED_STATUSES = {"completed", "done", "succeeded", "success", "idle"}
PROJECT_CHAT_FAILED_STATUSES = {"failed", "failure", "error", "cancelled", "canceled"}
PROJECT_CHAT_TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled", "canceled"}
TASK_AI_STATE_KEY = "ai_state"
TASK_AI_RUNNING_LEASE_SECONDS = 10 * 60
EXECUTION_STATE_KEY = "execution_state"
EXECUTION_UPDATED_AT_KEY = "execution_updated_at"
_EXECUTION_STATE_FROM_AI_STATUS = {
    "running": "running",
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}
BOT_VISIBILITY_KEY = "visibility"
BOT_EXECUTION_ENVIRONMENT_KEY = "execution_environment"
BOT_EXECUTION_MODE_KEY = "execution_mode"
BOT_DEFAULT_VISIBILITY = "creator_admin"
BOT_DEFAULT_EXECUTION_ENVIRONMENT = "local"
BOT_DEFAULT_EXECUTION_MODE = "auto"
BOT_ADMIN_ROLES = {BaseRole.Owner, BaseRole.Maintainer}


def bot_config(row: ProjectChatAgent) -> dict[str, object]:
    """Read the robot configuration stored in the single-table metadata JSON."""

    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    return {
        "visibility": metadata.get(BOT_VISIBILITY_KEY, BOT_DEFAULT_VISIBILITY),
        "execution_environment": metadata.get(
            BOT_EXECUTION_ENVIRONMENT_KEY, BOT_DEFAULT_EXECUTION_ENVIRONMENT
        ),
        "execution_mode": metadata.get(
            BOT_EXECUTION_MODE_KEY, BOT_DEFAULT_EXECUTION_MODE
        ),
        "execution_device_id": row.device_id,
        "model": metadata.get("model"),
        "system_prompt": metadata.get("system_prompt", ""),
    }


@dataclass(frozen=True)
class ProjectChatWriteResult:
    message: ProjectChatMessageView
    created: bool


class ProjectChatService:
    """Read and append messages in a project's single shared chat."""

    def list_agents(
        self, db: Session, *, user_id: int, project_id: str
    ) -> list[ProjectChatAgentView]:
        access = require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rows = (
            db.query(ProjectChatAgent)
            .filter(
                ProjectChatAgent.cloud_project_id == project_id,
                ProjectChatAgent.status == "active",
                loop_datetime_is_unset(ProjectChatAgent.deleted_at),
            )
            .order_by(ProjectChatAgent.created_at.asc())
            .all()
        )
        return [
            self.agent_to_view(row, db=db)
            for row in rows
            if self._agent_visible_to_user(row, user_id, access.role)
        ]

    def create_agent(
        self,
        db: Session,
        *,
        user_id: int,
        project_id: str,
        request: ProjectChatAgentCreate,
    ) -> ProjectChatAgentView:
        self._require_scope(
            db,
            user_id=user_id,
            project_id=project_id,
            task_id=None,
            required_role=BaseRole.Reporter,
        )
        self._validate_execution_device(
            db,
            user_id=user_id,
            environment=request.execution_environment,
            execution_device_id=request.execution_device_id,
        )
        row = ProjectChatAgent(
            cloud_project_id=project_id,
            title=request.name,
            name=request.name,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            status="active",
            device_id=request.execution_device_id,
            local_project_id=request.local_project_id,
            metadata_json={
                "runtime": request.runtime,
                "model": request.model,
                "system_prompt": request.system_prompt,
                BOT_VISIBILITY_KEY: request.visibility,
                BOT_EXECUTION_ENVIRONMENT_KEY: request.execution_environment,
                BOT_EXECUTION_MODE_KEY: request.execution_mode,
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self.agent_to_view(row, db=db)

    def update_agent(
        self,
        db: Session,
        *,
        user_id: int,
        project_id: str,
        agent_id: str,
        request: ProjectChatAgentUpdate,
    ) -> ProjectChatAgentView:
        access = require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        row = self._agent_row(db, project_id=project_id, agent_id=agent_id)
        is_creator = row.created_by_user_id == user_id
        is_admin = access.role in BOT_ADMIN_ROLES
        if not is_creator and not is_admin:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only the robot creator or a project admin can change it",
            )
        if row.version != request.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Project chat AI changed")
        if request.name is not None:
            row.name = request.name
            row.title = request.name
        metadata = dict(row.metadata_json or {})
        if request.model is not None:
            metadata["model"] = request.model
        if request.system_prompt is not None:
            metadata["system_prompt"] = request.system_prompt
        if request.execution_device_id is not None:
            self._validate_execution_device(
                db,
                user_id=row.created_by_user_id or user_id,
                environment=(
                    request.execution_environment
                    or metadata.get(BOT_EXECUTION_ENVIRONMENT_KEY)
                    or BOT_DEFAULT_EXECUTION_ENVIRONMENT
                ),
                execution_device_id=request.execution_device_id,
            )
            row.device_id = request.execution_device_id
        if request.visibility is not None:
            metadata[BOT_VISIBILITY_KEY] = request.visibility
        if request.execution_environment is not None:
            if row.device_id:
                self._validate_execution_device(
                    db,
                    user_id=row.created_by_user_id or user_id,
                    environment=request.execution_environment,
                    execution_device_id=row.device_id,
                )
            metadata[BOT_EXECUTION_ENVIRONMENT_KEY] = request.execution_environment
        if request.execution_mode is not None:
            metadata[BOT_EXECUTION_MODE_KEY] = request.execution_mode
        if "local_project_id" in request.model_fields_set:
            row.local_project_id = request.local_project_id
        row.metadata_json = metadata
        if request.status is not None:
            row.status = request.status
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()
        db.refresh(row)
        return self.agent_to_view(row, db=db)

    def subscribe(
        self,
        db: Session,
        *,
        user_id: int,
        request: ProjectChatSubscribe,
    ) -> list[ProjectChatMessageView]:
        self._require_scope(
            db,
            user_id=user_id,
            project_id=request.project_id,
            task_id=request.task_id,
            required_role=BaseRole.Reporter,
        )
        query = db.query(ProjectChatMessage).filter(
            ProjectChatMessage.project_id == request.project_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        if request.task_id:
            query = query.filter(
                _task_id_filter(ProjectChatMessage.task_id, request.task_id)
            )
        else:
            query = query.filter(_task_id_filter(ProjectChatMessage.task_id, None))
        if request.after_sequence > 0:
            rows = (
                query.filter(ProjectChatMessage.id > request.after_sequence)
                .order_by(ProjectChatMessage.id.asc())
                .limit(request.limit)
                .all()
            )
        else:
            rows = (
                query.order_by(ProjectChatMessage.id.desc()).limit(request.limit).all()
            )
            rows.reverse()
        reconciled = False
        for row in rows:
            reconciled = self._reconcile_ai_run_projection(db, row=row) or reconciled
        if reconciled:
            db.commit()
            for row in rows:
                db.refresh(row)
        return [self.to_view(row) for row in rows]

    def send(
        self,
        db: Session,
        *,
        user_id: int,
        user_name: str,
        request: ProjectChatSend,
    ) -> ProjectChatWriteResult:
        project = self._require_scope(
            db,
            user_id=user_id,
            project_id=request.project_id,
            task_id=request.task_id,
            required_role=BaseRole.Developer,
        )
        self._validate_agent_mentions(db, project, request)
        existing = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.sender_type == "user",
                ProjectChatMessage.sender_id == str(user_id),
                ProjectChatMessage.client_message_id == request.client_message_id,
            )
            .first()
        )
        if existing is not None:
            if existing.project_id != request.project_id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "client_message_id already belongs to another project",
                )
            return ProjectChatWriteResult(self.to_view(existing), created=False)

        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        metadata = {
            "mentions": [
                mention.model_dump(by_alias=True) for mention in request.mentions
            ]
        }
        if request.model is not None:
            metadata["model"] = request.model
        reply_to_message_id, root_message_id = self._resolve_reply_context(
            db,
            project_id=request.project_id,
            task_id=request.task_id,
            reply_to_message_id=request.reply_to_message_id,
        )
        row = ProjectChatMessage(
            message_id=message_id,
            client_message_id=request.client_message_id,
            project_id=request.project_id,
            task_id=request.task_id or "",
            sender_type="user",
            sender_id=str(user_id),
            sender_name=user_name,
            message_type="text",
            content=request.content,
            metadata_json=metadata,
            reply_to_message_id=reply_to_message_id or "",
            thread_root_message_id=root_message_id or "",
            status="completed",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return ProjectChatWriteResult(self.to_view(row), created=True)

    def _resolve_reply_context(
        self,
        db: Session,
        *,
        project_id: str,
        task_id: str | None,
        reply_to_message_id: str | None,
    ) -> tuple[str | None, str | None]:
        """Validate a one-level reply target and resolve its thread root.

        The reply target must live in the same project/task thread. The root is
        the target's own root (or the target itself when it is a top-level
        comment), so every message in one card shares the same session root.
        """
        if not reply_to_message_id:
            return None, None
        target = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == reply_to_message_id,
                ProjectChatMessage.project_id == project_id,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .first()
        )
        if target is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "reply target message not found",
            )
        if (task_id or "") != (target.task_id or ""):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "reply target belongs to a different task thread",
            )
        return reply_to_message_id, target.thread_root_message_id or target.message_id

    def start_agent_response(
        self,
        db: Session,
        *,
        user_id: int,
        request: ProjectChatAgentStart,
    ) -> ProjectChatMessageView:
        project = self._require_scope(
            db,
            user_id=user_id,
            project_id=request.project_id,
            task_id=request.task_id,
            required_role=BaseRole.Developer,
        )
        configured_agent = self._agent_row(
            db,
            project_id=request.project_id,
            agent_id=request.agent_id,
            active_only=True,
        )
        trigger = None
        if request.trigger_message_id:
            trigger = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.message_id == request.trigger_message_id,
                    ProjectChatMessage.project_id == request.project_id,
                    _task_id_filter(ProjectChatMessage.task_id, request.task_id),
                    ProjectChatMessage.sender_type == "user",
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .first()
            )
            if trigger is None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "AI response must be attached to its project chat message",
                )
        existing = self._agent_response_for_runtime(
            db,
            trigger_message_id=request.trigger_message_id,
            agent_id=request.agent_id,
            runtime_device_id=request.runtime_device_id,
            runtime_task_id=request.runtime_task_id,
        )
        if existing:
            if existing.status == "streaming":
                self._set_task_ai_state(
                    db,
                    row=existing,
                    trigger=trigger,
                    agent=configured_agent,
                    status_value="running",
                    prompt=request.prompt,
                    user_id=user_id,
                )
                db.commit()
            db.refresh(existing)
            return self.to_view(existing)
        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        run_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        metadata = {
            "run_id": run_id,
            "run_status": "running",
            "auto_retry": request.auto_retry,
        }
        if request.model is not None:
            metadata["model"] = request.model
        row = ProjectChatMessage(
            message_id=message_id,
            # The client_message_id unique index covers (sender_type,
            # sender_id, client_message_id). An empty value would collide for
            # every queue-dispatched run of the same robot (no user trigger),
            # so server-created agent messages use the unique message id.
            client_message_id=message_id,
            runtime_activity_key=self._runtime_activity_key(
                request.runtime_device_id or "",
                request.runtime_task_id or "",
                request.trigger_message_id or "",
            ),
            project_id=request.project_id,
            task_id=request.task_id or "",
            sender_type="agent",
            sender_id=request.agent_id,
            sender_name=str(configured_agent.title or configured_agent.name),
            message_type="agent_chunk",
            content="",
            metadata_json=metadata,
            trigger_message_id=request.trigger_message_id or "",
            reply_to_message_id=trigger.message_id if trigger else "",
            thread_root_message_id=(
                (trigger.thread_root_message_id or trigger.message_id)
                if trigger
                else ""
            ),
            agent_id=request.agent_id,
            runtime_device_id=request.runtime_device_id or "",
            runtime_task_id=request.runtime_task_id or "",
            status="streaming",
        )
        try:
            db.add(row)
            self._set_task_ai_state(
                db,
                row=row,
                trigger=trigger,
                agent=configured_agent,
                status_value="running",
                prompt=request.prompt,
                user_id=user_id,
            )
            db.commit()
        except IntegrityError:
            # A concurrent opener (runtime event upsert vs transport start
            # report) inserted the activity message first. Reuse it instead of
            # leaving a duplicate streaming comment behind.
            db.rollback()
            existing = self._agent_response_for_runtime(
                db,
                trigger_message_id=request.trigger_message_id,
                agent_id=request.agent_id,
                runtime_device_id=request.runtime_device_id,
                runtime_task_id=request.runtime_task_id,
            )
            if existing is None:
                raise
            db.refresh(existing)
            return self.to_view(existing)
        db.refresh(row)
        return self.to_view(row)

    @staticmethod
    def _runtime_activity_key(
        runtime_device_id: str, runtime_task_id: str, trigger_message_id: str
    ) -> str | None:
        """Stable activity identity for the unique per-run comment index."""

        if not runtime_device_id or not runtime_task_id:
            return None
        identity = "\0".join(
            (runtime_device_id, runtime_task_id, trigger_message_id or "")
        )
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    def project_runtime_event(
        self,
        db: Session,
        *,
        device_id: str,
        runtime_task_id: str,
        event_name: str,
        payload: dict,
    ) -> tuple[ProjectChatMessageView, str] | None:
        row = self._streaming_activity_for_runtime(db, device_id, runtime_task_id)
        if row is None:
            row = self._open_activity_from_execution(
                db,
                runtime_device_id=device_id,
                runtime_task_id=runtime_task_id,
            )
        if row is None:
            logger.info(
                "[ProjectChat] Runtime event ignored because no streaming AI message matched: "
                "event=%s runtime_device_id=%s runtime_task_id=%s payload_status=%s",
                event_name,
                device_id,
                runtime_task_id,
                payload.get("status"),
            )
            return None
        data = payload.get("data")
        data = data if isinstance(data, dict) else {}
        subagent_result = self._handle_subagent_runtime_event(
            db, parent=row, event_name=event_name, data=data
        )
        if subagent_result is not None:
            return subagent_result
        terminal_status = self._project_chat_terminal_status(event_name, payload, data)
        if terminal_status is not None:
            logger.info(
                "[ProjectChat] Runtime terminal event matched: "
                "event=%s status=%s project_id=%s task_id=%s "
                "message_id=%s runtime_device_id=%s runtime_task_id=%s",
                event_name,
                terminal_status,
                row.project_id,
                row.task_id,
                row.message_id,
                device_id,
                runtime_task_id,
            )
        elif event_name not in {
            "response.output_text.delta",
            "response.refusal.delta",
            "response.output_text.done",
        }:
            logger.info(
                "[ProjectChat] Runtime event matched message but was not terminal: "
                "event=%s project_id=%s task_id=%s message_id=%s "
                "runtime_device_id=%s runtime_task_id=%s payload_status=%s data_status=%s",
                event_name,
                row.project_id,
                row.task_id,
                row.message_id,
                device_id,
                runtime_task_id,
                payload.get("status"),
                data.get("status"),
            )
        if event_name in {"response.output_text.delta", "response.refusal.delta"}:
            delta = data.get("delta")
            if not isinstance(delta, str) or not delta:
                return None
            # The database is the reconnect source of truth.  Persist every delta
            # before broadcasting it, so a browser refresh cannot lose streamed text.
            row.content = f"{row.content}{delta}"
            self._set_task_ai_state(
                db,
                row=row,
                trigger=None,
                agent=None,
                status_value="running",
            )
            db.commit()
            db.refresh(row)
            return (
                self.to_view(row).model_copy(
                    update={
                        "content": delta,
                        "metadata": {"contentMode": "delta"},
                    }
                ),
                "delta",
            )
        elif event_name == "response.output_text.done":
            snapshot = data.get("text") or data.get("value") or data.get("output_text")
            if isinstance(snapshot, str):
                row.content = snapshot
        elif terminal_status == "completed":
            self._finish_activity(
                db,
                row,
                status_value="completed",
                content=self._project_chat_final_text(data, payload),
                error=None,
            )
        elif terminal_status == "failed":
            error = data.get("error") or payload.get("error")
            self._finish_activity(
                db,
                row,
                status_value="failed",
                content=error,
                error=error,
            )
        else:
            return None
        db.commit()
        db.refresh(row)
        return self.to_view(row), "snapshot"

    @staticmethod
    def _streaming_activity_for_runtime(
        db: Session,
        runtime_device_id: str,
        runtime_task_id: str,
    ) -> ProjectChatMessage | None:
        """Return the open streaming AI message for one runtime task."""

        return (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.runtime_device_id == runtime_device_id,
                ProjectChatMessage.runtime_task_id == runtime_task_id,
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.status == "streaming",
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .order_by(ProjectChatMessage.id.desc())
            .first()
        )

    def _open_activity_from_execution(
        self,
        db: Session,
        *,
        runtime_device_id: str,
        runtime_task_id: str,
    ) -> ProjectChatMessage | None:
        """Open the activity message from the owning execution.

        Runtime events may arrive before the transport reports the created
        task (local App puller), so the write-back path opens the message on
        demand instead of dropping the event. The open stays idempotent.
        """

        from app.services.loop_item_executions.service import (
            loop_item_execution_service,
        )

        execution = loop_item_execution_service.execution_for_runtime(
            db,
            runtime_device_id=runtime_device_id,
            runtime_task_id=runtime_task_id,
        )
        if execution is None:
            return None
        try:
            loop_item_execution_service.open_execution_activity(
                db,
                execution=execution,
            )
        except Exception:
            logger.exception(
                "[ProjectChat] Activity open on event failed execution=%s",
                execution.id,
            )
        return self._streaming_activity_for_runtime(
            db,
            runtime_device_id,
            runtime_task_id,
        )

    def finish_runtime_activity(
        self,
        db: Session,
        *,
        runtime_device_id: str,
        runtime_task_id: str,
        status_value: str,
        content: object | None,
        error: object | None = None,
    ) -> ProjectChatMessageView | None:
        """Close the streaming activity for a terminal channel report."""

        row = self._streaming_activity_for_runtime(
            db,
            runtime_device_id,
            runtime_task_id,
        )
        if row is None:
            return None
        self._finish_activity(
            db,
            row,
            status_value=status_value,
            content=content,
            error=error,
        )
        db.commit()
        db.refresh(row)
        return self.to_view(row)

    def _finish_activity(
        self,
        db: Session,
        row: ProjectChatMessage,
        *,
        status_value: str,
        content: object | None,
        error: object | None,
    ) -> None:
        """Apply one terminal state to the streaming AI message."""

        if status_value == "completed":
            if isinstance(content, str) and content:
                row.content = content
            row.status = "completed"
            row.message_type = "text"
            self._set_task_ai_state(
                db,
                row=row,
                trigger=None,
                agent=None,
                status_value="completed",
            )
            self._advance_task_to_review(db, row)
            return
        if not row.content and isinstance(content, str) and content:
            row.content = content
        row.status = "failed"
        self._set_task_ai_state(
            db,
            row=row,
            trigger=None,
            agent=None,
            status_value="failed",
            error=error or content,
        )

    @staticmethod
    def _project_chat_terminal_status(
        event_name: str, payload: dict, data: dict
    ) -> str | None:
        """Normalize runtime terminal signals to the durable AI-run status."""

        if event_name in PROJECT_CHAT_COMPLETED_EVENTS:
            return "completed"
        if event_name in PROJECT_CHAT_FAILED_EVENTS:
            return "failed"
        status_value = (
            data.get("status")
            or data.get("taskStatus")
            or data.get("task_status")
            or payload.get("status")
        )
        if not isinstance(status_value, str):
            return None
        normalized = status_value.strip().replace("_", "").replace("-", "").lower()
        if normalized in PROJECT_CHAT_COMPLETED_STATUSES:
            return "completed"
        if normalized in PROJECT_CHAT_FAILED_STATUSES:
            return "failed"
        return None

    @staticmethod
    def _project_chat_final_text(data: dict, payload: dict) -> str | None:
        """Extract final assistant text from runtime or Responses API payloads."""

        for source in (data, payload):
            for key in ("value", "text", "content", "output_text"):
                value = source.get(key)
                if isinstance(value, str) and value:
                    return value
            result = source.get("result")
            if isinstance(result, dict):
                for key in ("value", "text", "content", "output_text"):
                    value = result.get(key)
                    if isinstance(value, str) and value:
                        return value

        response = data.get("response")
        if not isinstance(response, dict):
            return None
        texts: list[str] = []
        output = response.get("output")
        if isinstance(output, list):
            for item in output:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if isinstance(text, str) and text:
                        texts.append(text)
        return "".join(texts) if texts else None

    def _handle_subagent_runtime_event(
        self,
        db: Session,
        *,
        parent: ProjectChatMessage,
        event_name: str,
        data: dict,
    ) -> tuple[ProjectChatMessageView, str] | None:
        """Expose child-agent work as compact task activity messages."""

        if "subagent" not in event_name and not any(
            key in data for key in ("subagent_name", "subagentName", "executor_name")
        ):
            return None

        child_name = self._subagent_name(data)
        text = self._subagent_text(data)
        if not child_name or not text:
            return None

        child_id = self._subagent_identity(data)
        metadata = {
            "kind": "task_ai_subagent",
            "parent_agent_id": parent.agent_id,
            "parent_message_id": parent.message_id,
            "subagent_id": child_id,
            "subagent_name": child_name,
        }
        existing = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.project_id == parent.project_id,
                ProjectChatMessage.task_id == parent.task_id,
                ProjectChatMessage.trigger_message_id == parent.message_id,
                ProjectChatMessage.agent_id == parent.agent_id,
                ProjectChatMessage.sender_id == f"{parent.agent_id}:{child_id}",
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .first()
        )
        if existing is None:
            message_id = (
                str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
            )
            existing = ProjectChatMessage(
                message_id=message_id,
                project_id=parent.project_id,
                task_id=parent.task_id,
                sender_type="agent",
                sender_id=f"{parent.agent_id}:{child_id}",
                sender_name=f"{parent.sender_name}.{child_name}",
                message_type="text",
                content=text,
                metadata_json=metadata,
                trigger_message_id=parent.message_id,
                reply_to_message_id=parent.message_id,
                thread_root_message_id=parent.thread_root_message_id
                or parent.message_id,
                agent_id=parent.agent_id,
                runtime_device_id=parent.runtime_device_id or "",
                runtime_task_id=parent.runtime_task_id or "",
                runtime_activity_key=self._runtime_activity_key(
                    parent.runtime_device_id or "",
                    parent.runtime_task_id or "",
                    parent.message_id,
                ),
                status="completed",
            )
            db.add(existing)
        else:
            existing.content = text
            existing.metadata_json = metadata
            existing.status = "completed"
            existing.message_type = "text"
        db.commit()
        db.refresh(existing)
        return self.to_view(existing), "snapshot"

    @staticmethod
    def _subagent_name(data: dict) -> str | None:
        for key in ("subagent_name", "subagentName", "executor_name", "name"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        subagent = data.get("subagent")
        if isinstance(subagent, dict):
            value = subagent.get("name") or subagent.get("title")
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @staticmethod
    def _subagent_identity(data: dict) -> str:
        for key in ("subagent_id", "subagentId", "executor_id", "id"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        subagent = data.get("subagent")
        if isinstance(subagent, dict):
            value = subagent.get("id") or subagent.get("name") or subagent.get("title")
            if isinstance(value, str) and value.strip():
                return value.strip()
        return "child"

    @staticmethod
    def _subagent_text(data: dict) -> str | None:
        for key in ("summary", "content", "message", "text", "result"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @staticmethod
    def _agent_response_for_runtime(
        db: Session,
        *,
        trigger_message_id: str | None,
        agent_id: str,
        runtime_device_id: str,
        runtime_task_id: str,
    ) -> ProjectChatMessage | None:
        trigger_filter = (
            or_(
                ProjectChatMessage.trigger_message_id.is_(None),
                ProjectChatMessage.trigger_message_id == "",
            )
            if not trigger_message_id
            else ProjectChatMessage.trigger_message_id == trigger_message_id
        )
        return (
            db.query(ProjectChatMessage)
            .filter(
                trigger_filter,
                ProjectChatMessage.agent_id == agent_id,
                ProjectChatMessage.runtime_device_id == runtime_device_id,
                ProjectChatMessage.runtime_task_id == runtime_task_id,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .first()
        )

    @staticmethod
    def _set_task_ai_state(
        db: Session,
        *,
        row: ProjectChatMessage,
        trigger: ProjectChatMessage | None,
        agent: ProjectChatAgent | None,
        status_value: str,
        prompt: str | None = None,
        user_id: int | None = None,
        error: object | None = None,
    ) -> None:
        """Store task AI current state on loop_item, the only current source."""

        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        run_id = metadata.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            run_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())

        row.metadata_json = {**metadata, "run_id": run_id, "run_status": status_value}
        if not row.task_id:
            return

        task = db.get(LoopItem, row.task_id)
        if task is None or not loop_datetime_value_is_unset(task.deleted_at):
            logger.warning(
                "[ProjectChat] Task AI state update skipped because task was not found: "
                "project_id=%s task_id=%s message_id=%s run_id=%s status=%s",
                row.project_id,
                row.task_id,
                row.message_id,
                run_id,
                status_value,
            )
            return

        now = datetime.now(UTC).replace(tzinfo=None)
        task_metadata = dict(task.metadata_json or {})
        external_index = (
            task_metadata.get("external_index") is True
            or task_metadata.get("external_shadow") is True
        )
        previous_state = task_metadata.get(TASK_AI_STATE_KEY)
        previous_state = previous_state if isinstance(previous_state, dict) else {}
        next_state = {
            **previous_state,
            "run_id": run_id,
            "status": status_value,
            "agent_id": row.agent_id,
            "agent_name": (
                row.sender_name if agent is None else str(agent.title or agent.name)
            ),
            "trigger_message_id": (
                trigger.message_id if trigger else (row.trigger_message_id or None)
            ),
            "project_chat_message_id": row.message_id,
            "runtime_device_id": row.runtime_device_id or None,
            "runtime_task_id": row.runtime_task_id or None,
            "updated_at": now.isoformat(),
        }
        if prompt:
            next_state["prompt"] = prompt[:100_000]
        if user_id is not None:
            next_state["updated_by_user_id"] = user_id
        next_state["auto_retry"] = metadata.get("auto_retry") is True
        if status_value == "running":
            lease_expires_at = now + timedelta(seconds=TASK_AI_RUNNING_LEASE_SECONDS)
            next_state["started_at"] = now.isoformat()
            next_state["heartbeat_at"] = now.isoformat()
            next_state["lease_expires_at"] = lease_expires_at.isoformat()
            next_state["completed_at"] = None
            next_state["last_error"] = None
            if not external_index and task.status not in {
                "in_progress",
                "in_review",
                "completed",
            }:
                task.status = "in_progress"
                task.completed_at = ProjectChatService._loop_unset_datetime(db)
                task.sort_order = 0
        else:
            next_state["completed_at"] = now.isoformat()
            next_state["heartbeat_at"] = None
            next_state["lease_expires_at"] = None
            if isinstance(error, str) and error:
                next_state["last_error"] = error
            if status_value == "failed" and next_state.get("auto_retry") is True:
                next_state["auto_retry_count"] = (
                    int(previous_state.get("auto_retry_count") or 0) + 1
                )

        execution_state = _EXECUTION_STATE_FROM_AI_STATUS.get(status_value)
        if execution_state is not None:
            task_metadata[EXECUTION_STATE_KEY] = execution_state
            task_metadata[EXECUTION_UPDATED_AT_KEY] = now.isoformat()
        task_metadata[TASK_AI_STATE_KEY] = next_state
        task.metadata_json = task_metadata
        task.version += 1
        logger.info(
            "[ProjectChat] Task AI state set: "
            "project_id=%s task_id=%s task_status=%s ai_status=%s "
            "message_id=%s run_id=%s runtime_device_id=%s runtime_task_id=%s "
            "lease_expires_at=%s",
            row.project_id,
            row.task_id,
            task.status,
            status_value,
            row.message_id,
            run_id,
            row.runtime_device_id,
            row.runtime_task_id,
            next_state.get("lease_expires_at"),
        )

    def _reconcile_ai_run_projection(
        self, db: Session, *, row: ProjectChatMessage
    ) -> bool:
        """Keep message projection aligned with loop_item AI current state."""

        if row.sender_type != "agent":
            return False
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        if row.status in {"completed", "failed"}:
            if metadata.get("run_status") == row.status:
                return False
            row.metadata_json = {**metadata, "run_status": row.status}
            if row.task_id:
                self._set_task_ai_state(
                    db,
                    row=row,
                    trigger=None,
                    agent=None,
                    status_value=row.status,
                )
            logger.warning(
                "[ProjectChat] Reconciled stale AI message metadata from message status: "
                "project_id=%s task_id=%s message_id=%s message_status=%s",
                row.project_id,
                row.task_id,
                row.message_id,
                row.status,
            )
            return True
        if row.status != "streaming" or not row.task_id:
            return False

        task = db.get(LoopItem, row.task_id)
        task_metadata = (
            task.metadata_json
            if task is not None and isinstance(task.metadata_json, dict)
            else {}
        )
        ai_state = task_metadata.get(TASK_AI_STATE_KEY)
        ai_state = ai_state if isinstance(ai_state, dict) else {}
        run_status = ai_state.get("status")
        if run_status not in PROJECT_CHAT_TERMINAL_RUN_STATUSES:
            return False
        if ai_state.get("project_chat_message_id") != row.message_id:
            return False

        status_value = (
            "failed"
            if run_status in {"failed", "cancelled", "canceled"}
            else "completed"
        )
        row.status = status_value
        row.message_type = "text"
        row.metadata_json = {**metadata, "run_status": status_value}
        if status_value == "completed":
            self._advance_task_to_review(db, row)
        logger.warning(
            "[ProjectChat] Reconciled streaming AI message from loop_item AI state: "
            "project_id=%s task_id=%s message_id=%s run_status=%s",
            row.project_id,
            row.task_id,
            row.message_id,
            run_status,
        )
        return True

    @staticmethod
    def _loop_unset_datetime(db: Session) -> object:
        values = adapt_loop_node_values_for_dialect(
            {"completed_at": None}, db.get_bind().dialect.name
        )
        return values["completed_at"]

    @staticmethod
    def _advance_task_to_review(db: Session, row: ProjectChatMessage) -> None:
        """Move the work item to human review when its assigned AI finishes."""

        if not row.task_id or not row.agent_id:
            return
        task = db.get(LoopItem, row.task_id)
        if (
            task is None
            or task.assignee_agent_id != row.agent_id
            or task.status in {"completed", "in_review"}
            or not loop_datetime_value_is_unset(task.deleted_at)
        ):
            return
        task_metadata = (
            task.metadata_json if isinstance(task.metadata_json, dict) else {}
        )
        if (
            task_metadata.get("external_index") is True
            or task_metadata.get("external_shadow") is True
        ):
            # External provider tasks keep their status in provider labels.
            return
        task.status = "in_review"
        task.completed_at = ProjectChatService._loop_unset_datetime(db)
        task.sort_order = 0
        task.version += 1

    def fail_agent_response(
        self,
        db: Session,
        *,
        user_id: int,
        request: ProjectChatAgentFailure,
    ) -> ProjectChatMessageView:
        self._require_scope(
            db,
            user_id=user_id,
            project_id=request.project_id,
            task_id=request.task_id,
            required_role=BaseRole.Developer,
        )
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == request.message_id,
                ProjectChatMessage.project_id == request.project_id,
                _task_id_filter(ProjectChatMessage.task_id, request.task_id),
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.status == "streaming",
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .first()
        )
        if row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Streaming AI response not found"
            )
        trigger = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == row.trigger_message_id,
                ProjectChatMessage.sender_type == "user",
                ProjectChatMessage.sender_id == str(user_id),
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .first()
        )
        if trigger is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Only the sender can fail this AI response"
            )
        row.status = "failed"
        row.message_type = "text"
        if not row.content and request.error:
            row.content = request.error
        self._set_task_ai_state(
            db,
            row=row,
            trigger=trigger,
            agent=None,
            status_value="failed",
            error=request.error,
        )
        db.commit()
        db.refresh(row)
        return self.to_view(row)

    def _require_scope(
        self,
        db: Session,
        *,
        user_id: int,
        project_id: str,
        task_id: str | None,
        required_role: BaseRole,
    ) -> LoopItem:
        project = require_cloud_project_role(
            db, project_id, user_id, required_role
        ).project
        if task_id is None:
            return project
        task = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == task_id,
                LoopItem.cloud_project_id == project_id,
                LoopItem.resource_type == "task",
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .first()
        )
        if task is None:
            if project.task_provider in {"github", "gitlab"}:
                # External provider tasks have no local task row; chat threads
                # are keyed by the provider issue id and need no existence row.
                return project
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project task not found")
        return project

    def _validate_agent_mentions(
        self, db: Session, project: LoopItem, request: ProjectChatSend
    ) -> None:
        agent_mentions = [
            mention for mention in request.mentions if mention.type == "agent"
        ]
        if not agent_mentions:
            return
        unknown = [
            mention.id
            for mention in agent_mentions
            if self._agent_row_or_none(
                db, project_id=project.id, agent_id=mention.id, active_only=True
            )
            is None
        ]
        if unknown:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Mentioned AI is not a member of this project chat",
            )

    @staticmethod
    def _agent_row_or_none(
        db: Session, *, project_id: str, agent_id: str, active_only: bool
    ) -> ProjectChatAgent | None:
        query = db.query(ProjectChatAgent).filter(
            ProjectChatAgent.id == agent_id,
            ProjectChatAgent.cloud_project_id == project_id,
            loop_datetime_is_unset(ProjectChatAgent.deleted_at),
        )
        if active_only:
            query = query.filter(ProjectChatAgent.status == "active")
        return query.first()

    def _agent_row(
        self, db: Session, *, project_id: str, agent_id: str, active_only: bool = False
    ) -> ProjectChatAgent:
        row = self._agent_row_or_none(
            db, project_id=project_id, agent_id=agent_id, active_only=active_only
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project chat AI not found")
        return row

    @staticmethod
    def _agent_visible_to_user(
        row: ProjectChatAgent, user_id: int, role: BaseRole
    ) -> bool:
        """Robots are project assets that follow their creator's environment.

        Visibility controls who can see and assign a robot: private is the
        creator only, creator_admin is the creator plus project admins, and
        public is every project member.
        """

        if row.created_by_user_id == user_id:
            return True
        visibility = bot_config(row).get("visibility")
        if visibility == "public":
            return True
        if visibility == "creator_admin":
            return role in BOT_ADMIN_ROLES
        return False

    @staticmethod
    def _validate_execution_device(
        db: Session,
        *,
        user_id: int,
        environment: str,
        execution_device_id: str | None,
    ) -> None:
        """The robot's bound device must belong to its creator and match its
        execution environment (local device for local runs, cloud device for
        cloud runs)."""

        if not execution_device_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Robot must bind an execution device",
            )
        from app.services.device_service import device_service

        device = device_service.get_device_by_device_id(
            db, user_id=user_id, device_id=execution_device_id
        )
        if device is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Execution device not found",
            )
        actual_type = device.json.get("spec", {}).get("deviceType", "local")
        expected = {"local": {"local", "app"}, "cloud": {"cloud", "remote"}}
        if actual_type not in expected.get(environment, set()):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Device '{execution_device_id}' is type '{actual_type}', "
                f"expected a {'local' if environment == 'local' else 'cloud'} device",
            )

    @staticmethod
    def agent_to_view(
        row: ProjectChatAgent, db: Session | None = None
    ) -> ProjectChatAgentView:
        config = bot_config(row)
        created_by_user_name = None
        if db is not None and row.created_by_user_id:
            from app.models.user import User

            creator = db.get(User, row.created_by_user_id)
            created_by_user_name = creator.user_name if creator else None
        return ProjectChatAgentView(
            id=row.id,
            project_id=row.cloud_project_id,
            name=row.title or row.name or "AI",
            runtime="codex",
            model=config.get("model") if isinstance(config.get("model"), str) else None,
            system_prompt=(
                config.get("system_prompt")
                if isinstance(config.get("system_prompt"), str)
                else ""
            ),
            status="archived" if row.status == "archived" else "active",
            visibility=config.get("visibility") or BOT_DEFAULT_VISIBILITY,
            execution_environment=(
                config.get("execution_environment") or BOT_DEFAULT_EXECUTION_ENVIRONMENT
            ),
            execution_mode=config.get("execution_mode") or BOT_DEFAULT_EXECUTION_MODE,
            execution_device_id=(
                config.get("execution_device_id")
                if isinstance(config.get("execution_device_id"), str)
                else None
            ),
            local_project_id=row.local_project_id,
            created_by_user_id=row.created_by_user_id,
            created_by_user_name=created_by_user_name,
            version=row.version,
            created_at=row.created_at.isoformat(),
            updated_at=row.updated_at.isoformat(),
        )

    @staticmethod
    def to_view(row: ProjectChatMessage) -> ProjectChatMessageView:
        runtime_address = None
        if row.runtime_device_id and row.runtime_task_id:
            runtime_address = {
                "deviceId": row.runtime_device_id,
                "taskId": row.runtime_task_id,
            }
        return ProjectChatMessageView(
            sequence_number=row.id,
            message_id=row.message_id,
            client_message_id=row.client_message_id or None,
            project_id=row.project_id,
            task_id=row.task_id or None,
            sender={
                "type": row.sender_type,
                "id": row.sender_id,
                "name": row.sender_name,
            },
            type=row.message_type,
            content=row.content,
            metadata=row.metadata_json if isinstance(row.metadata_json, dict) else {},
            trigger_message_id=row.trigger_message_id or None,
            reply_to_message_id=row.reply_to_message_id or None,
            root_message_id=row.thread_root_message_id or None,
            agent_id=row.agent_id or None,
            runtime_address=runtime_address,
            status=row.status,
            created_at=row.created_at.isoformat(),
            updated_at=row.updated_at.isoformat(),
        )


project_chat_service = ProjectChatService()
