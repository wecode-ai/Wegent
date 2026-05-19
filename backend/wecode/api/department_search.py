# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Department search API for ERP department authorization.

Provides an endpoint to search departments via the ERP OpenSearch API v2,
used by the frontend department auth section when adding org_department members.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from wecode.service.dept_visibility import filter_hidden_for_user
from wecode.service.erp_client import erp_client

logger = logging.getLogger(__name__)
router = APIRouter()

_MAX_QUERY_LEN = 100


@router.get("/search")
def search_departments(
    q: str = Query(
        ...,
        min_length=1,
        max_length=_MAX_QUERY_LEN,
        description="Search keyword for department name",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search departments by keyword via ERP OpenSearch API.

    Args:
        q: Search keyword (e.g., department name or partial name, max 100 chars)
        db: Database session
        current_user: Current authenticated user

    Returns:
        List of matching departments with id, name, label
    """
    # Pydantic Query validation already enforces length, but double-check for
    # callers that bypass the framework boundary (e.g. direct function calls
    # in tests).
    if len(q) > _MAX_QUERY_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Search query too long (max {_MAX_QUERY_LEN} chars)",
        )
    results = erp_client.search_departments(q)
    results = filter_hidden_for_user(current_user.user_name, results)
    return {"departments": results}
