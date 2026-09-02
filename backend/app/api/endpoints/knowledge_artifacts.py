# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge Artifact REST endpoints."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TypeVar

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core import security
from app.models.user import User
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactCreate,
    KnowledgeArtifactListResponse,
    KnowledgeArtifactUpdate,
)
from app.services.knowledge.artifact_repository import (
    ArtifactStorageError,
    KnowledgeArtifactRepository,
)
from app.services.knowledge.artifact_service import (
    ArtifactNotFoundError,
    ArtifactPermissionError,
    ArtifactService,
    ArtifactValidationError,
    PreparedArtifactLaunch,
)
from app.services.knowledge.artifact_task_launcher import (
    ArtifactTaskConfigurationError,
    ArtifactTaskLauncher,
    ArtifactTaskLaunchResult,
)
from app.services.knowledge.web_db import run_knowledge_db_phase
from shared.telemetry.decorators import trace_async

router = APIRouter()
logger = logging.getLogger(__name__)
T = TypeVar("T")


def _service(db: Session, user: User) -> ArtifactService:
    return ArtifactService(db, user, KnowledgeArtifactRepository(db))


def _service_for_user_id(db: Session, user_id: int) -> ArtifactService:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Could not validate credentials")
    return _service(db, user)


def _prepare_create(
    db: Session,
    user_id: int,
    knowledge_base_id: int,
    request: KnowledgeArtifactCreate,
) -> PreparedArtifactLaunch:
    return _service_for_user_id(db, user_id).prepare_create(
        knowledge_base_id,
        request,
    )


def _prepare_retry(
    db: Session,
    user_id: int,
    knowledge_base_id: int,
    artifact_id: str,
) -> PreparedArtifactLaunch:
    return _service_for_user_id(db, user_id).prepare_retry(
        knowledge_base_id,
        artifact_id,
    )


def _finish_launch(
    db: Session,
    user_id: int,
    prepared: PreparedArtifactLaunch,
    launch: ArtifactTaskLaunchResult,
) -> KnowledgeArtifact:
    return _service_for_user_id(db, user_id).finish_launch(prepared, launch)


def _fail_launch(
    db: Session,
    user_id: int,
    prepared: PreparedArtifactLaunch,
    error_message: str,
) -> None:
    _service_for_user_id(db, user_id).fail_launch(prepared, error_message)


def _list_artifacts(
    db: Session,
    user_id: int,
    knowledge_base_id: int,
) -> KnowledgeArtifactListResponse:
    return _service_for_user_id(db, user_id).list_sync(knowledge_base_id)


def _get_artifact(
    db: Session,
    user_id: int,
    knowledge_base_id: int,
    artifact_id: str,
) -> KnowledgeArtifact:
    return _service_for_user_id(db, user_id).get_sync(
        knowledge_base_id,
        artifact_id,
    )


def _rename_artifact(
    db: Session,
    user_id: int,
    knowledge_base_id: int,
    artifact_id: str,
    title: str,
) -> KnowledgeArtifact:
    return _service_for_user_id(db, user_id).rename_sync(
        knowledge_base_id,
        artifact_id,
        title,
    )


def _delete_artifact(
    db: Session,
    user_id: int,
    knowledge_base_id: int,
    artifact_id: str,
) -> None:
    _service_for_user_id(db, user_id).delete_sync(
        knowledge_base_id,
        artifact_id,
    )


async def _launch_prepared_artifact(
    user_id: int,
    prepared: PreparedArtifactLaunch,
) -> KnowledgeArtifact:
    try:
        launch = await ArtifactTaskLauncher.launch_prepared(prepared.task)
    except BaseException as exc:
        error_message = (
            "Artifact launch cancelled"
            if isinstance(exc, asyncio.CancelledError)
            else str(exc) or "Failed to start artifact generation"
        )
        await run_knowledge_db_phase(
            _fail_launch,
            user_id,
            prepared,
            error_message,
        )
        raise
    return await run_knowledge_db_phase(
        _finish_launch,
        user_id,
        prepared,
        launch,
    )


async def _execute(operation: Callable[[], Awaitable[T]]) -> T:
    try:
        return await operation()
    except ArtifactNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ArtifactPermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ArtifactValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ArtifactStorageError, ArtifactTaskConfigurationError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.exception("Unexpected runtime failure while handling knowledge Artifact")
        raise HTTPException(
            status_code=503,
            detail="Artifact generation is unavailable",
        ) from exc


@router.post(
    "/{knowledge_base_id}/artifacts",
    response_model=KnowledgeArtifact,
    status_code=status.HTTP_201_CREATED,
)
@trace_async("create_artifact", "knowledge.artifact.api")
async def create_artifact(
    knowledge_base_id: int,
    request: KnowledgeArtifactCreate,
    current_user: security.DetachedUser = Depends(security.get_detached_current_user),
) -> KnowledgeArtifact:
    """Create and launch one knowledge Artifact."""

    async def operation() -> KnowledgeArtifact:
        prepared = await run_knowledge_db_phase(
            _prepare_create,
            current_user.id,
            knowledge_base_id,
            request,
        )
        return await _launch_prepared_artifact(current_user.id, prepared)

    return await _execute(operation)


@router.get(
    "/{knowledge_base_id}/artifacts",
    response_model=KnowledgeArtifactListResponse,
)
@trace_async("list_artifacts", "knowledge.artifact.api")
async def list_artifacts(
    knowledge_base_id: int,
    current_user: security.DetachedUser = Depends(security.get_detached_current_user),
) -> KnowledgeArtifactListResponse:
    """List recent Artifacts for a knowledge base."""
    return await _execute(
        lambda: run_knowledge_db_phase(
            _list_artifacts,
            current_user.id,
            knowledge_base_id,
        )
    )


@router.get(
    "/{knowledge_base_id}/artifacts/{artifact_id}",
    response_model=KnowledgeArtifact,
)
@trace_async("get_artifact", "knowledge.artifact.api")
async def get_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    current_user: security.DetachedUser = Depends(security.get_detached_current_user),
) -> KnowledgeArtifact:
    """Get one Artifact."""
    return await _execute(
        lambda: run_knowledge_db_phase(
            _get_artifact,
            current_user.id,
            knowledge_base_id,
            artifact_id,
        )
    )


@router.patch(
    "/{knowledge_base_id}/artifacts/{artifact_id}",
    response_model=KnowledgeArtifact,
)
@trace_async("rename_artifact", "knowledge.artifact.api")
async def rename_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    request: KnowledgeArtifactUpdate,
    current_user: security.DetachedUser = Depends(security.get_detached_current_user),
) -> KnowledgeArtifact:
    """Rename one Artifact."""
    return await _execute(
        lambda: run_knowledge_db_phase(
            _rename_artifact,
            current_user.id,
            knowledge_base_id,
            artifact_id,
            request.title,
        )
    )


@router.post(
    "/{knowledge_base_id}/artifacts/{artifact_id}/retry",
    response_model=KnowledgeArtifact,
)
@trace_async("retry_artifact", "knowledge.artifact.api")
async def retry_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    current_user: security.DetachedUser = Depends(security.get_detached_current_user),
) -> KnowledgeArtifact:
    """Retry one failed Artifact."""

    async def operation() -> KnowledgeArtifact:
        prepared = await run_knowledge_db_phase(
            _prepare_retry,
            current_user.id,
            knowledge_base_id,
            artifact_id,
        )
        return await _launch_prepared_artifact(current_user.id, prepared)

    return await _execute(operation)


@router.delete(
    "/{knowledge_base_id}/artifacts/{artifact_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
@trace_async("delete_artifact", "knowledge.artifact.api")
async def delete_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    current_user: security.DetachedUser = Depends(security.get_detached_current_user),
) -> Response:
    """Delete one Artifact record."""
    await _execute(
        lambda: run_knowledge_db_phase(
            _delete_artifact,
            current_user.id,
            knowledge_base_id,
            artifact_id,
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
