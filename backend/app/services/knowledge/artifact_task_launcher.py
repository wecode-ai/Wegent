# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Launch knowledge Artifact generation through the existing agent runtime."""

import asyncio
import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import CLIENT_ORIGIN_BACKGROUND
from app.models.user import User
from app.schemas.kind import Task, Team
from app.schemas.knowledge_artifact import KnowledgeArtifactType
from app.services.chat.config.model_resolver import get_model_config_for_bot
from app.services.chat.preprocessing import link_selected_documents_to_subtask
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.trigger.lifecycle import prepare_execution_session
from app.services.chat.trigger.unified import build_execution_request
from app.services.execution import execution_dispatcher
from app.services.execution.emitters import SSEResultEmitter
from app.services.readers import KindType, kindReader
from app.stores.tasks import task_store
from shared.models.db import Kind

logger = logging.getLogger(__name__)

_running_artifact_tasks: set[asyncio.Task] = set()


class ArtifactTaskConfigurationError(RuntimeError):
    """Raised when the configured Artifact agent cannot be used."""


@dataclass(frozen=True)
class ArtifactTaskLaunchResult:
    """Identifiers needed to reconcile a generated Artifact."""

    task_id: int
    assistant_subtask_id: int


class ArtifactTaskLauncher:
    """Create and dispatch a hidden Task for one Artifact."""

    def __init__(
        self,
        db: Session,
        user: User,
    ) -> None:
        self.db = db
        self.user = user

    async def launch(
        self,
        *,
        artifact_id: str,
        attempt: int,
        artifact_type: KnowledgeArtifactType,
        title: str,
        knowledge_base_id: int,
        document_ids: list[int],
        instruction: str | None,
        prepared_team: Kind | None = None,
    ) -> ArtifactTaskLaunchResult:
        """Create the agent session, bind sources, and schedule execution."""
        team = prepared_team or await self.preflight()
        message = self._build_prompt(artifact_type, instruction)
        params = TaskCreationParams(
            message=message,
            title=title,
            task_type="knowledge",
            knowledge_base_id=knowledge_base_id,
            task_name=f"knowledge-artifact-{artifact_id}-{attempt}",
            client_origin=CLIENT_ORIGIN_BACKGROUND,
            source="knowledge_artifact",
        )
        session = prepare_execution_session(
            db=self.db,
            user=self.user,
            team=team,
            input_text=message,
            task_params=params,
            should_trigger_ai=True,
        )
        if session.assistant_subtask is None:
            raise ArtifactTaskConfigurationError(
                "Artifact agent did not create an assistant subtask"
            )

        self._mark_task_as_background(session.task, artifact_id, attempt)
        link_selected_documents_to_subtask(
            self.db,
            subtask_id=session.user_subtask.id,
            user_id=self.user.id,
            knowledge_base_id=knowledge_base_id,
            document_ids=document_ids,
            task=session.task,
        )

        request = await build_execution_request(
            task=session.task,
            assistant_subtask=session.assistant_subtask,
            team=team,
            user=self.user,
            message=message,
            user_subtask_id=session.user_subtask.id,
            enable_tools=True,
            enable_deep_thinking=True,
        )
        self._schedule_execution(request)
        return ArtifactTaskLaunchResult(
            task_id=session.task_id,
            assistant_subtask_id=session.assistant_subtask.id,
        )

    async def preflight(self) -> Kind:
        """Validate the execution configuration without creating records."""
        team = self._resolve_team()
        try:
            team_crd = Team.model_validate(team.json)
        except ValueError as exc:
            raise ArtifactTaskConfigurationError(
                "Artifact agent configuration is invalid"
            ) from exc

        bot = self._resolve_first_bot(team, team_crd)
        if bot is None:
            raise ArtifactTaskConfigurationError(
                f"Artifact agent '{team.namespace}/{team.name}' has no available bot"
            )
        try:
            get_model_config_for_bot(self.db, bot, self.user.id)
        except ValueError as exc:
            raise ArtifactTaskConfigurationError(str(exc)) from exc
        return team

    def _resolve_team(self) -> Kind:
        config = (settings.DEFAULT_TEAM_KNOWLEDGE or "").strip()
        if not config:
            raise ArtifactTaskConfigurationError(
                "DEFAULT_TEAM_KNOWLEDGE is not configured"
            )
        name, separator, namespace = config.partition("#")
        name = name.strip()
        namespace = namespace.strip() if separator else "default"
        if not name:
            raise ArtifactTaskConfigurationError("DEFAULT_TEAM_KNOWLEDGE is invalid")

        team = kindReader.get_by_name_and_namespace(
            self.db,
            self.user.id,
            KindType.TEAM,
            namespace or "default",
            name,
        )
        if team is None:
            raise ArtifactTaskConfigurationError(
                f"Artifact agent '{namespace or 'default'}/{name}' is unavailable"
            )
        return team

    def _resolve_first_bot(self, team: Kind, team_crd: Team) -> Kind | None:
        for member in team_crd.spec.members:
            bot = kindReader.get_by_name_and_namespace(
                self.db,
                team.user_id,
                KindType.BOT,
                member.botRef.namespace,
                member.botRef.name,
            )
            if bot is not None:
                return bot
        return None

    def _mark_task_as_background(
        self,
        task,
        artifact_id: str,
        attempt: int,
    ) -> None:
        task_crd = Task.model_validate(task.json)
        labels = task_crd.metadata.labels or {}
        labels.update(
            {
                "type": "background",
                "taskType": "knowledge",
                "source": "knowledge_artifact",
                "artifactId": artifact_id,
                "artifactAttempt": str(attempt),
            }
        )
        task_crd.metadata.labels = labels
        task_store.update_json(
            self.db,
            task=task,
            payload=task_crd.model_dump(mode="json"),
        )
        self.db.commit()
        self.db.refresh(task)

    @staticmethod
    def _build_prompt(
        artifact_type: KnowledgeArtifactType,
        instruction: str | None,
    ) -> str:
        extra = instruction.strip() if instruction else "无额外要求"
        if artifact_type == KnowledgeArtifactType.BRIEFING:
            return (
                "请严格基于已选择的知识库文档生成一份结构清晰的中文简报。"
                "使用 Markdown 输出，包含核心结论、关键依据和下一步行动。"
                "不要输出 Markdown 代码围栏，也不要引入材料之外的事实。\n\n"
                f"补充要求：{extra}"
            )
        return (
            "请严格基于已选择的知识库文档生成一张思维导图。"
            "最终答案只能包含一个 mermaid 代码块，使用 mindmap 语法；"
            "不要在代码块前后添加解释文字。\n\n"
            f"补充要求：{extra}"
        )

    def _schedule_execution(self, request) -> None:
        task = asyncio.create_task(
            self._dispatch_and_drain(request),
            name=f"knowledge-artifact-{request.task_id}",
        )
        _running_artifact_tasks.add(task)
        task.add_done_callback(_running_artifact_tasks.discard)

    @staticmethod
    async def _dispatch_and_drain(request) -> None:
        emitter = SSEResultEmitter(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
        )
        dispatch_task = asyncio.create_task(
            execution_dispatcher.dispatch(request, emitter=emitter)
        )
        collect_task = asyncio.create_task(emitter.collect())
        dispatch_result, _collect_result = await asyncio.gather(
            dispatch_task,
            collect_task,
            return_exceptions=True,
        )
        if isinstance(dispatch_result, BaseException):
            logger.error(
                "Artifact execution failed: task_id=%s, subtask_id=%s, error=%s",
                request.task_id,
                request.subtask_id,
                dispatch_result,
            )
