# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP tools for Knowledge Base retrieval operations.

This module provides read-only MCP tools for querying knowledge bases,
equivalent to the LangChain tools used by chat_shell but exposed via MCP
for use by executor agents (ClaudeCode, Agno).

Tools:
- knowledge_base_search: RAG vector/hybrid search
- kb_ls: List documents in a knowledge base
- kb_head: Read document content with offset/limit pagination

These tools are registered with server="kb_retrieval" and use the
@mcp_tool decorator for automatic registration.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import build_mcp_tools_dict, mcp_tool

logger = logging.getLogger(__name__)

# Constants for document reading pagination
DEFAULT_READ_DOC_LIMIT = 50_000  # Default characters to return
MAX_READ_DOC_LIMIT = 500_000  # Maximum characters allowed per request


@mcp_tool(
    name="knowledge_base_search",
    description=(
        "Search a knowledge base using RAG (vector/hybrid) retrieval. "
        "Returns the most relevant text chunks matching the query. "
        "Use this tool when you need to find specific information in the knowledge base."
    ),
    server="kb_retrieval",
    param_descriptions={
        "query": "Search query text describing the information you need",
        "kb_id": "Knowledge base ID to search in",
        "max_results": "Maximum number of results to return (default: 5)",
    },
)
def knowledge_base_search(
    token_info: TaskTokenInfo,
    query: str,
    kb_id: int,
    max_results: int = 5,
) -> Dict[str, Any]:
    """
    Search a knowledge base using RAG retrieval.

    Args:
        token_info: Task token information (auto-injected)
        query: Search query text
        kb_id: Knowledge base ID
        max_results: Maximum results to return

    Returns:
        Dict with search results containing content, score, and title
    """
    db = SessionLocal()
    try:
        from app.services.rag.retrieval_service import RetrievalService

        retrieval_service = RetrievalService()

        # Run async retrieval in event loop
        result = asyncio.get_event_loop().run_until_complete(
            retrieval_service.retrieve_from_knowledge_base_internal(
                query=query,
                knowledge_base_id=kb_id,
                db=db,
                user_name=token_info.user_name,
            )
        )

        records = result.get("records", [])
        total_before_limit = len(records)
        records = records[:max_results]

        total_content_chars = sum(len(r.get("content", "")) for r in records)

        logger.info(
            "[MCP:KBRetrieval] knowledge_base_search: kb_id=%d, query='%s', "
            "results=%d/%d, content_size=%d chars",
            kb_id,
            query[:50],
            len(records),
            total_before_limit,
            total_content_chars,
        )

        return {
            "results": [
                {
                    "content": r.get("content", ""),
                    "score": r.get("score", 0.0),
                    "title": r.get("title", "Unknown"),
                }
                for r in records
            ],
            "total": len(records),
            "query": query,
        }

    except Exception as e:
        logger.error(
            "[MCP:KBRetrieval] knowledge_base_search error: %s", e, exc_info=True
        )
        return {"error": str(e), "results": [], "total": 0}

    finally:
        db.close()


@mcp_tool(
    name="kb_ls",
    description=(
        "List all documents in a knowledge base with metadata and summaries. "
        "Returns document names, sizes, types, and short summaries. "
        "Use this to explore what content is available before reading specific documents."
    ),
    server="kb_retrieval",
    param_descriptions={
        "kb_id": "Knowledge base ID to list documents from",
    },
)
def kb_ls(
    token_info: TaskTokenInfo,
    kb_id: int,
) -> Dict[str, Any]:
    """
    List all documents in a knowledge base.

    Args:
        token_info: Task token information (auto-injected)
        kb_id: Knowledge base ID

    Returns:
        Dict with document list including names, sizes, and summaries
    """
    db = SessionLocal()
    try:
        from app.models.knowledge import KnowledgeDocument

        # Query documents directly (permission validated at task level)
        documents = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.kind_id == kb_id)
            .order_by(KnowledgeDocument.created_at.desc())
            .all()
        )

        doc_items: List[Dict[str, Any]] = []
        for doc in documents:
            short_summary = None
            if doc.summary and isinstance(doc.summary, dict):
                short_summary = doc.summary.get("short_summary")

            doc_items.append(
                {
                    "id": doc.id,
                    "name": doc.name,
                    "file_extension": doc.file_extension or "",
                    "file_size": doc.file_size or 0,
                    "short_summary": short_summary,
                    "is_active": doc.is_active,
                }
            )

        logger.info(
            "[MCP:KBRetrieval] kb_ls: kb_id=%d, documents=%d",
            kb_id,
            len(doc_items),
        )

        return {
            "documents": doc_items,
            "total": len(doc_items),
        }

    except Exception as e:
        logger.error("[MCP:KBRetrieval] kb_ls error: %s", e, exc_info=True)
        return {"error": str(e), "documents": [], "total": 0}

    finally:
        db.close()


@mcp_tool(
    name="kb_head",
    description=(
        "Read document content from a knowledge base with offset/limit pagination. "
        "Similar to 'head' command. Returns partial content starting from offset position. "
        "Use has_more flag to check if more content exists. "
        "Use this to read specific documents identified by kb_ls."
    ),
    server="kb_retrieval",
    param_descriptions={
        "document_id": "Document ID to read (from kb_ls results)",
        "offset": "Start position in characters (default: 0)",
        "limit": "Maximum characters to return (default: 50000, max: 500000)",
    },
)
def kb_head(
    token_info: TaskTokenInfo,
    document_id: int,
    offset: int = 0,
    limit: int = DEFAULT_READ_DOC_LIMIT,
) -> Dict[str, Any]:
    """
    Read document content with offset/limit pagination.

    Args:
        token_info: Task token information (auto-injected)
        document_id: Document ID to read
        offset: Start position in characters
        limit: Maximum characters to return

    Returns:
        Dict with document content, pagination info, and has_more flag
    """
    db = SessionLocal()
    try:
        from app.models.knowledge import KnowledgeDocument
        from app.services.context import context_service

        # Clamp limit to max
        limit = min(limit, MAX_READ_DOC_LIMIT)

        # Get document
        document = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )

        if not document:
            return {"error": f"Document {document_id} not found"}

        # Read content from attachment
        content = ""
        total_length = 0
        actual_start = 0

        if document.attachment_id:
            attachment = context_service.get_context_optional(
                db=db,
                context_id=document.attachment_id,
            )
            if attachment and attachment.extracted_text:
                full_content = attachment.extracted_text
                total_length = len(full_content)

                # Apply offset and limit, clamp start to total_length
                actual_start = min(offset, total_length)
                end = min(actual_start + limit, total_length)
                content = full_content[actual_start:end]

        returned_length = len(content)
        has_more = (actual_start + returned_length) < total_length

        logger.info(
            "[MCP:KBRetrieval] kb_head: doc_id=%d, offset=%d, returned=%d/%d, has_more=%s",
            document_id,
            actual_start,
            returned_length,
            total_length,
            has_more,
        )

        return {
            "document_id": document.id,
            "name": document.name,
            "content": content,
            "total_length": total_length,
            "offset": actual_start,
            "returned_length": returned_length,
            "has_more": has_more,
            "kb_id": document.kind_id,
        }

    except Exception as e:
        logger.error("[MCP:KBRetrieval] kb_head error: %s", e, exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()


# Build tool registry from decorated functions
KB_RETRIEVAL_MCP_TOOLS = build_mcp_tools_dict(server="kb_retrieval")
