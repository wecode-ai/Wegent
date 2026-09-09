# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist comments for board items stored by the Wegent Backend."""

import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_unread import advance_content_revision
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service


@dataclass(frozen=True)
class CommentActor:
    sender_type: str
    sender_id: str
    sender_name: str
    agent_id: str = ""
    runtime_device_id: str = ""
    runtime_task_id: str = ""


class BackendLoopItemCommentProvider:
    """Append one human or AI comment to the canonical board activity stream."""

    def add_comment(
        self,
        db: Session,
        *,
        item_id: str,
        user_id: int,
        user_name: str,
        body: str,
        automation_run_id: str = "",
        execution_id: int = 0,
    ) -> dict[str, object]:
        item = loop_item_service.get_for_edit(db, item_id, user_id)
        actor = self._actor(
            db,
            item=item,
            user_id=user_id,
            user_name=user_name,
            automation_run_id=automation_run_id,
            execution_id=execution_id,
        )
        return self._persist(
            db,
            item=item,
            actor=actor,
            user_id=user_id,
            body=body,
            automation_run_id=automation_run_id,
            execution_id=execution_id,
        )

    @staticmethod
    def _persist(
        db: Session,
        *,
        item: LoopItem,
        actor: CommentActor,
        user_id: int,
        body: str,
        automation_run_id: str,
        execution_id: int,
    ) -> dict[str, object]:
        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        message_metadata: dict[str, object] = {"kind": "board_item_comment"}
        if automation_run_id:
            message_metadata["automation_run_id"] = automation_run_id
        if execution_id:
            message_metadata["execution_id"] = execution_id
        row = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(item.cloud_project_id),
            task_id=str(item.id),
            sender_type=actor.sender_type,
            sender_id=actor.sender_id,
            sender_name=actor.sender_name,
            message_type="text",
            content=body,
            metadata_json=message_metadata,
            agent_id=actor.agent_id,
            runtime_device_id=actor.runtime_device_id,
            runtime_task_id=actor.runtime_task_id,
            status="completed",
        )
        db.add(row)
        item.metadata_json = advance_content_revision(
            item.metadata_json,
            actor_user_id=user_id if actor.sender_type == "user" else None,
        )
        item.version += 1
        db.commit()
        db.refresh(row)
        db.refresh(item)
        view = project_chat_service.to_view(row)
        push_project_chat_message(view.model_dump(mode="json", by_alias=True))
        publish_loop_item_changed(
            db,
            item=item,
            reason="project_chat",
            actor_user_id=user_id if actor.sender_type == "user" else 0,
        )
        return {
            "id": row.message_id,
            "body": row.content,
            "author": row.sender_name,
            "web_url": None,
            "created_at": row.created_at.isoformat(),
            "updated_at": row.updated_at.isoformat(),
        }

    def _actor(
        self,
        db: Session,
        *,
        item: LoopItem,
        user_id: int,
        user_name: str,
        automation_run_id: str,
        execution_id: int,
    ) -> CommentActor:
        if execution_id:
            return self._execution_actor(
                db,
                item=item,
                user_id=user_id,
                execution_id=execution_id,
            )
        if automation_run_id:
            return self._automation_actor(
                db,
                item=item,
                user_id=user_id,
                automation_run_id=automation_run_id,
            )
        return CommentActor("user", str(user_id), user_name)

    def _execution_actor(
        self,
        db: Session,
        *,
        item: LoopItem,
        user_id: int,
        execution_id: int,
    ) -> CommentActor:
        execution = db.get(LoopItemExecution, execution_id)
        if (
            execution is None
            or execution.loop_item_id != str(item.id)
            or execution.cloud_project_id != str(item.cloud_project_id)
            or execution.executor_owner_user_id != user_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Comment execution does not belong to this board item",
            )
        activity = self._execution_activity(db, execution)
        if activity is not None:
            return self._activity_actor(activity)
        if execution.agent_id:
            agent = db.get(ProjectChatAgent, execution.agent_id)
            if agent is not None and str(agent.cloud_project_id) == str(
                item.cloud_project_id
            ):
                return CommentActor(
                    "agent",
                    str(agent.id),
                    agent.title or agent.name or "AI",
                    agent_id=str(agent.id),
                )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Comment execution has no board activity identity",
        )

    def _automation_actor(
        self,
        db: Session,
        *,
        item: LoopItem,
        user_id: int,
        automation_run_id: str,
    ) -> CommentActor:
        run = db.get(ProjectAutomationRun, automation_run_id)
        if (
            run is None
            or str(run.cloud_project_id) != str(item.cloud_project_id)
            or str(run.task_id or "") != str(item.id)
            or int(run.created_by_user_id or 0) != user_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Comment automation does not belong to this board item",
            )
        metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        message_id = metadata.get("activity_message_id")
        activity = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == message_id,
                ProjectChatMessage.project_id == str(item.cloud_project_id),
                ProjectChatMessage.task_id == str(item.id),
                ProjectChatMessage.sender_type == "agent",
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .one_or_none()
            if isinstance(message_id, str) and message_id
            else None
        )
        if activity is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Comment automation has no board activity identity",
            )
        return self._activity_actor(activity)

    @staticmethod
    def _execution_activity(
        db: Session, execution: LoopItemExecution
    ) -> ProjectChatMessage | None:
        return (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.project_id == execution.cloud_project_id,
                ProjectChatMessage.task_id == execution.loop_item_id,
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.metadata_json["execution_id"].as_integer()
                == execution.id,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .order_by(ProjectChatMessage.id.desc())
            .first()
        )

    @staticmethod
    def _activity_actor(activity: ProjectChatMessage) -> CommentActor:
        return CommentActor(
            sender_type="agent",
            sender_id=activity.sender_id,
            sender_name=activity.sender_name,
            agent_id=activity.agent_id or "",
            runtime_device_id=activity.runtime_device_id or "",
            runtime_task_id=activity.runtime_task_id or "",
        )


backend_loop_item_comment_provider = BackendLoopItemCommentProvider()
