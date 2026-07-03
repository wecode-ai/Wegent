# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base transfer API endpoints."""

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.knowledge_document_side_effects import (
    schedule_kb_summary_updates_after_deletion,
)
from app.core import security
from app.core.exceptions import CustomHTTPException, StructuredValidationException
from app.models.user import User
from app.schemas.knowledge import (
    BatchDocumentMoveRequest,
    BatchOperationResult,
    KnowledgeBaseMigrateRequest,
    KnowledgeBaseMigrateResponse,
    TransferDocumentsRequest,
    TransferDocumentsResponse,
)
from app.services.knowledge import KnowledgeFolderService, KnowledgeService
from app.services.knowledge.knowledge_transfer import KB_MIGRATE_CONFLICT
from shared.telemetry.decorators import (
    add_span_event,
    trace_sync,
)

logger = logging.getLogger(__name__)

router = APIRouter()
document_router = APIRouter()


@document_router.post("/batch/move", response_model=BatchOperationResult)
@trace_sync("batch_move_documents", "knowledge.api")
def batch_move_documents(
    data: BatchDocumentMoveRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch move multiple documents to a target folder.

    Moves all specified documents that the user has permission to move.
    Returns a summary of successful and failed operations.
    Raises 400 for invalid folder_id, 404 for not found documents, 403 for permission issues.
    """
    result = KnowledgeFolderService.batch_move_documents(
        db=db,
        document_ids=data.document_ids,
        folder_id=data.folder_id,
        user_id=current_user.id,
    )
    add_span_event(
        "knowledge.documents.batch_moved",
        {
            "success_count": str(result.success_count),
            "failed_count": str(result.failed_count),
            "user_id": str(current_user.id),
        },
    )

    if result.success_count == 0 and result.failed_count > 0:
        error_msg = result.message.lower() if result.message else ""
        if "not found" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=result.message,
            )
        if "permission" in error_msg or "access denied" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=result.message,
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.message,
        )

    return result


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
    except CustomHTTPException:
        raise
    except IntegrityError as e:
        db.rollback()
        raise CustomHTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A knowledge base with this name already exists in the target group",
            error_code=KB_MIGRATE_CONFLICT,
        ) from e
    except SQLAlchemyError as e:
        db.rollback()
        raise CustomHTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Database error during migration: {str(e)}",
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
            schedule_kb_summary_updates_after_deletion(
                background_tasks,
                kb_ids=[knowledge_base_id, data.target_kb_id],
                user_id=current_user.id,
                user_name=current_user.user_name,
            )
        return result
    except (CustomHTTPException, StructuredValidationException):
        raise
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Database error during document transfer")
        raise CustomHTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Database error during transfer",
        )
