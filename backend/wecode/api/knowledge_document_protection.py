# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal company knowledge document protection API."""

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.knowledge import KnowledgeService
from wecode.service.knowledge.document_protection_policy import (
    is_protected_knowledge_base,
)
from wecode.service.knowledge.watermark_identity import resolve_watermark_identity

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
