# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base transfer API endpoints."""

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.knowledge import _update_kb_summary_after_deletion
from app.core import security
from app.core.exceptions import StructuredValidationException
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeBaseMigrateRequest,
    KnowledgeBaseMigrateResponse,
    TransferDocumentsRequest,
    TransferDocumentsResponse,
)
from app.services.knowledge import KnowledgeService
from shared.telemetry.decorators import (
    add_span_event,
    capture_trace_context,
    trace_sync,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post(
    "/{knowledge_base_id}/migrate",
    response_model=KnowledgeBaseMigrateResponse,
)
@trace_sync("migrate_knowledge_base_to_group", "knowledge.api")
def migrate_knowledge_base_to_group(
    knowledge_base_id: int,
    data: KnowledgeBaseMigrateRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Migrate a personal knowledge base to a group.

    - Only personal knowledge bases (namespace='default') can be migrated
    - Only the creator of the knowledge base can migrate it
    - User must have Maintainer or Owner permission in the target group
    - Target group name must be a valid group namespace
    """
    try:
        result = KnowledgeService.migrate_knowledge_base_to_group(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
            target_group_name=data.target_group_name,
        )
        add_span_event(
            "knowledge.base.migrated",
            {
                "kb_id": str(knowledge_base_id),
                "user_id": str(current_user.id),
                "target_group": data.target_group_name,
            },
        )
        return result
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A knowledge base with this name already exists in the target group",
        ) from e
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Database error during migration: {str(e)}",
        ) from e
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.post(
    "/{knowledge_base_id}/transfer-documents",
    response_model=TransferDocumentsResponse,
)
@trace_sync("transfer_documents_to_kb", "knowledge.api")
def transfer_documents_to_kb(
    knowledge_base_id: int,
    data: TransferDocumentsRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Transfer documents and/or folders to another personal knowledge base.

    - Only personal KBs (namespace='default') can be the target
    - User must have write access to both source and target KBs
    - Folder structure is preserved in the target KB
    - Documents' index_status is reset to 'not_indexed'
    - RAG index is cleaned up from the source KB
    """
    try:
        result = KnowledgeService.transfer_documents_to_kb(
            db=db,
            source_kb_id=knowledge_base_id,
            target_kb_id=data.target_kb_id,
            document_ids=data.document_ids,
            folder_ids=data.folder_ids,
            user_id=current_user.id,
        )
        add_span_event(
            "knowledge.transfer.completed",
            {
                "source_kb_id": str(knowledge_base_id),
                "target_kb_id": str(data.target_kb_id),
                "document_count": str(result.transferred_document_count),
                "folder_count": str(result.transferred_folder_count),
                "user_id": str(current_user.id),
            },
        )
        if result.transferred_document_count > 0:
            trace_ctx = capture_trace_context()
            background_tasks.add_task(
                _update_kb_summary_after_deletion,
                kb_id=knowledge_base_id,
                user_id=current_user.id,
                user_name=current_user.user_name,
                trace_context=trace_ctx,
            )
            background_tasks.add_task(
                _update_kb_summary_after_deletion,
                kb_id=data.target_kb_id,
                user_id=current_user.id,
                user_name=current_user.user_name,
                trace_context=trace_ctx,
            )
        return result
    except StructuredValidationException as e:
        raise e
    except ValueError as e:
        error_msg = str(e)
        error_lower = error_msg.lower()
        if "not found" in error_lower:
            status_code = status.HTTP_404_NOT_FOUND
        elif "permission" in error_lower or "access denied" in error_lower:
            status_code = status.HTTP_403_FORBIDDEN
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(
            status_code=status_code,
            detail=error_msg,
        )
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Database error during document transfer")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Database error during transfer",
        )
