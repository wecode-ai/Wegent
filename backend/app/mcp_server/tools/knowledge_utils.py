# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for knowledge-related MCP tools."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.mcp_server.auth import TaskTokenInfo
from app.models.user import User


def get_user_from_task_token(db: Session, token_info: TaskTokenInfo) -> User | None:
    """Get the current user from task token information."""
    return db.query(User).filter(User.id == token_info.user_id).first()


def build_search_sources(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build unique source references from retrieval chunks."""
    sources: list[dict[str, Any]] = []
    seen_docs: set[tuple[Any, Any]] = set()
    for chunk in chunks:
        doc_key = (chunk.get("knowledge_base_id"), chunk.get("document_id"))
        if doc_key in seen_docs:
            continue
        seen_docs.add(doc_key)
        sources.append(
            {
                "document_id": chunk.get("document_id"),
                "document_name": chunk.get("document_name", "Unknown"),
                "knowledge_base_id": chunk.get("knowledge_base_id"),
                "knowledge_base_name": chunk.get("knowledge_base_name", "Unknown"),
            }
        )
    return sources
