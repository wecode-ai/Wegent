# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Search API endpoint
"""

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.unified_search import SearchResponse, SortType
from app.services.unified_search import unified_search_service

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("", response_model=SearchResponse)
def unified_search(
    q: str = Query(..., min_length=1, description="Search keyword"),
    types: Optional[str] = Query(
        None,
        description="Content types to search (comma-separated: chat,code,knowledge,teams)",
    ),
    sort: SortType = Query(SortType.RELEVANCE, description="Sort order"),
    date_from: Optional[datetime] = Query(None, description="Start date filter (ISO 8601)"),
    date_to: Optional[datetime] = Query(None, description="End date filter (ISO 8601)"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Unified search across all content types.

    Search for conversations (chat/code), knowledge base, and teams.

    - **q**: Search keyword (required)
    - **types**: Content types to search (comma-separated), defaults to all types
    - **sort**: Sort order (relevance, date, date_asc)
    - **date_from**: Filter results from this date
    - **date_to**: Filter results until this date
    - **page**: Page number for pagination
    - **limit**: Number of results per page
    """
    # Parse types parameter
    type_list = None
    if types:
        type_list = [t.strip() for t in types.split(",") if t.strip()]

    return unified_search_service.search(
        db=db,
        user_id=current_user.id,
        keyword=q,
        types=type_list,
        sort=sort,
        date_from=date_from,
        date_to=date_to,
        page=page,
        limit=limit,
    )
