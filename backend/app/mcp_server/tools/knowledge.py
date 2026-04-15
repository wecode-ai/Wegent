# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Independent MCP tools for Knowledge Base operations.

This module provides MCP tool implementations that use the KnowledgeOrchestrator
service layer, supporting complete business workflows with Celery-based async
task scheduling.

These tools are registered with the MCP server and exposed to AI agents for
managing knowledge bases and documents.

Tools are declared using @mcp_tool decorator which provides:
- Automatic parameter schema extraction
- token_info auto-injection from MCP context
- Custom name/description support
- Parameter filtering (token_info is hidden from MCP schema)
"""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import build_mcp_tools_dict, mcp_tool
from app.models.user import User
from app.services.knowledge.orchestrator import (
    MAX_DOCUMENT_READ_LIMIT,
    knowledge_orchestrator,
)

logger = logging.getLogger(__name__)


def _get_user_from_token(db: Session, token_info: TaskTokenInfo) -> Optional[User]:
    """Get user from token info."""
    return db.query(User).filter(User.id == token_info.user_id).first()


@mcp_tool(
    name="search_knowledge_base",
    description="Search documents in a knowledge base using RAG retrieval. Returns relevant chunks with source references. The knowledge base must have a retriever configured.",
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Knowledge base ID to search",
        "query": "Search query text",
        "max_results": "Maximum number of results to return (default: 10, max: 50)",
        "document_ids": "Optional list of document IDs to restrict search scope",
    },
)
async def search_knowledge_base(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    query: str,
    max_results: int = 10,
    document_ids: Optional[list[int]] = None,
) -> Dict[str, Any]:
    """
    Search knowledge base using RAG retrieval.

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Knowledge base ID to search
        query: Search query text
        max_results: Maximum number of results (default: 10, max: 50)
        document_ids: Optional document IDs to filter search scope

    Returns:
        Dict with search results including chunks and sources
    """

    # Validate knowledge_base_id is a positive integer
    if not isinstance(knowledge_base_id, int) or knowledge_base_id <= 0:
        return {
            "error": f"Invalid knowledge_base_id: {knowledge_base_id}. Must be a positive integer.",
            "query": query,
            "chunks": [],
            "sources": [],
            "total": 0,
        }

    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {
                "error": "User not found",
                "query": query,
                "chunks": [],
                "sources": [],
                "total": 0,
            }

        result = await knowledge_orchestrator.retrieve_knowledge(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            query=query,
            max_results=max_results,
            document_ids=document_ids,
            route_mode="rag_retrieval",
        )

        # Convert retrieve_knowledge format to MCP expected format
        # retrieve_knowledge returns: records, total, mode, query, knowledge_base_id, total_estimated_tokens
        # MCP expects: chunks, sources, total, mode, query
        chunks = result.get("records", [])

        # Build sources from chunks
        sources = []
        seen_docs = set()
        for chunk in chunks:
            doc_key = (chunk.get("knowledge_base_id"), chunk.get("document_id"))
            if doc_key not in seen_docs:
                seen_docs.add(doc_key)
                sources.append(
                    {
                        "document_id": chunk.get("document_id"),
                        "document_name": chunk.get("document_name", "Unknown"),
                        "knowledge_base_id": chunk.get("knowledge_base_id"),
                        "knowledge_base_name": chunk.get(
                            "knowledge_base_name", "Unknown"
                        ),
                    }
                )

        return {
            "query": result.get("query", query),
            "chunks": chunks,
            "sources": sources,
            "total": result.get("total", 0),
            "mode": result.get("mode", "rag_retrieval"),
        }

    except ValueError as e:
        logger.warning(f"[MCP] search_knowledge_base validation error: {e}")
        return {
            "error": str(e),
            "query": query,
            "chunks": [],
            "sources": [],
            "total": 0,
        }

    except Exception as e:
        logger.error(f"[MCP] search_knowledge_base error: {e}", exc_info=True)
        return {
            "error": str(e),
            "query": query,
            "chunks": [],
            "sources": [],
            "total": 0,
        }

    finally:
        db.close()


@mcp_tool(
    name="list_knowledge_bases",
    description="List all knowledge bases accessible to the current user.",
    server="knowledge",
    param_descriptions={
        "scope": "Resource scope - 'all', 'personal', or 'group'",
        "group_name": "Group name (required when scope='group')",
    },
)
def list_knowledge_bases(
    token_info: TaskTokenInfo,
    scope: str = "all",
    group_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    List all knowledge bases accessible to the current user.

    Args:
        token_info: Task token information containing user context
        scope: Resource scope - "all", "personal", or "group"
        group_name: Group name (required when scope="group")

    Returns:
        Dict with total count and list of knowledge bases
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found", "total": 0, "items": []}

        result = knowledge_orchestrator.list_knowledge_bases(
            db=db,
            user=user,
            scope=scope,
            group_name=group_name,
        )

        return {
            "total": result.total,
            "items": [item.model_dump() for item in result.items],
        }

    except Exception as e:
        logger.error(f"[MCP] list_knowledge_bases error: {e}", exc_info=True)
        return {"error": str(e), "total": 0, "items": []}

    finally:
        db.close()


@mcp_tool(
    name="list_documents",
    description="List all documents in a knowledge base.",
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Knowledge base ID to list documents from",
    },
)
def list_documents(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
) -> Dict[str, Any]:
    """
    List all documents in a knowledge base.

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Knowledge base ID

    Returns:
        Dict with total count and list of documents
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found", "total": 0, "items": []}

        result = knowledge_orchestrator.list_documents(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
        )

        return {
            "total": result.total,
            "items": [item.model_dump() for item in result.items],
        }

    except ValueError as e:
        logger.warning(f"[MCP] list_documents validation error: {e}")
        return {"error": str(e), "total": 0, "items": []}

    except Exception as e:
        logger.error(f"[MCP] list_documents error: {e}", exc_info=True)
        return {"error": str(e), "total": 0, "items": []}

    finally:
        db.close()


@mcp_tool(
    name="create_knowledge_base",
    description="Create a new knowledge base with auto-configuration for retriever, embedding, and summary model.",
    server="knowledge",
    param_descriptions={
        "name": "Knowledge base name",
        "description": "Optional description for the knowledge base",
        "namespace": "Namespace ('default' for personal, group name for group)",
        "kb_type": "Type of knowledge base ('notebook' or 'classic')",
        "summary_enabled": "Whether to enable summary generation",
    },
)
def create_knowledge_base(
    token_info: TaskTokenInfo,
    name: str,
    description: Optional[str] = None,
    namespace: str = "default",
    kb_type: str = "notebook",
    summary_enabled: bool = True,
) -> Dict[str, Any]:
    """
    Create a new knowledge base with auto-configuration.

    Configuration is automatically selected:
    - retriever: Auto-selects user's first available retriever (priority: user > public)
    - embedding: Auto-selects user's first available embedding model
    - summary_model: Uses the model from current task (via token_info.task_id)

    If no retriever or embedding model is available, the knowledge base will be
    created without RAG configuration.

    Args:
        token_info: Task token information containing user context
        name: Knowledge base name
        description: Optional description
        namespace: Namespace ("default" for personal, group name for group)
        kb_type: Type ("notebook" or "classic")
        summary_enabled: Enable summary generation

    Returns:
        Dict with created knowledge base information
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        result = knowledge_orchestrator.create_knowledge_base(
            db=db,
            user=user,
            name=name,
            description=description,
            namespace=namespace,
            kb_type=kb_type,
            summary_enabled=summary_enabled,
            task_id=token_info.task_id,  # For resolving summary model
        )

        return result.model_dump()

    except ValueError as e:
        logger.warning(f"[MCP] create_knowledge_base validation error: {e}")
        return {"error": str(e)}

    except Exception as e:
        logger.error(f"[MCP] create_knowledge_base error: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()


@mcp_tool(
    name="create_document",
    description=(
        "Create a document in a knowledge base. Supports text content, base64-encoded "
        "files, URL scraping, or existing attachment reference.\n\n"
        "IMPORTANT for inbox message processing: When the inbox context contains "
        "'contentAttachmentIds', ALWAYS use source_type='attachment' with one of those "
        "IDs instead of source_type='text'. This avoids re-outputting the full content "
        "through the model output window, which is critical for large documents.\n\n"
        "Example for inbox: create_document(knowledge_base_id=1, name='Article', "
        "source_type='attachment', attachment_id=<contentAttachmentIds[0]>)"
    ),
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Target knowledge base ID",
        "name": "Document name",
        "source_type": (
            "Source type: 'text', 'file', 'web', or 'attachment'. "
            "Use 'attachment' for inbox messages (see contentAttachmentIds in inbox context)."
        ),
        "content": "Text content (for source_type='text'). Avoid for large content - use 'attachment' instead.",
        "file_base64": "Base64-encoded file content (for source_type='file')",
        "file_extension": "File extension like 'txt', 'md', 'pdf' (for source_type='file')",
        "url": "URL to scrape (for source_type='web')",
        "attachment_id": (
            "Existing attachment context ID (for source_type='attachment'). "
            "For inbox messages: use a value from contentAttachmentIds in the inbox context. "
            "This is the PREFERRED method - content is read directly from storage without "
            "passing through the model output window."
        ),
        "trigger_indexing": "Whether to trigger RAG indexing (default: True)",
        "trigger_summary": "Whether to trigger summary generation (default: True)",
    },
)
def create_document(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    name: str,
    source_type: str,
    content: Optional[str] = None,
    file_base64: Optional[str] = None,
    file_extension: Optional[str] = None,
    url: Optional[str] = None,
    attachment_id: Optional[int] = None,
    trigger_indexing: bool = True,
    trigger_summary: bool = True,
) -> Dict[str, Any]:
    """
    Create a document in a knowledge base.

    Supports four input methods:
    - source_type="text": Direct text content via `content` parameter
    - source_type="file": Base64-encoded file via `file_base64` and `file_extension`
    - source_type="web": URL content scraping via `url` parameter
    - source_type="attachment": Copy existing attachment via `attachment_id` (recommended for large files)

    RAG indexing and summary generation are scheduled via Celery tasks
    and return immediately after document creation.

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Target knowledge base ID
        name: Document name
        source_type: Source type ("text", "file", "web", or "attachment")
        content: Text content (for source_type="text")
        file_base64: Base64-encoded file content (for source_type="file")
        file_extension: File extension (for source_type="file", e.g., "txt", "md", "pdf")
        url: URL to scrape (for source_type="web")
        attachment_id: Existing attachment ID (for source_type="attachment")
        trigger_indexing: Whether to trigger RAG indexing (default: True)
        trigger_summary: Whether to trigger summary generation (default: True)

    Returns:
        Dict with created document information
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        # Orchestrator now handles Celery scheduling internally
        result = knowledge_orchestrator.create_document_with_content(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            name=name,
            source_type=source_type,
            content=content,
            file_base64=file_base64,
            file_extension=file_extension,
            url=url,
            attachment_id=attachment_id,
            trigger_indexing=trigger_indexing,
            trigger_summary=trigger_summary,
        )

        return result.model_dump()

    except ValueError as e:
        logger.warning(f"[MCP] create_document validation error: {e}")
        return {"error": str(e)}

    except Exception as e:
        logger.error(f"[MCP] create_document error: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()


@mcp_tool(
    name="read_document_content",
    description="Read document content with offset/limit pagination.",
    server="knowledge",
    param_descriptions={
        "document_id": "Document ID to read",
        "offset": "Character offset to start reading from",
        "limit": "Maximum number of characters to return",
    },
)
def read_document_content(
    token_info: TaskTokenInfo,
    document_id: int,
    offset: int = 0,
    limit: int = MAX_DOCUMENT_READ_LIMIT,
) -> Dict[str, Any]:
    """
    Read raw document content with offset/limit pagination.

    Args:
        token_info: Task token information containing user context
        document_id: Document ID
        offset: Character offset to start reading from
        limit: Maximum number of characters to return (defaults to backend limit)

    Returns:
        Dict with document content slice and pagination metadata
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        result = knowledge_orchestrator.read_document_content(
            db=db,
            user=user,
            document_id=document_id,
            offset=offset,
            limit=limit,
        )

        return result.model_dump()

    except ValueError as e:
        logger.warning(f"[MCP] read_document_content validation error: {e}")
        return {"error": str(e)}

    except Exception as e:
        logger.error(f"[MCP] read_document_content error: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()


@mcp_tool(
    name="update_document_content",
    description="Update document content for text documents and editable plain-text files such as txt, md, and markdown.",
    server="knowledge",
    param_descriptions={
        "document_id": "Document ID to update",
        "content": "New content for the document",
        "trigger_reindex": "Whether to trigger RAG re-indexing (default: True)",
    },
)
def update_document_content(
    token_info: TaskTokenInfo,
    document_id: int,
    content: str,
    trigger_reindex: bool = True,
) -> Dict[str, Any]:
    """
    Update document content.

    Supports text documents and editable plain-text file documents such as
    txt, md, and markdown. Binary file documents are not editable through
    this tool. Re-indexing is scheduled via Celery if trigger_reindex=True.

    Args:
        token_info: Task token information containing user context
        document_id: Document ID
        content: New content
        trigger_reindex: Whether to trigger RAG re-indexing (default: True)

    Returns:
        Dict with update status
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        # Orchestrator now handles Celery scheduling internally
        result = knowledge_orchestrator.update_document_content(
            db=db,
            user=user,
            document_id=document_id,
            content=content,
            trigger_reindex=trigger_reindex,
        )

        return result

    except ValueError as e:
        logger.warning(f"[MCP] update_document_content validation error: {e}")
        return {"error": str(e)}

    except Exception as e:
        logger.error(f"[MCP] update_document_content error: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()


# Build tool registry from decorated functions
# This maintains backward compatibility with the manual dict approach
KNOWLEDGE_MCP_TOOLS = build_mcp_tools_dict(server="knowledge")
