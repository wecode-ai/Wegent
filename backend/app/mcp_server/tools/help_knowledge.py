# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query-only MCP tools for the built-in Wegent Help knowledge base."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.system_knowledge_init import DEFAULT_SEED_ID, SYSTEM_SOURCE
from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import build_mcp_tools_dict, mcp_tool
from app.mcp_server.tools.knowledge_utils import (
    build_search_sources,
    get_user_from_task_token,
)
from app.models.kind import Kind
from app.services.knowledge.orchestrator import knowledge_orchestrator

logger = logging.getLogger(__name__)

HELP_KNOWLEDGE_NAMESPACE = "system"
HELP_KNOWLEDGE_DISPLAY_NAME = "Wegent Help"
HELP_QUERY_DEFAULT_MAX_RESULTS = 8
HELP_QUERY_MAX_RESULTS = 20


def _kind_labels(kind: Kind) -> dict[str, Any]:
    metadata = (kind.json or {}).get("metadata") or {}
    labels = metadata.get("labels") or {}
    return labels if isinstance(labels, dict) else {}


def _kind_spec(kind: Kind) -> dict[str, Any]:
    spec = (kind.json or {}).get("spec") or {}
    return spec if isinstance(spec, dict) else {}


def _is_help_knowledge_base(kind: Kind) -> bool:
    labels = _kind_labels(kind)
    if (
        labels.get("source") == SYSTEM_SOURCE
        and labels.get("seed_id") == DEFAULT_SEED_ID
    ):
        return True
    return _kind_spec(kind).get("name") == HELP_KNOWLEDGE_DISPLAY_NAME


def _find_help_knowledge_base(db: Session) -> Kind | None:
    candidates = (
        db.query(Kind)
        .filter(
            Kind.kind == "KnowledgeBase",
            Kind.namespace == HELP_KNOWLEDGE_NAMESPACE,
            Kind.is_active == True,
        )
        .all()
    )
    for knowledge_base in candidates:
        if _is_help_knowledge_base(knowledge_base):
            return knowledge_base
    return None


def _normalize_max_results(max_results: int) -> int:
    if max_results < 1:
        return HELP_QUERY_DEFAULT_MAX_RESULTS
    return min(max_results, HELP_QUERY_MAX_RESULTS)


@mcp_tool(
    name="wegent_help_query",
    description=(
        "Search the built-in Wegent Help knowledge base. This read-only tool "
        "always queries the system help documentation and does not manage user "
        "knowledge bases or documents."
    ),
    server="help_knowledge",
    param_descriptions={
        "query": "The user's Wegent help question.",
        "max_results": "Maximum number of relevant chunks to return.",
    },
)
async def query_wegent_help(
    token_info: TaskTokenInfo,
    query: str,
    max_results: int = HELP_QUERY_DEFAULT_MAX_RESULTS,
) -> dict[str, Any]:
    """Search the seeded Wegent Help knowledge base with RAG retrieval."""
    normalized_query = (query or "").strip()
    if not normalized_query:
        return {
            "error": "query is required",
            "query": query,
            "chunks": [],
            "sources": [],
            "total": 0,
        }

    db = SessionLocal()
    try:
        user = get_user_from_task_token(db, token_info)
        if not user:
            return {
                "error": "User not found",
                "query": normalized_query,
                "chunks": [],
                "sources": [],
                "total": 0,
            }

        knowledge_base = _find_help_knowledge_base(db)
        if knowledge_base is None:
            return {
                "error": "Built-in Wegent Help knowledge base is not initialized",
                "query": normalized_query,
                "chunks": [],
                "sources": [],
                "total": 0,
            }

        result = await knowledge_orchestrator.retrieve_knowledge(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base.id,
            query=normalized_query,
            max_results=_normalize_max_results(max_results),
            route_mode="rag_retrieval",
        )
        chunks = result.get("records", [])

        return {
            "query": result.get("query", normalized_query),
            "knowledge_base_id": knowledge_base.id,
            "knowledge_base_name": _kind_spec(knowledge_base).get(
                "name", HELP_KNOWLEDGE_DISPLAY_NAME
            ),
            "chunks": chunks,
            "sources": build_search_sources(chunks),
            "total": result.get("total", 0),
            "mode": result.get("mode", "rag_retrieval"),
        }

    except ValueError as exc:
        logger.warning("[MCP:HelpKnowledge] query validation error: %s", exc)
        return {
            "error": str(exc),
            "query": normalized_query,
            "chunks": [],
            "sources": [],
            "total": 0,
        }
    except Exception as exc:
        logger.error("[MCP:HelpKnowledge] query error: %s", exc, exc_info=True)
        return {
            "error": str(exc),
            "query": normalized_query,
            "chunks": [],
            "sources": [],
            "total": 0,
        }
    finally:
        db.close()


HELP_KNOWLEDGE_MCP_TOOLS = build_mcp_tools_dict(server="help_knowledge")
