# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""What a generating agent sends when it writes into a wiki version.

Only the write side is left. The project and generation schemas served the legacy
wiki's REST API, which is gone; a code wiki is a knowledge base, so it is read
through the knowledge schemas like any other.
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ========== Content Schemas ==========
class WikiContentSection(BaseModel):
    """Wiki content section for write API"""

    type: str
    title: str
    content: str
    parent_id: Optional[int] = None
    ext: Optional[Dict[str, Any]] = None
    # Stable identity of the page, e.g. "architecture/backend". Pages are matched on
    # it rather than on the title, so that rewording a heading revises the existing
    # page instead of replacing it — which would change the document id the RAG index
    # and stored citations depend on. Optional only for the legacy write path.
    path: Optional[str] = None


class WikiContentSummary(BaseModel):
    """Wiki content write summary"""

    status: Optional[Literal["COMPLETED", "FAILED"]] = None
    error_message: Optional[str] = None
    model: Optional[str] = None
    tokens_used: Optional[int] = None
    structure_order: Optional[List[str]] = None
    # Commit the agent actually documented. It read the working tree, whereas the
    # trigger only knew what it was told, and this is the value the next run's mode
    # decision compares against — so a wrong one here costs a needless full rebuild
    # or, worse, a skipped set of changes.
    head_commit: Optional[str] = None


class WikiPageRead(BaseModel):
    """One page of a version, as the agent reads it back."""

    path: str
    title: str
    content: str


class WikiContentWriteRequest(BaseModel):
    """Request payload for writing wiki contents"""

    generation_id: int
    sections: List[WikiContentSection]
    summary: Optional[WikiContentSummary] = None
    # Pages the agent is declaring gone. Only it knows which page covered a module
    # that no longer exists, and an incremental version starts as a copy of the
    # published one, so not writing a page cannot mean removing it.
    removed_paths: List[str] = Field(default_factory=list)
