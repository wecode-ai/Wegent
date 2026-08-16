# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Run Wework board automations through the ordinary Wegent Team pipeline."""

import asyncio
import logging
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session, make_transient

from app.core.events import TaskCompletedEvent, get_event_bus
from app.db.session import get_db_session
from app.models.delivery import ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.chat.storage.task_manager import (
    TaskCreationParams,
    create_chat_task,
)
from app.services.project_automation_completion import (
    fail_project_automation_dispatch,
    mark_project_automation_dispatch_started,
    register_project_automation_task_completion_handler,
)
from app.stores.tasks import subtask_store, task_store
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

_TERMINAL_TASK_STATUSES = {"COMPLETED", "FAILED", "CANCELLED", "DELETE"}
_BOARD_TEAM_SOURCES = {"board_team_assignment", "board_team_continuation"}


@dataclass(frozen=True)
class ManagedTeamExecutionHandle:
    """Stable Wegent Task identifiers returned to a managed board run."""

    task_id: int
    subtask_id: int
    source: str = "project_automation"
    execution_id: int = 0


@dataclass(frozen=True)
class _ExecutionObjects:
    task: TaskResource
    assistant_subtask: Subtask
    team: Kind
    user: User


class ProjectAutomationManagedExecutionService:
    """Create and dispatch one managed board run as a normal Wegent Task."""

    async def dispatch(
        self,
        *,
        db: Session,
        owner: User,
        team: Kind,
        prompt: str,
        title: str,
        project_id: str,
        loop_item_id: str,
        automation_run_id: str,
        project_chat_message_id: str,
        model_id: str | None = None,
    ) -> ManagedTeamExecutionHandle:
        """Create a real Task/Subtask and dispatch it without a device route."""

        normalized_prompt = prompt.strip()
        if not normalized_prompt:
            raise ValueError("Managed project automation prompt cannot be empty")
        if team.kind != "Team":
            raise ValueError("Managed project automation requires a Team resource")

        params = TaskCreationParams(
            message=normalized_prompt,
            title=title.strip() or "AI managed automation",
            model_id=model_id,
            task_type="chat",
            source="project_automation",
            auto_delete_executor="true",
        )
        result = await create_chat_task(
            db=db,
            user=owner,
            team=team,
            message=normalized_prompt,
            params=params,
            should_trigger_ai=True,
            source="project_automation",
        )
        if result.assistant_subtask is None:
            raise RuntimeError(
                "Managed project automation did not create an assistant subtask"
            )

        self._label_task(
            db=db,
            task=result.task,
            assistant_subtask_id=result.assistant_subtask.id,
            team_id=team.id,
            project_id=project_id,
            loop_item_id=loop_item_id,
            automation_run_id=automation_run_id,
            project_chat_message_id=project_chat_message_id,
        )
        db.commit()

        handle = ManagedTeamExecutionHandle(
            task_id=result.task.id,
            subtask_id=result.assistant_subtask.id,
        )
        try:
            from app.tasks.project_automation_tasks import (
                execute_managed_project_automation,
            )

            execute_managed_project_automation.delay(
                task_id=handle.task_id,
                assistant_subtask_id=handle.subtask_id,
                user_subtask_id=result.user_subtask.id,
                team_id=team.id,
                user_id=owner.id,
                prompt=normalized_prompt,
            )
        except Exception as exc:
            error = str(exc) or "AI 托管任务入队失败。"
            self.mark_dispatch_failed(
                task_id=handle.task_id,
                user_id=owner.id,
                error=error,
            )
            fail_project_automation_dispatch(task_id=handle.task_id, error=error)
            raise
        return handle

    async def dispatch_board_team(
        self,
        *,
        db: Session,
        owner: User,
        agent: ProjectChatAgent,
        team: Kind,
        prompt: str,
        title: str,
        project_id: str,
        loop_item_id: str,
        execution_id: int,
    ) -> ManagedTeamExecutionHandle:
        """Dispatch a Team-assigned board task through the ordinary Team pipeline."""

        normalized_prompt = prompt.strip()
        if not normalized_prompt:
            raise ValueError("A Team-assigned board task requires an execution prompt")
        if team.kind != "Team":
            raise ValueError("Board Team execution requires a Team resource")
        execution = db.get(LoopItemExecution, execution_id)
        if (
            execution is None
            or execution.loop_item_id != loop_item_id
            or execution.cloud_project_id != project_id
            or execution.agent_id != agent.id
            or execution.team_id != team.id
            or execution.executor_owner_user_id != owner.id
            or agent.cloud_project_id != project_id
            or agent.status != "active"
        ):
            raise ValueError("Board Team execution does not match its assignment")

        params = TaskCreationParams(
            message=normalized_prompt,
            title=title.strip() or "Board task",
            task_type="chat",
            source="board_team_assignment",
            auto_delete_executor="true",
        )
        result = await create_chat_task(
            db=db,
            user=owner,
            team=team,
            message=normalized_prompt,
            params=params,
            should_trigger_ai=True,
            source="board_team_assignment",
            commit=False,
        )
        if result.assistant_subtask is None:
            raise RuntimeError(
                "Board Team execution did not create an assistant subtask"
            )

        task_json = (
            deepcopy(result.task.json) if isinstance(result.task.json, dict) else {}
        )
        metadata = task_json.setdefault("metadata", {})
        labels = metadata.setdefault("labels", {})
        labels.update(
            {
                "source": "board_team_assignment",
                "boardTeamExecutionId": str(execution.id),
                "boardTeamSubtaskId": str(result.assistant_subtask.id),
                "boardTeamTeamId": str(team.id),
                "weworkSpaceProjectId": project_id,
                "weworkSpaceTaskId": loop_item_id,
            }
        )
        task_store.update_json(db, task=result.task, payload=task_json)
        execution.backend_task_id = result.task.id
        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        activity = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=project_id,
            task_id=loop_item_id,
            sender_type="agent",
            sender_id=agent.id,
            sender_name=agent.title or agent.name or "AI",
            message_type="agent_status",
            content="",
            metadata_json={
                "execution_id": execution.id,
                "executor_type": "wegent_team",
                "executor_ref": str(team.id),
                "backend_task_id": result.task.id,
                "run_status": "queued",
            },
            agent_id=agent.id,
            runtime_device_id="",
            runtime_task_id="",
            status="pending",
        )
        db.add(activity)
        db.commit()

        handle = ManagedTeamExecutionHandle(
            task_id=result.task.id,
            subtask_id=result.assistant_subtask.id,
            source="board_team_assignment",
            execution_id=execution.id,
        )
        try:
            from app.tasks.project_automation_tasks import (
                execute_managed_project_automation,
            )

            execute_managed_project_automation.delay(
                task_id=handle.task_id,
                assistant_subtask_id=handle.subtask_id,
                user_subtask_id=result.user_subtask.id,
                team_id=team.id,
                user_id=owner.id,
                prompt=normalized_prompt,
                source=handle.source,
                execution_id=handle.execution_id,
            )
        except Exception as exc:
            from app.services.loop_item_executions.service import (
                loop_item_execution_service,
            )

            loop_item_execution_service.fail(
                db,
                execution_id=execution.id,
                error=str(exc) or "Wegent Team task enqueue failed",
            )
            self.mark_dispatch_failed(
                task_id=handle.task_id,
                user_id=owner.id,
                error=str(exc) or "Wegent Team task enqueue failed",
            )
            raise
        return handle

    @staticmethod
    def _label_task(
        *,
        db: Session,
        task: TaskResource,
        assistant_subtask_id: int,
        team_id: int,
        project_id: str,
        loop_item_id: str,
        automation_run_id: str,
        project_chat_message_id: str,
    ) -> None:
        task_json = deepcopy(task.json) if isinstance(task.json, dict) else {}
        metadata = task_json.setdefault("metadata", {})
        labels = metadata.setdefault("labels", {})
        labels.update(
            {
                "source": "project_automation",
                "projectAutomationSubtaskId": str(assistant_subtask_id),
                "projectAutomationTeamId": str(team_id),
                "projectAutomationRunId": str(automation_run_id),
                "projectChatMessageId": str(project_chat_message_id),
                "weworkSpaceProjectId": str(project_id),
                "weworkSpaceTaskId": str(loop_item_id),
            }
        )
        task_store.update_json(db, task=task, payload=task_json)

    @trace_async(
        span_name="project_automation.managed_team.dispatch",
        tracer_name="backend.project_automation",
        extract_attributes=lambda self, **kwargs: {
            "task.id": kwargs["handle"].task_id,
            "subtask.id": kwargs["handle"].subtask_id,
        },
    )
    async def execute(
        self,
        *,
        handle: ManagedTeamExecutionHandle,
        user_subtask_id: int,
        team_id: int,
        user_id: int,
        prompt: str,
        source: str = "project_automation",
        execution_id: int = 0,
    ) -> bool:
        """Build and dispatch the durable Task from a Celery worker."""

        from app.services.chat.trigger.unified import build_execution_request
        from app.services.execution import execution_dispatcher
        from app.services.execution.emitters import SSEResultEmitter

        if source in _BOARD_TEAM_SOURCES:
            from app.services.board_team_completion import (
                register_board_team_completion_handler,
            )

            register_board_team_completion_handler()
        else:
            register_project_automation_task_completion_handler()
        if not self._claim_pending_execution(
            handle=handle, user_id=user_id, source=source
        ):
            logger.info(
                "Managed project automation dispatch skipped because the persisted "
                "assistant subtask is no longer pending: task_id=%s subtask_id=%s",
                handle.task_id,
                handle.subtask_id,
            )
            return False

        if source == "board_team_assignment":
            from app.services.loop_item_executions.service import (
                loop_item_execution_service,
            )

            with get_db_session() as db:
                execution = loop_item_execution_service.mark_managed_running(
                    db,
                    execution_id=execution_id,
                    backend_task_id=handle.task_id,
                )
            if execution.status != "running":
                self._mark_cancelled(
                    task_id=handle.task_id,
                    user_id=user_id,
                    source=source,
                )
                await self._publish_cancelled(
                    handle=handle,
                    user_id=user_id,
                    source=source,
                )
                logger.info(
                    "Board Team dispatch stopped because its execution is no "
                    "longer queued: task_id=%s execution_id=%s status=%s",
                    handle.task_id,
                    execution_id,
                    execution.status,
                )
                return False
        elif source == "project_automation":
            mark_project_automation_dispatch_started(task_id=handle.task_id)
        elif source == "board_team_continuation":
            from app.services.board_team_continuation import (
                mark_board_team_continuation_started,
            )

            mark_board_team_continuation_started(
                task_id=handle.task_id,
                subtask_id=handle.subtask_id,
                user_id=user_id,
            )
        else:
            raise ValueError(f"Unsupported managed execution source: {source}")
        objects = self._load_detached_execution_objects(
            handle=handle,
            team_id=team_id,
            user_id=user_id,
        )
        request = await build_execution_request(
            task=objects.task,
            assistant_subtask=objects.assistant_subtask,
            team=objects.team,
            user=objects.user,
            message=prompt,
            device_id=None,
            payload=None,
            user_subtask_id=user_subtask_id,
            is_subscription=False,
            enable_tools=True,
            enable_deep_thinking=True,
            include_wework_space_mcp=True,
        )
        request.device_id = None
        if not self._execution_is_running(
            handle=handle,
            user_id=user_id,
            source=source,
        ):
            logger.info(
                "Managed project automation dispatch stopped before routing because "
                "the Task was cancelled: task_id=%s subtask_id=%s",
                handle.task_id,
                handle.subtask_id,
            )
            return False
        emitter = SSEResultEmitter(
            task_id=handle.task_id,
            subtask_id=handle.subtask_id,
        )
        dispatch_task = asyncio.create_task(
            execution_dispatcher.dispatch(request, device_id=None, emitter=emitter)
        )
        await emitter.collect()
        await dispatch_task
        return True

    @staticmethod
    def _claim_pending_execution(
        *,
        handle: ManagedTeamExecutionHandle,
        user_id: int,
        source: str = "project_automation",
    ) -> bool:
        """Atomically claim the persisted assistant subtask for one worker."""

        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=handle.task_id)
            if task is None or task.user_id != user_id:
                return False
            labels = ProjectAutomationManagedExecutionService._labels(task)
            expected_task_source = (
                "board_team_assignment" if source in _BOARD_TEAM_SOURCES else source
            )
            if labels.get("source") != expected_task_source:
                return False
            try:
                labelled_subtask_id = int(
                    labels[
                        (
                            "boardTeamSubtaskId"
                            if source == "board_team_assignment"
                            else (
                                "boardTeamActiveSubtaskId"
                                if source == "board_team_continuation"
                                else "projectAutomationSubtaskId"
                            )
                        )
                    ]
                )
            except (KeyError, TypeError, ValueError):
                return False
            if labelled_subtask_id != handle.subtask_id:
                return False

            task_crd = Task.model_validate(task.json)
            task_status = task_crd.status.status if task_crd.status else None
            if task_status in _TERMINAL_TASK_STATUSES:
                return False

            now = datetime.now()
            claimed = subtask_store.transition_status(
                db,
                subtask_id=handle.subtask_id,
                task_id=handle.task_id,
                owner_user_id=user_id,
                role=SubtaskRole.ASSISTANT,
                from_status=SubtaskStatus.PENDING,
                to_status=SubtaskStatus.RUNNING,
            )
            if not claimed:
                db.rollback()
                return False

            if task_crd.status:
                task_crd.status.status = "RUNNING"
                task_crd.status.updatedAt = now
            task_store.update_json(
                db,
                task=task,
                payload=task_crd.model_dump(mode="json", exclude_none=True),
            )
            db.commit()
            return True

    @staticmethod
    def _execution_is_running(
        *,
        handle: ManagedTeamExecutionHandle,
        user_id: int,
        source: str = "project_automation",
    ) -> bool:
        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=handle.task_id)
            subtask = subtask_store.get_basic_by_id(db, subtask_id=handle.subtask_id)
            if task is None or task.user_id != user_id or subtask is None:
                return False
            labels = ProjectAutomationManagedExecutionService._labels(task)
            subtask_label = {
                "board_team_assignment": "boardTeamSubtaskId",
                "board_team_continuation": "boardTeamActiveSubtaskId",
            }.get(source, "projectAutomationSubtaskId")
            expected_task_source = (
                "board_team_assignment" if source in _BOARD_TEAM_SOURCES else source
            )
            if labels.get("source") != expected_task_source or labels.get(
                subtask_label
            ) != str(handle.subtask_id):
                return False
            task_crd = Task.model_validate(task.json)
            task_status = task_crd.status.status if task_crd.status else None
            return (
                task_status == "RUNNING"
                and subtask.task_id == handle.task_id
                and subtask.user_id == user_id
                and subtask.role == SubtaskRole.ASSISTANT
                and subtask.status == SubtaskStatus.RUNNING
            )

    @staticmethod
    def _load_detached_execution_objects(
        *,
        handle: ManagedTeamExecutionHandle,
        team_id: int,
        user_id: int,
    ) -> _ExecutionObjects:
        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=handle.task_id)
            subtask = subtask_store.get_basic_by_id(db, subtask_id=handle.subtask_id)
            team = (
                db.query(Kind).filter(Kind.id == team_id, Kind.kind == "Team").first()
            )
            user = db.query(User).filter(User.id == user_id).first()
            if task is None or subtask is None or team is None or user is None:
                raise RuntimeError(
                    "Managed project automation execution resources are unavailable"
                )
            objects = _ExecutionObjects(task, subtask, team, user)
            for obj in (
                objects.task,
                objects.assistant_subtask,
                objects.team,
                objects.user,
            ):
                db.refresh(obj)
                make_transient(obj)
            return objects

    async def cancel(
        self,
        *,
        task_id: int,
        user_id: int,
        source: str = "project_automation",
    ) -> bool:
        """Cancel one managed Task without dispatching a queued execution."""

        from app.services.chat.trigger.unified import build_execution_request
        from app.services.execution import execution_dispatcher

        handle = (
            self._managed_handle(task_id=task_id, user_id=user_id)
            if source == "project_automation"
            else self._managed_handle(
                task_id=task_id,
                user_id=user_id,
                source=source,
            )
        )
        if handle is None:
            return False
        if self._cancel_pending(handle=handle, user_id=user_id):
            await self._publish_cancelled(
                handle=handle,
                user_id=user_id,
                source=source,
            )
            return True

        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=task_id)
            if task is None or task.user_id != user_id:
                return False
            labels = self._labels(task)
            team_id_value = labels.get(
                "boardTeamTeamId"
                if source == "board_team_assignment"
                else "projectAutomationTeamId"
            )
            try:
                team_id = int(team_id_value)
            except (TypeError, ValueError):
                return False
            assistant = subtask_store.get_basic_by_id(db, subtask_id=handle.subtask_id)
            if (
                assistant is None
                or assistant.task_id != task_id
                or assistant.user_id != user_id
                or assistant.role != SubtaskRole.ASSISTANT
                or assistant.status != SubtaskStatus.RUNNING
            ):
                return False
            all_subtasks = subtask_store.list_by_task_unfiltered(
                db, task_id=task_id, owner_user_id=user_id
            )
            user_subtask_id = next(
                (
                    subtask.id
                    for subtask in reversed(all_subtasks)
                    if subtask.role == SubtaskRole.USER
                ),
                None,
            )
            prompt = self._task_prompt(task)

        objects = self._load_detached_execution_objects(
            handle=handle,
            team_id=team_id,
            user_id=user_id,
        )
        request = await build_execution_request(
            task=objects.task,
            assistant_subtask=objects.assistant_subtask,
            team=objects.team,
            user=objects.user,
            message=prompt,
            device_id=None,
            payload=None,
            user_subtask_id=user_subtask_id,
            is_subscription=False,
            enable_tools=True,
            enable_deep_thinking=True,
            include_wework_space_mcp=True,
        )
        request.device_id = None
        cancel_signal_sent = await execution_dispatcher.cancel(request, device_id=None)
        if not cancel_signal_sent:
            logger.error(
                "Managed project automation executor did not acknowledge cancellation: "
                "task_id=%s subtask_id=%s",
                task_id,
                handle.subtask_id,
            )
            return False
        marked_cancelled = (
            self._mark_cancelled(task_id=task_id, user_id=user_id)
            if source == "project_automation"
            else self._mark_cancelled(
                task_id=task_id,
                user_id=user_id,
                source=source,
            )
        )
        if not marked_cancelled:
            return False
        await self._publish_cancelled(
            handle=handle,
            user_id=user_id,
            source=source,
        )
        return True

    @classmethod
    def _managed_handle(
        cls,
        *,
        task_id: int,
        user_id: int,
        source: str = "project_automation",
    ) -> ManagedTeamExecutionHandle | None:
        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=task_id)
            if task is None or task.user_id != user_id:
                return None
            labels = cls._labels(task)
            if labels.get("source") != source:
                return None
            subtask_label = (
                "boardTeamSubtaskId"
                if source == "board_team_assignment"
                else "projectAutomationSubtaskId"
            )
            try:
                subtask_id = int(labels[subtask_label])
                execution_id = (
                    int(labels["boardTeamExecutionId"])
                    if source == "board_team_assignment"
                    else 0
                )
            except (KeyError, TypeError, ValueError):
                return None
            return ManagedTeamExecutionHandle(
                task_id=task_id,
                subtask_id=subtask_id,
                source=source,
                execution_id=execution_id,
            )

    @staticmethod
    def _cancel_pending(*, handle: ManagedTeamExecutionHandle, user_id: int) -> bool:
        """Atomically cancel a queued assistant before a worker can claim it."""

        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=handle.task_id)
            if task is None or task.user_id != user_id:
                return False
            now = datetime.now()
            cancelled = subtask_store.transition_status(
                db,
                subtask_id=handle.subtask_id,
                task_id=handle.task_id,
                owner_user_id=user_id,
                role=SubtaskRole.ASSISTANT,
                from_status=SubtaskStatus.PENDING,
                to_status=SubtaskStatus.CANCELLED,
                progress=100,
                completed_at=now,
            )
            if not cancelled:
                db.rollback()
                return False

            ProjectAutomationManagedExecutionService._write_cancelled_task(
                db=db,
                task=task,
                now=now,
            )
            subtask_store.mark_task_subtasks_by_statuses(
                db,
                task_id=handle.task_id,
                from_statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
                to_status=SubtaskStatus.CANCELLED,
                progress=100,
                completed_at=now,
                owner_user_id=user_id,
            )
            db.commit()
            return True

    @staticmethod
    async def _publish_cancelled(
        *,
        handle: ManagedTeamExecutionHandle,
        user_id: int,
        source: str = "project_automation",
    ) -> None:
        from app.services.chat.storage import session_manager

        try:
            await session_manager.cleanup_streaming_state(
                handle.subtask_id,
                task_id=handle.task_id,
            )
        except Exception:
            logger.warning(
                "Managed project automation cancellation could not clean streaming "
                "state: task_id=%s subtask_id=%s",
                handle.task_id,
                handle.subtask_id,
                exc_info=True,
            )
        if source == "board_team_assignment":
            from app.services.board_team_completion import (
                register_board_team_completion_handler,
            )

            register_board_team_completion_handler()
        else:
            register_project_automation_task_completion_handler()
        await get_event_bus().publish(
            TaskCompletedEvent(
                task_id=handle.task_id,
                subtask_id=handle.subtask_id,
                user_id=user_id,
                status="CANCELLED",
            )
        )

    @staticmethod
    def _labels(task: TaskResource) -> dict:
        task_json = task.json if isinstance(task.json, dict) else {}
        metadata = task_json.get("metadata")
        labels = metadata.get("labels") if isinstance(metadata, dict) else None
        return labels if isinstance(labels, dict) else {}

    @staticmethod
    def _task_prompt(task: TaskResource) -> str:
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec")
        prompt = spec.get("prompt") if isinstance(spec, dict) else None
        return prompt if isinstance(prompt, str) else ""

    @staticmethod
    def _mark_cancelled(
        *,
        task_id: int,
        user_id: int,
        source: str = "project_automation",
    ) -> bool:
        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=task_id)
            if task is None or task.user_id != user_id:
                return False
            labels = ProjectAutomationManagedExecutionService._labels(task)
            subtask_label = (
                "boardTeamSubtaskId"
                if source == "board_team_assignment"
                else "projectAutomationSubtaskId"
            )
            try:
                subtask_id = int(labels[subtask_label])
            except (KeyError, TypeError, ValueError):
                return False
            task_crd = Task.model_validate(task.json)
            current_status = task_crd.status.status if task_crd.status else None
            if current_status in _TERMINAL_TASK_STATUSES:
                return False
            now = datetime.now()
            cancelled = subtask_store.transition_status(
                db,
                subtask_id=subtask_id,
                task_id=task_id,
                owner_user_id=user_id,
                role=SubtaskRole.ASSISTANT,
                from_status=SubtaskStatus.RUNNING,
                to_status=SubtaskStatus.CANCELLED,
                progress=100,
                completed_at=now,
            )
            if not cancelled:
                db.rollback()
                return False
            subtask_store.mark_task_subtasks_by_statuses(
                db,
                task_id=task_id,
                from_statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
                to_status=SubtaskStatus.CANCELLED,
                progress=100,
                completed_at=now,
                owner_user_id=user_id,
            )
            ProjectAutomationManagedExecutionService._write_cancelled_task(
                db=db,
                task=task,
                now=now,
            )
            db.commit()
            return True

    @staticmethod
    def _write_cancelled_task(
        *, db: Session, task: TaskResource, now: datetime
    ) -> None:
        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            task_crd.status.status = "CANCELLED"
            task_crd.status.progress = 100
            task_crd.status.errorMessage = ""
            task_crd.status.updatedAt = now
            task_crd.status.completedAt = now
        task_store.update_json(
            db,
            task=task,
            payload=task_crd.model_dump(mode="json", exclude_none=True),
        )

    @staticmethod
    def mark_dispatch_failed(*, task_id: int, user_id: int, error: str) -> None:
        """Keep the real Wegent Task truthful when request construction fails."""

        from app.services.task_status import mark_task_failed_payload

        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=task_id)
            if task is None or task.user_id != user_id:
                return
            task_json = task.json if isinstance(task.json, dict) else {}
            current_status = (task_json.get("status") or {}).get("status")
            if current_status in {"COMPLETED", "FAILED", "CANCELLED", "DELETE"}:
                return
            task_store.update_json(
                db,
                task=task,
                payload=mark_task_failed_payload(task_json, error),
            )
            subtask_store.mark_task_subtasks_by_statuses(
                db,
                task_id=task_id,
                from_statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
                to_status=SubtaskStatus.FAILED,
                progress=100,
                completed_at=datetime.now(),
            )
            db.commit()


project_automation_managed_execution_service = (
    ProjectAutomationManagedExecutionService()
)
