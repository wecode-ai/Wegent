# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Continue a board Bot's native Wegent Task from a task comment reply."""

import uuid
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import (
    ProjectChatMessageView,
    ProjectChatWegentContinuation,
)
from app.services.chat.storage.task_manager import TaskCreationParams, create_chat_task
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import bot_config, project_chat_service
from app.stores.tasks import task_store

CONTINUATION_SOURCE = "board_team_continuation"
ACTIVE_SUBTASK_LABEL = "boardTeamActiveSubtaskId"
ACTIVE_MESSAGE_LABEL = "boardTeamActiveMessageId"


@dataclass(frozen=True)
class BoardTeamContinuationResult:
    """The durable board activity opened for one native follow-up turn."""

    message: ProjectChatMessageView
    created: bool


class BoardTeamContinuationService:
    """Resolve, persist, and dispatch native Wegent board continuations."""

    async def start(
        self,
        db: Session,
        *,
        user_id: int,
        request: ProjectChatWegentContinuation,
    ) -> BoardTeamContinuationResult:
        project_chat_service._require_scope(
            db,
            user_id=user_id,
            project_id=request.project_id,
            task_id=request.task_id,
            required_role=BaseRole.Developer,
        )
        trigger = self._trigger_message(db, request)
        reply_target = self._reply_target(db, request, trigger)
        execution = self._execution(db, request, reply_target)
        agent, team, owner = self._runtime_objects(db, request, execution)

        # Serialize duplicate Socket ACK retries and concurrent replies on the
        # durable user comment. The same trigger can own exactly one Wegent turn.
        trigger = (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.id == trigger.id)
            .with_for_update()
            .one()
        )
        existing = self._existing_response(db, request, trigger)
        if existing is not None:
            return BoardTeamContinuationResult(
                project_chat_service.to_view(existing), created=False
            )

        native_task = task_store.get_by_id_for_update(
            db,
            task_id=execution.backend_task_id,
            owner_user_id=owner.id,
        )
        if native_task is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Wegent task is unavailable")
        active_turn = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.runtime_task_id.startswith(
                    f"wegent:{native_task.id}:"
                ),
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.status.in_(["pending", "streaming"]),
            )
            .first()
        )
        if active_turn is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "The previous Wegent continuation is still running",
            )

        params = TaskCreationParams(
            message=trigger.content,
            title=self._task_title(native_task),
            task_type="chat",
            source=CONTINUATION_SOURCE,
            auto_delete_executor="true",
        )
        created = await create_chat_task(
            db=db,
            user=owner,
            team=team,
            message=trigger.content,
            params=params,
            task_id=native_task.id,
            should_trigger_ai=True,
            source=CONTINUATION_SOURCE,
            commit=False,
        )
        if created.assistant_subtask is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Wegent continuation did not create an assistant turn",
            )
        if request.attachment_ids:
            from app.services.chat.preprocessing import link_contexts_to_subtask

            link_contexts_to_subtask(
                db=db,
                subtask_id=created.user_subtask.id,
                user_id=user_id,
                attachment_ids=request.attachment_ids,
                task=created.task,
                user_name=trigger.sender_name,
            )

        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        response = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=request.project_id,
            task_id=request.task_id,
            sender_type="agent",
            sender_id=agent.id,
            sender_name=agent.title or agent.name or team.name or "Wegent Team",
            message_type="agent_chunk",
            content="",
            metadata_json={
                "execution_id": execution.id,
                "executor_type": "wegent_team",
                "executor_ref": str(team.id),
                "backend_task_id": native_task.id,
                "backend_subtask_id": created.assistant_subtask.id,
                "run_status": "queued",
            },
            trigger_message_id=trigger.message_id,
            reply_to_message_id=trigger.message_id,
            thread_root_message_id=(
                trigger.thread_root_message_id or trigger.message_id
            ),
            agent_id=agent.id,
            runtime_device_id="",
            runtime_task_id=(f"wegent:{native_task.id}:{created.assistant_subtask.id}"),
            status="pending",
        )
        db.add(response)
        self._bind_active_turn(
            db,
            task=created.task,
            subtask_id=created.assistant_subtask.id,
            message_id=message_id,
        )
        db.commit()
        db.refresh(response)

        try:
            from app.tasks.project_automation_tasks import (
                execute_board_team_continuation,
            )

            execute_board_team_continuation.delay(
                task_id=native_task.id,
                assistant_subtask_id=created.assistant_subtask.id,
                user_subtask_id=created.user_subtask.id,
                team_id=team.id,
                user_id=owner.id,
                prompt=trigger.content,
            )
        except Exception as exc:
            fail_board_team_continuation(
                task_id=native_task.id,
                subtask_id=created.assistant_subtask.id,
                user_id=owner.id,
                error=str(exc) or "Wegent continuation could not be queued",
            )
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Wegent continuation could not be queued",
            ) from exc
        db.refresh(response)
        return BoardTeamContinuationResult(
            project_chat_service.to_view(response), created=True
        )

    @staticmethod
    def _trigger_message(
        db: Session, request: ProjectChatWegentContinuation
    ) -> ProjectChatMessage:
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == request.trigger_message_id,
                ProjectChatMessage.project_id == request.project_id,
                ProjectChatMessage.task_id == request.task_id,
                ProjectChatMessage.sender_type == "user",
            )
            .one_or_none()
        )
        if row is None or not row.reply_to_message_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Wegent continuation requires a reply to an agent comment",
            )
        return row

    @staticmethod
    def _reply_target(
        db: Session,
        request: ProjectChatWegentContinuation,
        trigger: ProjectChatMessage,
    ) -> ProjectChatMessage:
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == trigger.reply_to_message_id,
                ProjectChatMessage.project_id == request.project_id,
                ProjectChatMessage.task_id == request.task_id,
                ProjectChatMessage.sender_type == "agent",
            )
            .one_or_none()
        )
        metadata = (
            row.metadata_json if row and isinstance(row.metadata_json, dict) else {}
        )
        if row is None or metadata.get("executor_type") != "wegent_team":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Reply target is not a Wegent board execution",
            )
        return row

    @staticmethod
    def _execution(
        db: Session,
        request: ProjectChatWegentContinuation,
        reply_target: ProjectChatMessage,
    ) -> LoopItemExecution:
        metadata = reply_target.metadata_json
        try:
            execution_id = int(metadata["execution_id"])
            backend_task_id = int(metadata["backend_task_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Reply target has no durable Wegent task identity",
            ) from exc
        execution = db.get(LoopItemExecution, execution_id)
        if (
            execution is None
            or execution.cloud_project_id != request.project_id
            or execution.loop_item_id != request.task_id
            or execution.backend_task_id != backend_task_id
            or execution.team_id is None
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Reply target no longer matches its Wegent execution",
            )
        return execution

    @staticmethod
    def _runtime_objects(
        db: Session,
        request: ProjectChatWegentContinuation,
        execution: LoopItemExecution,
    ) -> tuple[ProjectChatAgent, Kind, User]:
        item = db.get(LoopItem, request.task_id)
        agent = db.get(ProjectChatAgent, request.agent_id)
        if (
            item is None
            or agent is None
            or item.cloud_project_id != request.project_id
            or item.assignee_agent_id != request.agent_id
            or execution.agent_id != request.agent_id
            or agent.cloud_project_id != request.project_id
            or agent.status != "active"
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Wegent robot no longer matches the board assignment",
            )
        config = bot_config(agent)
        if (
            config.get("runtime") != "wegent"
            or config.get("wegent_team_id") is None
            or int(config["wegent_team_id"]) != execution.team_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Wegent robot runtime configuration changed",
            )
        team = db.get(Kind, execution.team_id)
        owner = db.get(User, execution.executor_owner_user_id)
        if team is None or team.kind != "Team" or not team.is_active or owner is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Wegent continuation runtime is unavailable",
            )
        return agent, team, owner

    @staticmethod
    def _existing_response(
        db: Session,
        request: ProjectChatWegentContinuation,
        trigger: ProjectChatMessage,
    ) -> ProjectChatMessage | None:
        return (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.trigger_message_id == trigger.message_id,
                ProjectChatMessage.agent_id == request.agent_id,
                ProjectChatMessage.sender_type == "agent",
            )
            .order_by(ProjectChatMessage.id.asc())
            .first()
        )

    @staticmethod
    def _task_title(task: TaskResource) -> str:
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
        return str(spec.get("title") or "Board task")

    @staticmethod
    def _bind_active_turn(
        db: Session,
        *,
        task: TaskResource,
        subtask_id: int,
        message_id: str,
    ) -> None:
        task_json = deepcopy(task.json) if isinstance(task.json, dict) else {}
        metadata = task_json.setdefault("metadata", {})
        labels = metadata.setdefault("labels", {})
        labels[ACTIVE_SUBTASK_LABEL] = str(subtask_id)
        labels[ACTIVE_MESSAGE_LABEL] = message_id
        task_store.update_json(db, task=task, payload=task_json)

    @staticmethod
    def _task_labels(task: TaskResource) -> dict[str, Any]:
        task_json = task.json if isinstance(task.json, dict) else {}
        metadata = task_json.get("metadata")
        labels = metadata.get("labels") if isinstance(metadata, dict) else None
        return labels if isinstance(labels, dict) else {}


def _continuation_activity(
    db: Session,
    *,
    task_id: int,
    subtask_id: int,
    user_id: int,
    require_active: bool = True,
) -> ProjectChatMessage | None:
    task = task_store.get_by_id(db, task_id=task_id)
    if task is None or task.user_id != user_id:
        return None
    labels = BoardTeamContinuationService._task_labels(task)
    if labels.get("source") != "board_team_assignment":
        return None
    if require_active:
        if labels.get(ACTIVE_SUBTASK_LABEL) != str(subtask_id):
            return None
        message_id = labels.get(ACTIVE_MESSAGE_LABEL)
        if not isinstance(message_id, str) or not message_id:
            return None
        row = (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.message_id == message_id)
            .one_or_none()
        )
    else:
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.runtime_task_id == f"wegent:{task_id}:{subtask_id}",
                ProjectChatMessage.sender_type == "agent",
            )
            .one_or_none()
        )
    metadata = row.metadata_json if row and isinstance(row.metadata_json, dict) else {}
    if (
        row is None
        or metadata.get("executor_type") != "wegent_team"
        or metadata.get("backend_task_id") != task_id
        or metadata.get("backend_subtask_id") != subtask_id
    ):
        return None
    return row


def mark_board_team_continuation_started(
    *, task_id: int, subtask_id: int, user_id: int
) -> None:
    """Expose worker acceptance on the durable board activity."""

    from app.db.session import get_db_session

    message: dict[str, Any] | None = None
    with get_db_session() as db:
        row = _continuation_activity(
            db, task_id=task_id, subtask_id=subtask_id, user_id=user_id
        )
        if row is None or row.status in {"completed", "failed", "cancelled"}:
            return
        metadata = dict(row.metadata_json or {})
        row.metadata_json = {**metadata, "run_status": "running"}
        row.status = "streaming"
        db.commit()
        db.refresh(row)
        message = project_chat_service.to_view(row).model_dump(by_alias=True)
    if message is not None:
        push_project_chat_message(message)


def project_board_team_continuation(
    db: Session,
    *,
    task_id: int,
    subtask_id: int,
    user_id: int,
    status_value: str,
    content: str | None,
    error: str | None,
) -> bool:
    """Project one native continuation terminal event to its board reply."""

    from app.stores.tasks import subtask_store

    subtask = subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
    expected_status = {
        "COMPLETED": SubtaskStatus.COMPLETED,
        "FAILED": SubtaskStatus.FAILED,
        "CANCELLED": SubtaskStatus.CANCELLED,
    }.get(status_value.upper())
    if (
        subtask is None
        or expected_status is None
        or subtask.task_id != task_id
        or subtask.user_id != user_id
        or subtask.role != SubtaskRole.ASSISTANT
        or subtask.status != expected_status
    ):
        return False
    row = _continuation_activity(
        db,
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=user_id,
        require_active=False,
    )
    if row is None or row.status in {"completed", "failed", "cancelled"}:
        return False
    normalized = status_value.upper()
    if normalized == "COMPLETED":
        row.status = "completed"
        row.content = content or "Wegent continuation completed."
        run_status = "completed"
    elif normalized == "CANCELLED":
        row.status = "cancelled"
        row.content = content or error or "Wegent continuation cancelled."
        run_status = "cancelled"
    else:
        row.status = "failed"
        row.content = error or content or "Wegent continuation failed."
        run_status = "failed"
    row.message_type = "text"
    row.metadata_json = {**dict(row.metadata_json or {}), "run_status": run_status}
    db.commit()
    db.refresh(row)
    push_project_chat_message(
        project_chat_service.to_view(row).model_dump(by_alias=True)
    )
    return True


def fail_board_team_continuation(
    *, task_id: int, subtask_id: int, user_id: int, error: str
) -> None:
    """Persist a continuation failure that happens before a terminal event."""

    from app.db.session import get_db_session
    from app.services.project_automation_managed_execution import (
        project_automation_managed_execution_service,
    )

    project_automation_managed_execution_service.mark_dispatch_failed(
        task_id=task_id, user_id=user_id, error=error
    )
    with get_db_session() as db:
        project_board_team_continuation(
            db,
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=user_id,
            status_value="FAILED",
            content=None,
            error=error,
        )


board_team_continuation_service = BoardTeamContinuationService()
