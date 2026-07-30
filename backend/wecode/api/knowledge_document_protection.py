# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal company knowledge document protection API and registration."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.attachment.action_authorizer import (
    AttachmentActionContext,
    register_attachment_action_authorizer,
)
from app.services.knowledge import KnowledgeService
from wecode.service.knowledge.document_protection_policy import (
    is_protected_attachment,
    is_protected_knowledge_base,
)
from wecode.service.knowledge.watermark_identity import resolve_watermark_identity

logger = logging.getLogger(__name__)
router = APIRouter()


class WatermarkIdentityResponse(BaseModel):
    display_name: str
    employee_id: str


class DocumentProtectionResponse(BaseModel):
    protected: bool
    watermark_required: bool
    copy_allowed: bool
    product_download_allowed: bool
    preview_mode: str
    watermark: WatermarkIdentityResponse | None = None


async def authorize_company_document_action(
    context: AttachmentActionContext,
) -> None:
    if not is_protected_attachment(context.db, context.attachment_id):
        return
    logger.info(
        "Protected document export denied: attachment_id=%s user_id=%s action=%s",
        context.attachment_id,
        context.user_id,
        context.action.value,
    )
    raise HTTPException(
        status_code=403,
        detail={"code": "ORGANIZATION_KB_EXPORT_FORBIDDEN"},
    )


register_attachment_action_authorizer(authorize_company_document_action)


@router.get(
    "/knowledge-bases/{knowledge_base_id}/document-protection",
    response_model=DocumentProtectionResponse,
)
def get_document_protection(
    knowledge_base_id: int,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DocumentProtectionResponse:
    _, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=knowledge_base_id,
        user_id=current_user.id,
    )
    if not has_access:
        raise HTTPException(status_code=404, detail="Knowledge base not found")

    response.headers["Cache-Control"] = "private, no-store"
    if not is_protected_knowledge_base(db, knowledge_base_id):
        return DocumentProtectionResponse(
            protected=False,
            watermark_required=False,
            copy_allowed=True,
            product_download_allowed=True,
            preview_mode="default",
        )

    identity = resolve_watermark_identity(current_user, db)
    return DocumentProtectionResponse(
        protected=True,
        watermark_required=True,
        copy_allowed=False,
        product_download_allowed=False,
        preview_mode="protected",
        watermark=WatermarkIdentityResponse(
            display_name=identity.display_name,
            employee_id=identity.employee_id,
        ),
    )
