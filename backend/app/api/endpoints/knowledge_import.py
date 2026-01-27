# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
External import endpoints for knowledge base documents.
"""

import logging
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.security import AuthContext
from app.schemas.knowledge import (
    DocumentSourceType,
    KnowledgeDocumentCreate,
    KnowledgeDocumentResponse,
)
from app.schemas.knowledge_import import (
    ExternalKnowledgeImportRequest,
    ExternalKnowledgeImportResponse,
)
from app.services.attachment.parser import DocumentParseError
from app.services.context import context_service
from app.services.knowledge import KnowledgeService
from app.services.knowledge.document_indexing import schedule_document_indexing

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_import_filename(title: Optional[str]) -> str:
    """Build a safe filename for imported content."""
    base_name = (title or "").strip()
    if not base_name:
        base_name = f"external-import-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"

    base_name = re.sub(r"[\\/:*?\"<>|]+", "-", base_name)
    base_name = re.sub(r"\s+", " ", base_name).strip()
    if len(base_name) > 200:
        base_name = base_name[:200].rstrip()

    if not base_name.endswith(".md"):
        base_name = f"{base_name}.md"
    return base_name


def _build_source_config(
    data: ExternalKnowledgeImportRequest, api_key_name: Optional[str]
) -> dict:
    """Build source configuration payload for imported documents."""
    source_config = {
        "source": data.source,
        "source_url": data.source_url,
        "external_id": data.external_id,
        "author": data.author,
        "tags": data.tags,
        "metadata": data.metadata,
        "imported_at": datetime.utcnow().isoformat(),
        "api_key_name": api_key_name,
    }
    return {key: value for key, value in source_config.items() if value is not None}


@router.post(
    "/{knowledge_base_id}/external-imports",
    response_model=ExternalKnowledgeImportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def import_external_content(
    knowledge_base_id: int,
    data: ExternalKnowledgeImportRequest,
    background_tasks: BackgroundTasks,
    auth_context: AuthContext = Depends(security.get_auth_context),
    db: Session = Depends(get_db),
) -> ExternalKnowledgeImportResponse:
    """Import external text content into a knowledge base."""
    user = auth_context.user
    filename = _build_import_filename(data.title)
    content_bytes = data.content.encode("utf-8")
    file_extension = filename.rsplit(".", 1)[-1]

    try:
        attachment, truncation_info = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=filename,
            binary_data=content_bytes,
        )
    except (ValueError, DocumentParseError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Failed to upload attachment for external import")
        raise HTTPException(status_code=500, detail="Failed to store attachment") from e

    doc_data = KnowledgeDocumentCreate(
        attachment_id=attachment.id,
        name=filename,
        file_extension=file_extension,
        file_size=len(content_bytes),
        splitter_config=data.splitter_config,
        source_type=DocumentSourceType.TEXT,
        source_config=_build_source_config(data, auth_context.api_key_name),
    )

    try:
        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
            data=doc_data,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    knowledge_base = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=knowledge_base_id,
        user_id=user.id,
    )

    index_scheduled = False
    if knowledge_base:
        index_scheduled = schedule_document_indexing(
            background_tasks=background_tasks,
            knowledge_base=knowledge_base,
            attachment_id=attachment.id,
            document_id=document.id,
            current_user_id=user.id,
            current_user_name=user.user_name,
            source_type=DocumentSourceType.TEXT,
            splitter_config=data.splitter_config,
        )

    return ExternalKnowledgeImportResponse(
        knowledge_base_id=knowledge_base_id,
        attachment_id=attachment.id,
        index_scheduled=index_scheduled,
        truncation_info=truncation_info,
        document=KnowledgeDocumentResponse.model_validate(document),
    )
