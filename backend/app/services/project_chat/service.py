# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistence and authorization for shared project chat messages."""

import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
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


@dataclass(frozen=True)
class ProjectChatWriteResult:
    message: ProjectChatMessageView
    created: bool


class ProjectChatService:
    """Read and append messages in a project's single shared chat."""

    def list_agents(
        self, db: Session, *, user_id: int, project_id: str
    ) -> list[ProjectChatAgentView]:
        self._require_scope(
            db,
            user_id=user_id,
            project_id=project_id,
            task_id=None,
            required_role=BaseRole.Reporter,
        )
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
        return [self.agent_to_view(row) for row in rows]

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
            required_role=BaseRole.Maintainer,
        )
        row = ProjectChatAgent(
            cloud_project_id=project_id,
            title=request.name,
            name=request.name,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            status="active",
            metadata_json={
                "runtime": request.runtime,
                "model": request.model,
                "system_prompt": request.system_prompt,
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self.agent_to_view(row)

    def update_agent(
        self,
        db: Session,
        *,
        user_id: int,
        project_id: str,
        agent_id: str,
        request: ProjectChatAgentUpdate,
    ) -> ProjectChatAgentView:
        self._require_scope(
            db,
            user_id=user_id,
            project_id=project_id,
            task_id=None,
            required_role=BaseRole.Maintainer,
        )
        row = self._agent_row(db, project_id=project_id, agent_id=agent_id)
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
        row.metadata_json = metadata
        if request.status is not None:
            row.status = request.status
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()
        db.refresh(row)
        return self.agent_to_view(row)

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
            ProjectChatMessage.deleted_at.is_(None),
        )
        if request.task_id:
            query = query.filter(ProjectChatMessage.task_id == request.task_id)
        else:
            query = query.filter(ProjectChatMessage.task_id.is_(None))
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
        row = ProjectChatMessage(
            message_id=message_id,
            client_message_id=request.client_message_id,
            project_id=request.project_id,
            task_id=request.task_id,
            sender_type="user",
            sender_id=str(user_id),
            sender_name=user_name,
            message_type="text",
            content=request.content,
            metadata_json={
                "mentions": [
                    mention.model_dump(by_alias=True) for mention in request.mentions
                ]
            },
            status="completed",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return ProjectChatWriteResult(self.to_view(row), created=True)

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
        trigger = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == request.trigger_message_id,
                ProjectChatMessage.project_id == request.project_id,
                ProjectChatMessage.task_id == request.task_id,
                ProjectChatMessage.sender_type == "user",
                ProjectChatMessage.deleted_at.is_(None),
            )
            .first()
        )
        if trigger is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI response must be attached to its project chat message",
            )
        existing = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.trigger_message_id == request.trigger_message_id,
                ProjectChatMessage.agent_id == request.agent_id,
                ProjectChatMessage.deleted_at.is_(None),
            )
            .first()
        )
        if existing:
            return self.to_view(existing)
        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        row = ProjectChatMessage(
            message_id=message_id,
            project_id=request.project_id,
            task_id=request.task_id,
            sender_type="agent",
            sender_id=request.agent_id,
            sender_name=str(configured_agent.title or configured_agent.name),
            message_type="agent_chunk",
            content="",
            metadata_json={},
            trigger_message_id=request.trigger_message_id,
            agent_id=request.agent_id,
            runtime_device_id=request.runtime_device_id,
            runtime_task_id=request.runtime_task_id,
            status="streaming",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self.to_view(row)

    def project_runtime_event(
        self,
        db: Session,
        *,
        device_id: str,
        runtime_task_id: str,
        event_name: str,
        payload: dict,
    ) -> tuple[ProjectChatMessageView, str] | None:
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.runtime_device_id == device_id,
                ProjectChatMessage.runtime_task_id == runtime_task_id,
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.status == "streaming",
                ProjectChatMessage.deleted_at.is_(None),
            )
            .first()
        )
        if row is None:
            return None
        data = payload.get("data")
        data = data if isinstance(data, dict) else {}
        if event_name in {"response.output_text.delta", "response.refusal.delta"}:
            delta = data.get("delta")
            if not isinstance(delta, str) or not delta:
                return None
            # The database is the reconnect source of truth.  Persist every delta
            # before broadcasting it, so a browser refresh cannot lose streamed text.
            row.content = f"{row.content}{delta}"
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
        elif event_name == "response.completed":
            final_value = data.get("value")
            if isinstance(final_value, str) and final_value:
                row.content = final_value
            row.status = "completed"
            row.message_type = "text"
        elif event_name in {"response.failed", "response.incomplete", "error"}:
            error = data.get("error") or payload.get("error")
            if not row.content and isinstance(error, str):
                row.content = error
            row.status = "failed"
        else:
            return None
        db.commit()
        db.refresh(row)
        return self.to_view(row), "snapshot"

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
                ProjectChatMessage.task_id == request.task_id,
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.status == "streaming",
                ProjectChatMessage.deleted_at.is_(None),
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
                ProjectChatMessage.deleted_at.is_(None),
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
    def agent_to_view(row: ProjectChatAgent) -> ProjectChatAgentView:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        return ProjectChatAgentView(
            id=row.id,
            project_id=row.cloud_project_id,
            name=row.title or row.name or "AI",
            runtime="codex",
            model=(
                metadata.get("model")
                if isinstance(metadata.get("model"), str)
                else None
            ),
            system_prompt=(
                metadata.get("system_prompt")
                if isinstance(metadata.get("system_prompt"), str)
                else ""
            ),
            status="archived" if row.status == "archived" else "active",
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
            client_message_id=row.client_message_id,
            project_id=row.project_id,
            task_id=row.task_id,
            sender={
                "type": row.sender_type,
                "id": row.sender_id,
                "name": row.sender_name,
            },
            type=row.message_type,
            content=row.content,
            metadata=row.metadata_json if isinstance(row.metadata_json, dict) else {},
            trigger_message_id=row.trigger_message_id,
            agent_id=row.agent_id,
            runtime_address=runtime_address,
            status=row.status,
            created_at=row.created_at.isoformat(),
            updated_at=row.updated_at.isoformat(),
        )


project_chat_service = ProjectChatService()
