# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-facing API endpoints for browsing and instantiating templates."""

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.template import (
    TemplateInstantiateResponse,
    TemplateListResponse,
    TemplateResponse,
)
from app.services.template_service import template_service

router = APIRouter()


@router.get("", response_model=TemplateListResponse)
def list_templates(
    category: Optional[str] = Query(None, description="Filter by template category"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List available templates."""
    return template_service.list_templates(db, category=category)


@router.get("/{template_id}", response_model=TemplateResponse)
def get_template(
    template_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get template details."""
    return template_service.get_template(db, template_id)


@router.post("/{template_id}/instantiate", response_model=TemplateInstantiateResponse)
def instantiate_template(
    template_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Instantiate a template to create all related resources."""
    return template_service.instantiate_template(db, current_user.id, template_id)
