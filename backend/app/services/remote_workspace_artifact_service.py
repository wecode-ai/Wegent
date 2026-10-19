# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metadata-only declarations for files produced in remote Task workspaces."""

import posixpath
from pathlib import PurePosixPath

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.schemas.remote_workspace import (
    RemoteWorkspaceArtifactDeclareRequest,
    RemoteWorkspaceArtifactResponse,
)
from app.services.context import context_service
from app.services.context.context_service import NotFoundException
from app.services.remote_workspace_service import remote_workspace_service
from app.stores.tasks import subtask_store
from shared.models.db.enums import SubtaskRole


class RemoteWorkspaceArtifactService:
    """Persist artifact metadata and stream the current device file on demand."""

    def declare(
        self,
        db: Session,
        *,
        task_id: int,
        subtask_id: int,
        user_id: int,
        request: RemoteWorkspaceArtifactDeclareRequest,
    ) -> RemoteWorkspaceArtifactResponse:
        subtask = subtask_store.get_by_id_and_role(
            db,
            subtask_id=subtask_id,
            role=SubtaskRole.ASSISTANT,
            owner_user_id=user_id,
        )
        if subtask is None or subtask.task_id != task_id:
            raise HTTPException(status_code=403, detail="Artifact subtask is invalid")

        relative_path = self._normalize_relative_path(request.relative_path)
        context = self._find_existing(db, subtask_id, relative_path)
        type_data = {
            "task_id": task_id,
            "relative_path": relative_path,
            "file_extension": PurePosixPath(relative_path).suffix.lower(),
            "file_size": request.file_size,
            "mime_type": request.mime_type or "application/octet-stream",
            "modified_at": request.modified_at,
            "sha256": request.sha256.lower(),
        }
        if context is None:
            context = SubtaskContext(
                subtask_id=subtask_id,
                user_id=user_id,
                context_type=ContextType.REMOTE_WORKSPACE_ARTIFACT.value,
                name=request.name,
                status=ContextStatus.READY.value,
                binary_data=b"",
                image_base64="",
                extracted_text="",
                text_length=0,
                error_message="",
                type_data=type_data,
            )
            db.add(context)
        else:
            context.name = request.name
            context.status = ContextStatus.READY.value
            context.error_message = ""
            context.type_data = type_data

        db.commit()
        db.refresh(context)
        return self._response(context, task_id, relative_path)

    def stream_file(
        self,
        db: Session,
        *,
        task_id: int,
        context_id: int,
        user_id: int,
        disposition: str,
    ) -> StreamingResponse:
        try:
            context = context_service.get_context(db, context_id, user_id=user_id)
        except NotFoundException as error:
            raise HTTPException(status_code=404, detail="Artifact not found") from error

        if context.context_type != ContextType.REMOTE_WORKSPACE_ARTIFACT.value:
            raise HTTPException(status_code=404, detail="Artifact not found")
        subtask = subtask_store.get_basic_by_id(
            db,
            subtask_id=context.subtask_id,
            owner_user_id=user_id,
        )
        if subtask is None or subtask.task_id != task_id:
            raise HTTPException(status_code=404, detail="Artifact not found")

        relative_path = self._normalize_relative_path(
            str((context.type_data or {}).get("relative_path", ""))
        )
        workspace = remote_workspace_service.get_status(
            db=db,
            task_id=task_id,
            user_id=user_id,
        )
        if not workspace.available:
            raise HTTPException(
                status_code=409,
                detail="Remote workspace artifact is currently unavailable",
            )
        absolute_path = posixpath.join(workspace.root_path, relative_path)
        return remote_workspace_service.stream_file(
            db=db,
            task_id=task_id,
            user_id=user_id,
            path=absolute_path,
            disposition=disposition,
        )

    @staticmethod
    def _normalize_relative_path(value: str) -> str:
        path = value.strip()
        if not path or "\\" in path or path.startswith("/"):
            raise HTTPException(status_code=400, detail="Invalid artifact path")
        parts = PurePosixPath(path).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise HTTPException(status_code=400, detail="Invalid artifact path")
        normalized = posixpath.normpath(path)
        if normalized == "." or normalized.startswith("../"):
            raise HTTPException(status_code=400, detail="Invalid artifact path")
        return normalized

    @staticmethod
    def _find_existing(
        db: Session,
        subtask_id: int,
        relative_path: str,
    ) -> SubtaskContext | None:
        for context in context_service.get_by_subtask(db, subtask_id):
            if (
                context.context_type == ContextType.REMOTE_WORKSPACE_ARTIFACT.value
                and (context.type_data or {}).get("relative_path") == relative_path
            ):
                return context
        return None

    @staticmethod
    def _response(
        context: SubtaskContext,
        task_id: int,
        relative_path: str,
    ) -> RemoteWorkspaceArtifactResponse:
        data = context.type_data or {}
        return RemoteWorkspaceArtifactResponse(
            id=context.id,
            task_id=task_id,
            subtask_id=context.subtask_id,
            relative_path=relative_path,
            name=context.name,
            file_size=int(data.get("file_size", 0)),
            mime_type=str(data.get("mime_type", "application/octet-stream")),
            modified_at=data.get("modified_at"),
            sha256=str(data.get("sha256", "")),
            download_url=(
                f"/api/tasks/{task_id}/remote-workspace/artifacts/{context.id}/file"
            ),
        )


remote_workspace_artifact_service = RemoteWorkspaceArtifactService()
