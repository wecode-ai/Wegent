# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for task knowledge bases (group chat) binding management.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.external_knowledge import ExternalKnowledgeRef
from app.schemas.kind import ContextWarning
from app.services.chat.external_knowledge_refs import (
    build_external_ref_canonical_key,
    extract_task_external_knowledge_refs,
    filter_valid_external_knowledge_refs,
    lock_task_for_knowledge_update,
    remove_task_external_knowledge_ref,
    replace_task_context_warnings,
    sync_task_external_knowledge_refs,
)
from app.services.chat.knowledge_binding_resolver import KnowledgeBindingResolver
from app.services.knowledge import TaskKnowledgeBaseService
from app.services.rag.sources import ExternalRefValidationError
from app.stores.tasks import task_access_store

router = APIRouter()
logger = logging.getLogger(__name__)

# Create service instance
task_kb_service = TaskKnowledgeBaseService()


# ============ Request/Response Schemas ============


class BindKnowledgeBaseRequest(BaseModel):
    """Request to bind a knowledge base to a task"""

    kb_name: str
    kb_namespace: str = "default"


class BoundKnowledgeBaseResponse(BaseModel):
    """Response for a bound knowledge base"""

    id: int
    name: str
    namespace: str
    display_name: str
    description: Optional[str] = None
    document_count: int
    bound_by: str
    bound_at: str
    scope_restricted: bool = False
    document_ids: List[int] = Field(default_factory=list)
    folder_ids: List[int] = Field(default_factory=list)
    include_subfolders: bool = True


class BoundKnowledgeBaseListResponse(BaseModel):
    """Response for list of bound knowledge bases"""

    items: List[BoundKnowledgeBaseResponse]
    total: int
    max_limit: int = 10


class UnbindKnowledgeBaseResponse(BaseModel):
    """Response for unbinding a knowledge base"""

    message: str
    kb_name: str
    kb_namespace: str


class BoundExternalKnowledgeRefListResponse(BaseModel):
    """Response for task-level external knowledge refs."""

    items: List[ExternalKnowledgeRef]
    total: int
    context_warnings: List[ContextWarning] = Field(default_factory=list)


class RemoveExternalKnowledgeRefRequest(BaseModel):
    """Request to remove one task-level external knowledge ref."""

    ref: ExternalKnowledgeRef


class BindExternalKnowledgeRefsRequest(BaseModel):
    """Request to bind external knowledge refs to a task."""

    refs: List[ExternalKnowledgeRef]


class RemoveExternalKnowledgeRefResponse(BaseModel):
    """Response for removing one external knowledge ref."""

    message: str
    items: List[ExternalKnowledgeRef]
    total: int


class BindExternalKnowledgeRefsResponse(BaseModel):
    """Response for binding external knowledge refs."""

    message: str
    items: List[ExternalKnowledgeRef]
    total: int


def _get_accessible_task_or_404(db: Session, task_id: int, user_id: int):
    """Return an active task if the user owns or can access it."""
    if not task_access_store.is_member(db, task_id=task_id, user_id=user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    task = task_access_store.get_task(db, task_id=task_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    return task


# ============ API Endpoints ============


@router.get(
    "/{task_id}/knowledge-bases",
    response_model=BoundKnowledgeBaseListResponse,
)
def get_bound_knowledge_bases(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get knowledge bases bound to a group chat task.
    User must be a member of the task to view.
    """
    bound_kbs = task_kb_service.get_bound_knowledge_bases(db, task_id, current_user.id)

    return BoundKnowledgeBaseListResponse(
        items=[
            BoundKnowledgeBaseResponse(
                id=kb.id,
                name=kb.name,
                namespace=kb.namespace,
                display_name=kb.display_name,
                description=kb.description,
                document_count=kb.document_count,
                bound_by=kb.bound_by,
                bound_at=kb.bound_at,
                scope_restricted=kb.scope_restricted,
                document_ids=kb.document_ids,
                folder_ids=kb.folder_ids,
                include_subfolders=kb.include_subfolders,
            )
            for kb in bound_kbs
        ],
        total=len(bound_kbs),
        max_limit=task_kb_service.MAX_BOUND_KNOWLEDGE_BASES,
    )


@router.post(
    "/{task_id}/knowledge-bases",
    response_model=BoundKnowledgeBaseResponse,
)
def bind_knowledge_base(
    task_id: int,
    request: BindKnowledgeBaseRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Bind a knowledge base to a group chat task.
    User must be a member and have access to the knowledge base.
    """
    bound_kb = task_kb_service.bind_knowledge_base(
        db=db,
        task_id=task_id,
        kb_name=request.kb_name,
        kb_namespace=request.kb_namespace,
        user_id=current_user.id,
    )

    return BoundKnowledgeBaseResponse(
        id=bound_kb.id,
        name=bound_kb.name,
        namespace=bound_kb.namespace,
        display_name=bound_kb.display_name,
        description=bound_kb.description,
        document_count=bound_kb.document_count,
        bound_by=bound_kb.bound_by,
        bound_at=bound_kb.bound_at,
    )


@router.delete(
    "/{task_id}/knowledge-bases/{kb_name}",
    response_model=UnbindKnowledgeBaseResponse,
)
def unbind_knowledge_base(
    task_id: int,
    kb_name: str,
    kb_namespace: str = "default",
    kb_id: Optional[int] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Unbind a knowledge base from a group chat task.
    User must be a member of the task.
    """
    task_kb_service.unbind_knowledge_base(
        db=db,
        task_id=task_id,
        kb_name=kb_name,
        kb_namespace=kb_namespace,
        user_id=current_user.id,
        kb_id=kb_id,
    )

    return UnbindKnowledgeBaseResponse(
        message="Knowledge base unbound successfully",
        kb_name=kb_name,
        kb_namespace=kb_namespace,
    )


@router.get(
    "/{task_id}/external-knowledge-refs",
    response_model=BoundExternalKnowledgeRefListResponse,
)
def get_bound_external_knowledge_refs(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get external knowledge refs bound to a task.
    User must have access to the task to view.
    """
    task = _get_accessible_task_or_404(db, task_id, current_user.id)
    refs = extract_task_external_knowledge_refs(task)
    spec = (task.json or {}).get("spec") or {}
    return BoundExternalKnowledgeRefListResponse(
        items=refs,
        total=len(refs),
        context_warnings=spec.get("contextWarnings") or [],
    )


@router.post(
    "/{task_id}/external-knowledge-refs",
    response_model=BindExternalKnowledgeRefsResponse,
)
def bind_external_knowledge_refs(
    task_id: int,
    request: BindExternalKnowledgeRefsRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Bind external knowledge refs to a task.
    User must have access to the task; persistent refs are gated by Team owner.
    """
    task = _get_accessible_task_or_404(db, task_id, current_user.id)
    task = lock_task_for_knowledge_update(db, task)
    raw_refs = [ref.model_dump(exclude_none=True) for ref in request.refs]
    sender_refs, sender_warnings = filter_valid_external_knowledge_refs(
        raw_refs,
        binding_level="conversation",
        actor_user_id=current_user.id,
    )
    actor = KnowledgeBindingResolver(db).resolve_task_owner_user(task=task)
    if actor is None:
        warnings = sender_warnings + [
            {
                "type": "external_knowledge",
                "reason": "actor_not_found",
                "message": "Task knowledge owner is no longer available.",
                "metadata": {"canonicalKey": build_external_ref_canonical_key(ref)},
            }
            for ref in raw_refs
        ]
        replace_task_context_warnings(
            db,
            task,
            canonical_keys={build_external_ref_canonical_key(ref) for ref in raw_refs},
            warnings=warnings,
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Task knowledge owner is no longer available",
        )
    valid_refs, owner_warnings = filter_valid_external_knowledge_refs(
        sender_refs,
        binding_level="conversation",
        actor_user_id=actor.id,
    )
    warnings = sender_warnings + owner_warnings
    replace_task_context_warnings(
        db,
        task,
        canonical_keys={build_external_ref_canonical_key(ref) for ref in raw_refs},
        warnings=warnings,
    )
    if not valid_refs:
        # Keep the warning visible even though the binding request is rejected.
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No selected external knowledge refs are available for the current user",
        )

    try:
        refs = sync_task_external_knowledge_refs(
            db,
            task,
            valid_refs,
        )
        db.commit()
    except ExternalRefValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception:
        db.rollback()
        raise

    return BindExternalKnowledgeRefsResponse(
        message="External knowledge refs bound successfully",
        items=refs,
        total=len(refs),
    )


@router.post(
    "/{task_id}/external-knowledge-refs/remove",
    response_model=RemoveExternalKnowledgeRefResponse,
)
def remove_bound_external_knowledge_ref(
    task_id: int,
    request: RemoveExternalKnowledgeRefRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove one external knowledge ref from a task-level binding.
    User must have access to the task to modify bindings.
    """
    task = _get_accessible_task_or_404(db, task_id, current_user.id)
    try:
        refs = remove_task_external_knowledge_ref(
            db,
            task,
            request.ref.model_dump(exclude_none=True),
        )
        db.commit()
    except ExternalRefValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception:
        db.rollback()
        raise

    return RemoveExternalKnowledgeRefResponse(
        message="External knowledge ref removed successfully",
        items=refs,
        total=len(refs),
    )
