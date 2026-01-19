# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for task knowledge bases (group chat) binding management.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.knowledge import TaskKnowledgeBaseService

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
    )

    return UnbindKnowledgeBaseResponse(
        message="Knowledge base unbound successfully",
        kb_name=kb_name,
        kb_namespace=kb_namespace,
    )
