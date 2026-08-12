# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Department search API for ERP department authorization.

Provides an endpoint to search departments via the ERP OpenSearch API v2,
used by the frontend department auth section when adding org_department members.
"""

import logging
import re
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from wecode.service.dept_visibility import filter_hidden_for_user
from wecode.service.erp_client import DepartmentInfo, erp_client

logger = logging.getLogger(__name__)
router = APIRouter()

_MAX_QUERY_LEN = 100
# Department names are NFKC-normalized before matching, so full-width
# parentheses are converted to ASCII parentheses.
_DEPARTMENT_MARKER_PATTERN = re.compile(r"\(([^()]*)\)")
_OBSOLETE_DEPARTMENT_MARKERS = frozenset(
    {"失效", "无效", "旧", "old", "待失效", "待撤销"}
)


def _is_obsolete_department(department: DepartmentInfo) -> bool:
    """Return whether the displayed department name has an obsolete marker."""
    display_name = department.name or department.label
    if not display_name:
        return False

    normalized_name = unicodedata.normalize("NFKC", display_name).casefold()
    markers = _DEPARTMENT_MARKER_PATTERN.findall(normalized_name)
    return any(marker.strip() in _OBSOLETE_DEPARTMENT_MARKERS for marker in markers)


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
    results = [d for d in results if not _is_obsolete_department(d)]
    results = filter_hidden_for_user(current_user.user_name, results)
    # Drop departments with missing or empty ids to avoid React key-prop
    # warnings in the frontend dropdown that maps over this list.
    results = [d for d in results if d.id]
    # Deduplicate by id in case the ERP search API returns duplicates.
    seen: set[str] = set()
    unique_results = []
    for d in results:
        if d.id not in seen:
            seen.add(d.id)
            unique_results.append(d)
    return {"departments": unique_results}
