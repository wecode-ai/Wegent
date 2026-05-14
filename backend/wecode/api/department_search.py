# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Department search API for ERP department authorization.

Provides an endpoint to search departments via the ERP OpenSearch API v2,
used by the frontend department auth section when adding org_department members.
"""

import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from wecode.service.dept_visibility import filter_hidden_for_user
from wecode.service.erp_client import erp_client

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/search")
def search_departments(
    q: str = Query(..., description="Search keyword for department name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search departments by keyword via ERP OpenSearch API.

    Args:
        q: Search keyword (e.g., department name or partial name)
        db: Database session
        current_user: Current authenticated user

    Returns:
        List of matching departments with id, name, label
    """
    results = erp_client.search_departments(q)
    results = filter_hidden_for_user(current_user.user_name, results)
    return {"departments": results}
