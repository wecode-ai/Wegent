# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Search API schemas
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SearchType(str, Enum):
    """Search content types"""

    CHAT = "chat"
    CODE = "code"
    KNOWLEDGE = "knowledge"
    TEAMS = "teams"


class SortType(str, Enum):
    """Sort types"""

    RELEVANCE = "relevance"
    DATE = "date"
    DATE_ASC = "date_asc"


class SearchHighlight(BaseModel):
    """Highlight matching information"""

    title: Optional[List[str]] = None
    content: Optional[List[str]] = None


class SearchResultItem(BaseModel):
    """Single search result item"""

    id: str
    type: SearchType
    title: str
    snippet: str = ""
    highlight: SearchHighlight = Field(default_factory=SearchHighlight)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SearchFacets(BaseModel):
    """Result counts by type"""

    chat: int = 0
    code: int = 0
    knowledge: int = 0
    teams: int = 0


class SearchResponse(BaseModel):
    """Unified search response"""

    total: int
    items: List[SearchResultItem]
    facets: SearchFacets
