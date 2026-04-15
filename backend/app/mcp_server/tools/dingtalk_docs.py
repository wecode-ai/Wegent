# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Document MCP tools for knowledge base integration.

This module provides MCP tool implementations for adding DingTalk documents
to Wegent knowledge bases. The tools coordinate with sandbox execution to:
1. Download DingTalk document content
2. Save with proper naming convention ({title}_{timestamp}.md)
3. Upload as attachment
4. Create knowledge base document

These tools are registered with the MCP server and exposed to AI agents.
"""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import build_mcp_tools_dict, mcp_tool
from app.mcp_server.tools.knowledge import _get_user_from_token
from app.services.dingtalk.docs_service import dingtalk_docs_service
from app.services.knowledge.orchestrator import knowledge_orchestrator

logger = logging.getLogger(__name__)


@mcp_tool(
    name="get_dingtalk_document_info",
    description="Get information about a DingTalk document from its URL.",
    server="knowledge",
    param_descriptions={
        "doc_url": "DingTalk document URL (e.g., https://alidocs.dingtalk.com/i/nodes/xxx)",
    },
)
async def get_dingtalk_document_info(
    token_info: TaskTokenInfo,
    doc_url: str,
) -> Dict[str, Any]:
    """
    Get DingTalk document information including title and modification time.

    Args:
        token_info: Task token information containing user context
        doc_url: DingTalk document URL

    Returns:
        Dict with document info:
        - doc_id: Document ID
        - title: Document title
        - modified_time: ISO format modification time
        - modified_time_formatted: YYYYMMDDHHMMSS format for filename
        - content_type: Content type
        - url: Original URL
    """
    try:
        # Get user preferences for MCP config
        db = SessionLocal()
        try:
            user = _get_user_from_token(db, token_info)
            user_preferences = user.preferences if user else None
        finally:
            db.close()

        doc_info = await dingtalk_docs_service.get_document_info(
            doc_url, user_preferences=user_preferences
        )
        return {
            "success": True,
            "doc_id": doc_info["doc_id"],
            "title": doc_info["title"],
            "modified_time": doc_info["modified_time"],
            "modified_time_formatted": doc_info["modified_time_formatted"],
            "content_type": doc_info["content_type"],
            "url": doc_info["url"],
        }
    except ValueError as e:
        logger.warning(f"[MCP] get_dingtalk_document_info validation error: {e}")
        return {"success": False, "error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] get_dingtalk_document_info error: {e}", exc_info=True)
        return {"success": False, "error": f"Failed to get document info: {e}"}


@mcp_tool(
    name="add_dingtalk_doc_to_knowledge",
    description="Add a DingTalk document to Wegent knowledge base. Downloads the document, saves it with naming convention {title}_{timestamp}.md, and creates a knowledge base document.",
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Target knowledge base ID",
        "doc_url": "DingTalk document URL",
        "doc_title": "Document title (optional, will be fetched from DingTalk if not provided)",
        "doc_content": "Document content (optional, will be downloaded from DingTalk if not provided)",
        "modified_time": "Document modification time in YYYYMMDDHHMMSS format (optional)",
        "trigger_indexing": "Whether to trigger RAG indexing (default: True)",
        "trigger_summary": "Whether to trigger summary generation (default: True)",
    },
)
async def add_dingtalk_doc_to_knowledge(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    doc_url: str,
    doc_title: Optional[str] = None,
    doc_content: Optional[str] = None,
    modified_time: Optional[str] = None,
    trigger_indexing: bool = True,
    trigger_summary: bool = True,
) -> Dict[str, Any]:
    """
    Add a DingTalk document to Wegent knowledge base.

    This tool creates a knowledge base document from a DingTalk document.
    The document can be provided directly via parameters or fetched from DingTalk.

    File naming convention: {title}_{modified_time}.md
    Example: 产品需求文档_20260413170933.md

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Target knowledge base ID
        doc_url: DingTalk document URL (for reference and metadata)
        doc_title: Document title (optional)
        doc_content: Document content (optional, markdown format preferred)
        modified_time: Modification time in YYYYMMDDHHMMSS format (optional)
        trigger_indexing: Whether to trigger RAG indexing
        trigger_summary: Whether to trigger summary generation

    Returns:
        Dict with operation result:
        - success: Whether the operation succeeded
        - document_id: Created document ID
        - document_name: Document name
        - message: Status message
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"success": False, "error": "User not found"}

        # If content not provided, fetch from DingTalk
        if not doc_content:
            logger.info(
                f"[MCP] Content not provided, fetching from DingTalk: {doc_url}"
            )
            try:
                # Get user preferences for MCP config
                user_preferences = user.preferences if user else None
                doc_download = await dingtalk_docs_service.download_document_content(
                    doc_url, user_preferences=user_preferences
                )
                doc_content = doc_download.get("content", "")
                # Use fetched title if not provided
                if not doc_title:
                    doc_title = doc_download.get("title", "DingTalk Document")
                # Use fetched modified_time if not provided
                if not modified_time:
                    modified_time = doc_download.get("modified_time_formatted")
            except Exception as e:
                logger.error(f"[MCP] Failed to fetch document from DingTalk: {e}")
                return {
                    "success": False,
                    "error": f"Failed to fetch document from DingTalk: {e}",
                }

        if not doc_content:
            return {
                "success": False,
                "error": "Failed to get document content from DingTalk",
            }

        # Use provided title or extract from URL
        title = doc_title or "DingTalk Document"

        # Use provided modified_time or generate current time
        if modified_time:
            # Validate format - support both YYYYMMDDHHMMSS (14 digits) and Unix timestamp in ms (13 digits)
            if not modified_time.isdigit() or len(modified_time) not in (13, 14):
                logger.warning(
                    f"Invalid modified_time format: {modified_time}, using current time"
                )
                from datetime import datetime

                modified_time = datetime.now().strftime("%Y%m%d%H%M%S")
        else:
            from datetime import datetime

            modified_time = datetime.now().strftime("%Y%m%d%H%M%S")

        # Build filename according to naming convention
        filename = dingtalk_docs_service.build_filename(title, modified_time)

        logger.info(
            f"[MCP] Adding DingTalk doc to KB {knowledge_base_id}: "
            f"title='{title}', filename='{filename}'"
        )

        # Create document with text content (run in thread to avoid blocking)
        # The content is expected to be markdown from DingTalk
        import asyncio

        result = await asyncio.to_thread(
            knowledge_orchestrator.create_document_with_content,
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            name=title,
            source_type="text",
            content=doc_content,
            trigger_indexing=trigger_indexing,
            trigger_summary=trigger_summary,
        )

        return {
            "success": True,
            "document_id": result.id,
            "document_name": result.name,
            "filename": filename,
            "message": f"Document '{title}' added to knowledge base successfully",
        }

    except ValueError as e:
        logger.warning(f"[MCP] add_dingtalk_doc_to_knowledge validation error: {e}")
        return {"success": False, "error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] add_dingtalk_doc_to_knowledge error: {e}", exc_info=True)
        return {"success": False, "error": f"Failed to add document: {e}"}
    finally:
        db.close()


@mcp_tool(
    name="add_dingtalk_doc_with_attachment",
    description="Add a DingTalk document to knowledge base using an existing attachment. This is used after the skill uploads the document as an attachment.",
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Target knowledge base ID",
        "doc_title": "Document title",
        "attachment_id": "Existing attachment ID from upload_attachment tool",
        "trigger_indexing": "Whether to trigger RAG indexing (default: True)",
        "trigger_summary": "Whether to trigger summary generation (default: True)",
    },
)
def add_dingtalk_doc_with_attachment(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    doc_title: str,
    attachment_id: int,
    trigger_indexing: bool = True,
    trigger_summary: bool = True,
) -> Dict[str, Any]:
    """
    Add a DingTalk document to knowledge base using an existing attachment.

    This tool is designed to work with the dingtalk-connector skill which:
    1. Downloads the DingTalk document in sandbox
    2. Saves it as {title}_{timestamp}.md
    3. Uploads it as an attachment
    4. Calls this tool to create the knowledge base document

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Target knowledge base ID
        doc_title: Document title
        attachment_id: Attachment ID from upload_attachment tool
        trigger_indexing: Whether to trigger RAG indexing
        trigger_summary: Whether to trigger summary generation

    Returns:
        Dict with operation result
    """
    db = SessionLocal()
    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"success": False, "error": "User not found"}

        logger.info(
            f"[MCP] Adding DingTalk doc with attachment to KB {knowledge_base_id}: "
            f"title='{doc_title}', attachment_id={attachment_id}"
        )

        # Create document with attachment reference
        result = knowledge_orchestrator.create_document_with_content(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            name=doc_title,
            source_type="attachment",
            attachment_id=attachment_id,
            trigger_indexing=trigger_indexing,
            trigger_summary=trigger_summary,
        )

        return {
            "success": True,
            "document_id": result.id,
            "document_name": result.name,
            "attachment_id": attachment_id,
            "message": f"Document '{doc_title}' added to knowledge base successfully",
        }

    except ValueError as e:
        logger.warning(f"[MCP] add_dingtalk_doc_with_attachment validation error: {e}")
        return {"success": False, "error": str(e)}
    except Exception as e:
        logger.error(
            f"[MCP] add_dingtalk_doc_with_attachment error: {e}", exc_info=True
        )
        return {"success": False, "error": f"Failed to add document: {e}"}
    finally:
        db.close()


# Build tool registry from decorated functions
DINGTALK_DOCS_MCP_TOOLS = build_mcp_tools_dict(server="knowledge")
