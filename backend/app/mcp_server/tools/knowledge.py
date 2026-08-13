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

from app.core.config import settings
from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.server import EXTERNAL_KNOWLEDGE_MCP_MOUNT_PATH
from app.mcp_server.tools.decorator import build_mcp_tools_dict, mcp_tool
from app.models.user import User
from app.services.chat.task_default_knowledge_bases import (
    resolve_task_default_knowledge_base_read_user_id,
)
from app.services.knowledge import KnowledgeFolderService
from app.services.knowledge.external_document_access import (
    DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS,
    DOWNLOAD_TOKEN_HEADER,
    ExternalDocumentAccessError,
    create_document_download_token,
    get_document_access_or_raise,
    normalize_disposition,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.orchestrator import (
    DEFAULT_KNOWLEDGE_LIST_LIMIT,
    MAX_DOCUMENT_READ_LIMIT,
    MAX_KNOWLEDGE_LIST_LIMIT,
    knowledge_orchestrator,
)

logger = logging.getLogger(__name__)


def _get_user_from_token(db: Session, token_info: TaskTokenInfo) -> Optional[User]:
    """Get user from token info."""
    return db.query(User).filter(User.id == token_info.user_id).first()


def _document_file_url_path(document_id: int) -> str:
    """Build the relative source-file download path for a knowledge document."""
    api_prefix = (settings.API_PREFIX or "").rstrip("/")
    return (
        f"{api_prefix}{EXTERNAL_KNOWLEDGE_MCP_MOUNT_PATH}"
        f"/documents/{document_id}/file"
    )


def _shell_single_quote(value: str) -> str:
    """Quote a string for POSIX shell single-quoted contexts."""
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _safe_download_output_name(file_name: str) -> str:
    """Return a safe local output name for generated curl commands."""
    raw_name = str(file_name or "").replace("\x00", "").replace("\\", "/")
    base_name = raw_name.rsplit("/", 1)[-1].strip()
    if base_name in {"", ".", ".."}:
        return "document"

    safe_name = "".join(char if char >= " " else "_" for char in base_name)
    return safe_name or "document"


def _default_download_dir(*, task_id: int, subtask_id: int) -> str:
    """Return the executor-private default directory for knowledge source files."""
    return f"/home/user/{task_id}:executor:knowledge/{subtask_id}"


def _default_download_path(*, task_id: int, subtask_id: int, file_name: str) -> str:
    """Return the executor-private default path for a downloaded source file."""
    return (
        f"{_default_download_dir(task_id=task_id, subtask_id=subtask_id)}/"
        f"{_safe_download_output_name(file_name)}"
    )


def _build_download_command(
    *,
    resource_url: str,
    token: str,
    file_name: str,
    task_id: Optional[int] = None,
    subtask_id: Optional[int] = None,
) -> str:
    """Build a curl command template for local executors."""
    url_expr = (
        f'"${{TASK_API_DOMAIN%/}}{resource_url}"'
        if resource_url.startswith("/")
        else _shell_single_quote(resource_url)
    )
    header = _shell_single_quote(f"{DOWNLOAD_TOKEN_HEADER}: {token}")
    output_name = _shell_single_quote(_safe_download_output_name(file_name))
    if task_id is None or subtask_id is None:
        return f"curl -fL -H {header} {url_expr} -o {output_name}"

    default_dir = _shell_single_quote(
        _default_download_dir(task_id=task_id, subtask_id=subtask_id)
    )
    return (
        f"download_dir={default_dir}"
        ' && output_path="$download_dir"/'
        f"{output_name}"
        ' && mkdir -p "$download_dir"'
        f' && curl -fL -H {header} {url_expr} -o "$output_path"'
        " && printf '\\nDownloaded to %s\\n' \"$output_path\""
    )


def _build_download_command_notes() -> str:
    return (
        "If resource_url is relative, prefix it with TASK_API_DOMAIN. "
        "Use the returned headers exactly; the credential is short-lived. "
        "download_command saves the file under the executor-private /home/user "
        "directory so it does not appear in Wegent task files."
    )


def _get_read_user_for_knowledge_base(
    db: Session,
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
) -> Optional[User]:
    """Resolve direct user access or task-scoped agent default read access."""
    user = _get_user_from_token(db, token_info)
    if user is None:
        return None
    if KnowledgeService.can_directly_access_knowledge_base(
        db,
        knowledge_base_id,
        user.id,
    ):
        return user

    access_user_id = resolve_task_default_knowledge_base_read_user_id(
        db,
        token_info.task_id,
        user.id,
        knowledge_base_id,
    )
    if access_user_id is None:
        return user
    return (
        db.query(User)
        .filter(User.id == access_user_id, User.is_active.is_(True))
        .first()
    )


@mcp_tool(
    name="wegent_kb_search_knowledge_base",
    description="Search documents in a knowledge base using RAG retrieval. Returns relevant chunks with source references. The knowledge base must have a retriever configured.",
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Knowledge base ID to search",
        "query": "Search query text",
        "max_results": "Maximum number of results to return (default: 10, max: 50)",
        "document_ids": "Optional list of document IDs to restrict search scope",
        "folder_ids": "Optional list of folder IDs to restrict search scope",
        "include_subfolders": "Whether folder_ids include descendant folders",
    },
)
async def search_knowledge_base(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    query: str,
    max_results: int = 10,
    document_ids: Optional[list[int]] = None,
    folder_ids: Optional[list[int]] = None,
    include_subfolders: bool = True,
) -> Dict[str, Any]:
    """
    Search knowledge base using RAG retrieval.

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Knowledge base ID to search
        query: Search query text
        max_results: Maximum number of results (default: 10, max: 50)
        document_ids: Optional document IDs to filter search scope
        folder_ids: Optional folder IDs to filter search scope
        include_subfolders: Whether folder_ids include descendant folders

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
        user = _get_read_user_for_knowledge_base(db, token_info, knowledge_base_id)
        if not user:
            return {
                "error": "User not found",
                "query": query,
                "chunks": [],
                "sources": [],
                "total": 0,
            }

        scope_specified = folder_ids is not None or document_ids is not None
        resolved_document_ids = document_ids
        if scope_specified:
            resolved_document_ids = (
                KnowledgeFolderService.resolve_document_ids_for_scope(
                    db=db,
                    knowledge_base_id=knowledge_base_id,
                    user_id=user.id,
                    folder_ids=folder_ids,
                    document_ids=document_ids,
                    include_subfolders=include_subfolders,
                )
            )
            if not resolved_document_ids:
                return {
                    "query": query,
                    "chunks": [],
                    "sources": [],
                    "total": 0,
                    "mode": "rag_retrieval",
                }

        result = await knowledge_orchestrator.retrieve_knowledge(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            query=query,
            max_results=max_results,
            document_ids=resolved_document_ids if scope_specified else None,
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
    name="wegent_kb_list_knowledge_bases",
    description="List all knowledge bases accessible to the current user.",
    server="knowledge",
    param_descriptions={
        "scope": "Resource scope - 'all', 'personal', or 'group'",
        "group_name": "Group name (required when scope='group')",
        "limit": "Maximum number of knowledge bases to return",
        "offset": "Start offset for paginated listing",
    },
)
def list_knowledge_bases(
    token_info: TaskTokenInfo,
    scope: str = "all",
    group_name: Optional[str] = None,
    limit: int = DEFAULT_KNOWLEDGE_LIST_LIMIT,
    offset: int = 0,
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
        if limit < 1 or limit > MAX_KNOWLEDGE_LIST_LIMIT:
            return {
                "error": f"limit must be between 1 and {MAX_KNOWLEDGE_LIST_LIMIT}",
                "total": 0,
                "items": [],
            }
        if offset < 0:
            return {
                "error": "offset must be greater than or equal to 0",
                "total": 0,
                "items": [],
            }

        result = knowledge_orchestrator.list_knowledge_bases(
            db=db,
            user=user,
            scope=scope,
            group_name=group_name,
            limit=limit,
            offset=offset,
        )

        return {
            "total": result.total,
            "returned_count": result.returned_count,
            "limit": result.limit,
            "offset": result.offset,
            "has_more": result.has_more,
            "items": [item.model_dump() for item in result.items],
        }

    except Exception as e:
        logger.error(f"[MCP] list_knowledge_bases error: {e}", exc_info=True)
        return {"error": str(e), "total": 0, "items": []}

    finally:
        db.close()


@mcp_tool(
    name="wegent_kb_list_documents",
    description="List all documents in a knowledge base, optionally filtered by folder.",
    server="knowledge",
    param_descriptions={
        "knowledge_base_id": "Knowledge base ID to list documents from",
        "folder_id": "Optional folder ID to filter documents by (0 or omit for root/all documents)",
        "include_subfolders": (
            "Whether folder_id includes descendant folders (default: true)"
        ),
        "keyword": "Optional keyword to search document names",
        "sort_by": "Sort field: name, size, createdAt, or updatedAt",
        "sort_order": "Sort order: asc or desc",
        "limit": "Maximum number of documents to return",
        "offset": "Start offset for paginated listing",
    },
)
def list_documents(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    folder_id: Optional[int] = None,
    include_subfolders: bool = True,
    keyword: Optional[str] = None,
    sort_by: str = "createdAt",
    sort_order: str = "desc",
    limit: int = DEFAULT_KNOWLEDGE_LIST_LIMIT,
    offset: int = 0,
) -> Dict[str, Any]:
    """
    List all documents in a knowledge base.

    Args:
        token_info: Task token information containing user context
        knowledge_base_id: Knowledge base ID
        folder_id: Optional folder ID to filter documents by
        include_subfolders: Whether folder_id includes descendant folders
        keyword: Optional keyword to search document names
        sort_by: Sort field
        sort_order: Sort order

    Returns:
        Dict with total count and list of documents
    """
    db = SessionLocal()
    try:
        user = _get_read_user_for_knowledge_base(db, token_info, knowledge_base_id)
        if not user:
            return {"error": "User not found", "total": 0, "items": []}
        if limit < 1 or limit > MAX_KNOWLEDGE_LIST_LIMIT:
            return {
                "error": f"limit must be between 1 and {MAX_KNOWLEDGE_LIST_LIMIT}",
                "total": 0,
                "items": [],
            }
        if offset < 0:
            return {
                "error": "offset must be greater than or equal to 0",
                "total": 0,
                "items": [],
            }

        result = knowledge_orchestrator.list_documents(
            db=db,
            user=user,
            knowledge_base_id=knowledge_base_id,
            folder_id=folder_id,
            limit=limit,
            offset=offset,
            include_subfolders=include_subfolders,
            keyword=keyword,
            sort_by=sort_by,
            sort_order=sort_order,
        )

        return {
            "total": result.total,
            "returned_count": result.returned_count,
            "limit": result.limit,
            "offset": result.offset,
            "has_more": result.has_more,
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
    name="wegent_kb_create_knowledge_base",
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
    name="wegent_kb_create_document",
    description=(
        "Create a document in a knowledge base. Supports text content, base64-encoded "
        "files, URL scraping, or existing attachment reference.\n\n"
        "IMPORTANT for inbox message processing: When the inbox context contains "
        "'contentAttachmentIds', ALWAYS use source_type='attachment' with one of those "
        "IDs instead of source_type='text'. This avoids re-outputting the full content "
        "through the model output window, which is critical for large documents.\n\n"
        "Example for inbox: wegent_kb_create_document(knowledge_base_id=1, name='Article', "
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
        "folder_id": "Optional folder ID to place the document in (0 or omit for root folder)",
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
    folder_id: int = 0,
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
        folder_id: Optional folder ID to place the document in (0 means root folder)
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
            folder_id=folder_id,
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
    name="wegent_kb_read_document_content",
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
        from app.models.knowledge import KnowledgeDocument

        knowledge_base_id = (
            db.query(KnowledgeDocument.kind_id)
            .filter(KnowledgeDocument.id == document_id)
            .scalar()
        )
        user = (
            _get_read_user_for_knowledge_base(db, token_info, knowledge_base_id)
            if knowledge_base_id is not None
            else _get_user_from_token(db, token_info)
        )
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
    name="wegent_kb_get_document_download",
    description=(
        "Get a short-lived original source-file download credential for an "
        "accessible knowledge document. Use it when exact spreadsheet, binary "
        "file, or full-file analysis is needed instead of RAG snippets."
    ),
    server="knowledge",
    param_descriptions={
        "document_id": "Document ID to download",
        "disposition": "Download disposition: 'attachment' for saving the source file, or 'inline' for previewable files",
    },
)
def get_document_download(
    token_info: TaskTokenInfo,
    document_id: int,
    disposition: str = "attachment",
) -> Dict[str, Any]:
    """
    Return short-lived source-file download credentials for a document.

    Args:
        token_info: Task token information containing user context
        document_id: Document ID
        disposition: Content disposition ("attachment" or "inline")

    Returns:
        Dict with URL path, headers, metadata, and a curl command template
    """
    if not isinstance(document_id, int) or document_id <= 0:
        return {"error": "document_id must be a positive integer"}

    db = SessionLocal()
    try:
        from app.models.knowledge import KnowledgeDocument

        knowledge_base_id = (
            db.query(KnowledgeDocument.kind_id)
            .filter(KnowledgeDocument.id == document_id)
            .scalar()
        )
        user = (
            _get_read_user_for_knowledge_base(db, token_info, knowledge_base_id)
            if knowledge_base_id is not None
            else _get_user_from_token(db, token_info)
        )
        if not user:
            return {"error": "User not found"}

        normalized_disposition = normalize_disposition(disposition)
        access = get_document_access_or_raise(
            db,
            user_id=user.id,
            document_id=document_id,
        )
        if not access.downloadable:
            return {"error": "Document file is unavailable", "code": "file_unavailable"}
        if normalized_disposition == "inline" and not access.previewable:
            return {
                "error": "Document file is not previewable",
                "code": "unsupported_media_type",
            }

        token = create_document_download_token(
            user_id=user.id,
            document_id=document_id,
            disposition=normalized_disposition,
        )
        resource_url = _document_file_url_path(document_id)
        default_download_dir = _default_download_dir(
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
        )
        default_local_path = _default_download_path(
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            file_name=access.file_name,
        )
        return {
            "document_id": document_id,
            "node_id": f"document:{document_id}",
            "knowledge_base_id": access.knowledge_base_id,
            "resource_url": resource_url,
            "headers": {DOWNLOAD_TOKEN_HEADER: token},
            "expiration_seconds": DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS,
            "disposition": normalized_disposition,
            "mime_type": access.mime_type or "application/octet-stream",
            "file_name": access.file_name,
            "file_extension": access.file_extension,
            "file_size": access.file_size,
            "downloadable": access.downloadable,
            "previewable": access.previewable,
            "download_dir": default_download_dir,
            "local_path": default_local_path,
            "download_command": _build_download_command(
                resource_url=resource_url,
                token=token,
                file_name=access.file_name,
                task_id=token_info.task_id,
                subtask_id=token_info.subtask_id,
            ),
            "notes": _build_download_command_notes(),
        }
    except ExternalDocumentAccessError as e:
        logger.warning(f"[MCP] get_document_download validation error: {e}")
        return {"error": str(e), "code": e.code}
    except Exception as e:
        logger.error(f"[MCP] get_document_download error: {e}", exc_info=True)
        return {"error": str(e)}
    finally:
        db.close()


@mcp_tool(
    name="wegent_kb_update_document_content",
    description="Update document content for text documents and editable plain-text files such as code files, configs, and markup documents.",
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

    Supports text documents and editable plain-text file documents including
    code files (py, js, ts, java, go, etc.), configs (yaml, json, env), and
    markup documents (md, html, xml, etc.). Binary files are not editable.
    Re-indexing is scheduled via Celery if trigger_reindex=True.

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
