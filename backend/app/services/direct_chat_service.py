# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Control-plane service for Wework direct chat sessions."""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.api.ws.events import ChatSendPayload
from app.core.socketio import get_sio
from app.models.kind import Kind
from app.models.subtask import SubtaskStatus
from app.models.user import User
from app.schemas.device import DirectChatCapability
from app.schemas.direct_chat import (
    DirectChatAuthorizeConnectionPayload,
    DirectChatConnectionResponse,
    DirectChatTurnPrepareRequest,
    DirectChatTurnPrepareResponse,
)
from app.schemas.kind import Task
from app.services.chat.config import is_deep_research_protocol
from app.services.chat.rag import process_context_and_rag
from app.services.chat.storage import TaskCreationParams, create_chat_task
from app.services.chat.storage.session import session_manager
from app.services.chat.trigger import should_trigger_ai_response
from app.services.chat.trigger.unified import build_execution_request
from app.services.device_service import device_service
from app.stores.tasks import subtask_store

logger = logging.getLogger(__name__)

DIRECT_CHAT_CONNECTION_TTL_SECONDS = 12 * 60 * 60
DIRECT_CHAT_AUTHORIZE_TIMEOUT_SECONDS = 10


class DirectChatService:
    """Backend control plane for Wework-to-executor direct chat."""

    async def create_connection(
        self,
        *,
        db: Session,
        user: User,
        device_id: str,
    ) -> DirectChatConnectionResponse:
        """Authorize one Wework direct Socket.IO connection on a local executor."""

        device = device_service.get_device_by_device_id(db, user.id, device_id)
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        direct_chat = self._get_direct_chat_capability(device)
        if not direct_chat.enabled:
            raise HTTPException(
                status_code=409,
                detail="Device does not expose direct chat",
            )

        online_info = await device_service.get_device_online_info(user.id, device_id)
        if not online_info or not online_info.get("socket_id"):
            raise HTTPException(status_code=409, detail="Device is offline")

        connection_id = f"dc_{secrets.token_urlsafe(16)}"
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(
            seconds=DIRECT_CHAT_CONNECTION_TTL_SECONDS
        )
        auth_payload = DirectChatAuthorizeConnectionPayload(
            connection_id=connection_id,
            token=token,
            user_id=user.id,
            user_name=user.user_name,
            device_id=device_id,
            expires_at=expires_at,
        )

        try:
            response = await get_sio().call(
                "direct_chat:authorize_connection",
                auth_payload.model_dump(mode="json"),
                to=online_info["socket_id"],
                namespace="/local-executor",
                timeout=DIRECT_CHAT_AUTHORIZE_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "[DirectChat] Failed to authorize executor connection: "
                "user_id=%s device_id=%s error=%s",
                user.id,
                device_id,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Direct chat authorization failed: {exc}",
            ) from exc

        if not isinstance(response, dict) or not response.get("success"):
            error = response.get("error") if isinstance(response, dict) else None
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=error or "Executor rejected direct chat authorization",
            )

        return DirectChatConnectionResponse(
            connection_id=connection_id,
            token=token,
            device_id=device_id,
            expires_at=expires_at,
            endpoint=direct_chat,
        )

    async def prepare_turn(
        self,
        *,
        db: Session,
        user: User,
        request: DirectChatTurnPrepareRequest,
    ) -> DirectChatTurnPrepareResponse:
        """Persist a user turn and build the execution request for executor."""

        payload = request.payload
        device_id = payload.device_id
        if not device_id:
            raise HTTPException(status_code=400, detail="device_id is required")
        if not device_service.get_device_by_device_id(db, user.id, device_id):
            raise HTTPException(status_code=404, detail="Device not found")

        team = (
            db.query(Kind)
            .filter(
                Kind.id == payload.team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        if payload.task_id and is_deep_research_protocol(db, team):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Deep Research does not support follow-up questions. "
                    "Please start a new conversation."
                ),
            )

        self._validate_interactive_form_answer(db, payload)
        task_json = self._get_existing_task_json(db, payload.task_id)
        should_trigger_ai = should_trigger_ai_response(
            task_json,
            payload.message,
            team.name,
            request_is_group_chat=payload.is_group_chat,
        )
        _, rag_prompt = await process_context_and_rag(
            message=payload.message,
            contexts=payload.contexts,
            should_trigger_ai=should_trigger_ai,
            user_id=user.id,
            db=db,
        )

        result = await create_chat_task(
            db=db,
            user=user,
            team=team,
            message=payload.message,
            params=self._build_task_creation_params(payload),
            task_id=payload.task_id,
            should_trigger_ai=should_trigger_ai,
            rag_prompt=rag_prompt,
            source="wework_direct",
        )

        self._link_contexts(
            db=db,
            user=user,
            payload=payload,
            task=result.task,
            user_subtask_id=result.user_subtask.id if result.user_subtask else None,
        )

        execution_request: Optional[dict[str, Any]] = None
        if should_trigger_ai and result.assistant_subtask:
            subtask_store.update_fields(
                db,
                subtask=result.assistant_subtask,
                status=SubtaskStatus.RUNNING,
                executor_name=f"device-{device_id}",
            )
            db.commit()
            db.refresh(result.task)
            db.refresh(result.assistant_subtask)

            await session_manager.set_task_streaming_status(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                user_id=user.id,
                username=user.user_name,
            )

            request_payload = await build_execution_request(
                task=result.task,
                assistant_subtask=result.assistant_subtask,
                team=team,
                user=user,
                message=payload.message,
                payload=payload,
                device_id=device_id,
                user_subtask_id=(
                    result.user_subtask.id if result.user_subtask else None
                ),
            )
            execution_request = request_payload.to_dict()

        task_crd = Task.model_validate(result.task.json)
        if (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("type") == "subscription"
            and task_crd.metadata.labels.get("userInteracted") != "true"
        ):
            task_crd.metadata.labels["userInteracted"] = "true"
            task_stores.task_store.update_json(
                db, task=result.task, payload=task_crd.model_dump(mode="json")
            )
            db.commit()

        return DirectChatTurnPrepareResponse(
            task_id=result.task.id,
            user_subtask_id=result.user_subtask.id if result.user_subtask else None,
            user_message_id=(
                result.user_subtask.message_id if result.user_subtask else None
            ),
            assistant_subtask_id=(
                result.assistant_subtask.id if result.assistant_subtask else None
            ),
            assistant_message_id=(
                result.assistant_subtask.message_id
                if result.assistant_subtask
                else None
            ),
            assistant_started_at=(
                result.assistant_subtask.created_at
                if result.assistant_subtask
                else None
            ),
            ai_triggered=should_trigger_ai,
            execution_request=execution_request,
        )

    def _get_direct_chat_capability(self, device: Kind) -> DirectChatCapability:
        spec = (device.json or {}).get("spec", {})
        direct_chat = spec.get("directChat")
        if not isinstance(direct_chat, dict):
            raise HTTPException(
                status_code=409,
                detail="Device does not expose direct chat",
            )
        return DirectChatCapability.model_validate(direct_chat)

    def _build_task_creation_params(
        self, payload: ChatSendPayload
    ) -> TaskCreationParams:
        additional_skills = None
        if payload.additional_skills:
            additional_skills = [
                skill.model_dump(mode="json") for skill in payload.additional_skills
            ]

        generate_params = None
        if payload.generate_params:
            generate_params = payload.generate_params.model_dump(mode="json")

        execution_workspace = None
        if (
            not payload.task_id
            and payload.execution
            and payload.execution.workspace
            and payload.execution.workspace.source == "git_worktree"
        ):
            if not payload.project_id:
                raise HTTPException(
                    status_code=400,
                    detail="Git worktree execution requires a project",
                )
            execution_workspace = {"source": "git_worktree"}
            branch = (payload.execution.workspace.branch or "").strip()
            if branch:
                execution_workspace["branch"] = branch

        return TaskCreationParams(
            message=payload.message,
            title=payload.title,
            model_id=payload.force_override_bot_model,
            force_override_bot_model=payload.force_override_bot_model is not None,
            force_override_bot_model_type=payload.force_override_bot_model_type,
            model_options=payload.model_options,
            is_group_chat=payload.is_group_chat,
            git_url=payload.git_url,
            git_repo=payload.git_repo,
            git_repo_id=payload.git_repo_id,
            git_domain=payload.git_domain,
            branch_name=payload.branch_name,
            task_type=payload.task_type,
            knowledge_base_id=payload.knowledge_base_id,
            additional_skills=additional_skills,
            device_id=payload.device_id,
            project_id=payload.project_id,
            execution_workspace=execution_workspace,
            client_origin=payload.client_origin,
            generate_params=generate_params,
        )

    def _validate_interactive_form_answer(
        self, db: Session, payload: ChatSendPayload
    ) -> None:
        if not payload.task_id:
            return
        from app.services.chat.interactive_forms import (
            validate_interactive_form_answer,
        )

        validation = validate_interactive_form_answer(
            db,
            task_id=payload.task_id,
            answer=payload.interactive_form_answer,
        )
        if not validation.ok:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": validation.error,
                    "message": validation.message,
                },
            )

    def _get_existing_task_json(
        self, db: Session, task_id: Optional[int]
    ) -> dict[str, Any]:
        if not task_id:
            return {}
        existing_task = task_stores.task_store.get_regular_active_task(
            db,
            task_id=task_id,
        )
        return existing_task.json if existing_task else {}

    def _link_contexts(
        self,
        *,
        db: Session,
        user: User,
        payload: ChatSendPayload,
        task: Any,
        user_subtask_id: Optional[int],
    ) -> None:
        if not user_subtask_id:
            return
        from app.services.chat.preprocessing import link_contexts_to_subtask

        attachment_ids = payload.attachment_ids
        if not attachment_ids and payload.attachment_id:
            attachment_ids = [payload.attachment_id]

        link_contexts_to_subtask(
            db=db,
            subtask_id=user_subtask_id,
            user_id=user.id,
            attachment_ids=attachment_ids if attachment_ids else None,
            contexts=payload.contexts,
            task=task,
            user_name=user.user_name,
        )


direct_chat_service = DirectChatService()
