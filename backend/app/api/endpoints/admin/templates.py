# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin API endpoints for template management."""

from fastapi import APIRouter, Depends, Path
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.template import TemplateCreate, TemplateResponse, TemplateUpdate
from app.services.template_service import template_service

router = APIRouter(prefix="/templates")


@router.post("", response_model=TemplateResponse, status_code=201)
def create_template(
    data: TemplateCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """Create a new template (admin only)."""
    return template_service.create_template(db, data)


@router.put("/{template_id}", response_model=TemplateResponse)
def update_template(
    data: TemplateUpdate,
    template_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """Update an existing template (admin only)."""
    return template_service.update_template(db, template_id, data)


@router.delete("/{template_id}")
def delete_template(
    template_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """Delete a template (admin only)."""
    template_service.delete_template(db, template_id)
    return {"message": "Template deleted successfully"}
