# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge Artifact REST endpoints."""

from collections.abc import Awaitable, Callable
from typing import TypeVar

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
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
    RedisArtifactRepository,
)
from app.services.knowledge.artifact_service import (
    ArtifactNotFoundError,
    ArtifactPermissionError,
    ArtifactService,
    ArtifactValidationError,
)
from app.services.knowledge.artifact_task_launcher import (
    ArtifactTaskConfigurationError,
)

router = APIRouter()
T = TypeVar("T")


def _service(db: Session, user: User) -> ArtifactService:
    return ArtifactService(db, user, RedisArtifactRepository())


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
        raise HTTPException(
            status_code=503,
            detail="Artifact generation is unavailable",
        ) from exc


@router.post(
    "/{knowledge_base_id}/artifacts",
    response_model=KnowledgeArtifact,
    status_code=status.HTTP_201_CREATED,
)
async def create_artifact(
    knowledge_base_id: int,
    request: KnowledgeArtifactCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> KnowledgeArtifact:
    """Create and launch one knowledge Artifact."""
    service = _service(db, current_user)
    return await _execute(lambda: service.create(knowledge_base_id, request))


@router.get(
    "/{knowledge_base_id}/artifacts",
    response_model=KnowledgeArtifactListResponse,
)
async def list_artifacts(
    knowledge_base_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> KnowledgeArtifactListResponse:
    """List recent Artifacts for a knowledge base."""
    service = _service(db, current_user)
    return await _execute(lambda: service.list(knowledge_base_id))


@router.get(
    "/{knowledge_base_id}/artifacts/{artifact_id}",
    response_model=KnowledgeArtifact,
)
async def get_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> KnowledgeArtifact:
    """Get one Artifact."""
    service = _service(db, current_user)
    return await _execute(lambda: service.get(knowledge_base_id, artifact_id))


@router.patch(
    "/{knowledge_base_id}/artifacts/{artifact_id}",
    response_model=KnowledgeArtifact,
)
async def rename_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    request: KnowledgeArtifactUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> KnowledgeArtifact:
    """Rename one Artifact."""
    service = _service(db, current_user)
    return await _execute(
        lambda: service.rename(knowledge_base_id, artifact_id, request.title)
    )


@router.post(
    "/{knowledge_base_id}/artifacts/{artifact_id}/retry",
    response_model=KnowledgeArtifact,
)
async def retry_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> KnowledgeArtifact:
    """Retry one failed Artifact."""
    service = _service(db, current_user)
    return await _execute(lambda: service.retry(knowledge_base_id, artifact_id))


@router.delete(
    "/{knowledge_base_id}/artifacts/{artifact_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_artifact(
    knowledge_base_id: int,
    artifact_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Delete one Artifact record."""
    service = _service(db, current_user)
    await _execute(lambda: service.delete(knowledge_base_id, artifact_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
