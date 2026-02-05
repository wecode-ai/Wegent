# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base tools for MCP Server.

These tools provide knowledge base and document management capabilities
through the MCP protocol.
"""

import base64
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.models.knowledge import DocumentStatus, KnowledgeDocument
from app.schemas.knowledge import ResourceScope

logger = logging.getLogger(__name__)

DEFAULT_TEXT_FILE_EXTENSION = "txt"


def _normalize_file_extension(file_extension: Optional[str]) -> str:
    """Normalize file extension to a safe, dot-less form.

    Args:
        file_extension: File extension provided by caller (may include leading dot)

    Returns:
        Normalized file extension without leading dot (e.g., "txt")
    """
    ext = (file_extension or "").strip()
    ext = ext.lstrip(".")
    if not ext:
        return DEFAULT_TEXT_FILE_EXTENSION
    # Basic safety checks (avoid path injection / invalid filenames)
    if "/" in ext or "\\" in ext or ".." in ext:
        raise ValueError("Invalid file_extension")
    return ext


def _build_filename(name: str, file_extension: str) -> str:
    """Build a safe filename for attachment upload."""
    ext = _normalize_file_extension(file_extension)
    return f"{name}.{ext}"


def list_knowledge_bases(
    token_info: TaskTokenInfo,
    scope: str = "all",
    group_name: Optional[str] = None,
) -> Dict[str, Any]:
    """List all knowledge bases accessible to the current user.

    Args:
        token_info: Task token info containing user_id
        scope: Scope filter - "personal", "group", or "all" (default)
        group_name: Group name when scope="group"

    Returns:
        Dictionary with list of knowledge bases
    """
    from app.services.knowledge import KnowledgeService

    db = SessionLocal()
    try:
        # Map scope string to enum
        scope_enum = ResourceScope.ALL
        if scope == "personal":
            scope_enum = ResourceScope.PERSONAL
        elif scope == "group":
            scope_enum = ResourceScope.GROUP

        # Get knowledge bases from service
        knowledge_bases = KnowledgeService.list_knowledge_bases(
            db=db,
            user_id=token_info.user_id,
            scope=scope_enum,
            group_name=group_name,
        )

        # Format response
        result = []
        for kb in knowledge_bases:
            spec = kb.json.get("spec", {})
            # Count documents
            doc_count = KnowledgeService.get_document_count(db, kb.id)
            result.append(
                {
                    "id": kb.id,
                    "name": spec.get("name", kb.name),
                    "namespace": kb.namespace,
                    "description": spec.get("description", ""),
                    "document_count": doc_count,
                    "kb_type": spec.get("kbType", "notebook"),
                    "created_at": kb.created_at.isoformat() if kb.created_at else None,
                }
            )

        return {
            "knowledge_bases": result,
            "total": len(result),
        }
    except Exception as e:
        logger.error(f"[MCP] Failed to list knowledge bases: {e}")
        return {"error": str(e), "knowledge_bases": [], "total": 0}
    finally:
        db.close()


def list_documents(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    status: str = "all",
) -> Dict[str, Any]:
    """List all documents in a knowledge base.

    Args:
        token_info: Task token info containing user_id
        knowledge_base_id: Knowledge base ID
        status: Status filter - "enabled", "disabled", or "all" (default)

    Returns:
        Dictionary with list of documents
    """
    from app.services.knowledge import KnowledgeService

    db = SessionLocal()
    try:
        # Verify user has access to this knowledge base
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=token_info.user_id,
        )
        if not kb:
            return {
                "error": "Knowledge base not found or access denied",
                "documents": [],
                "total": 0,
            }

        # Get documents
        documents = KnowledgeService.list_documents(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=token_info.user_id,
        )

        # Filter by status if specified
        result = []
        for doc in documents:
            if status != "all":
                if status == "enabled" and doc.status != DocumentStatus.ENABLED:
                    continue
                if status == "disabled" and doc.status != DocumentStatus.DISABLED:
                    continue

            result.append(
                {
                    "id": doc.id,
                    "name": doc.name,
                    "file_extension": doc.file_extension,
                    "file_size": doc.file_size,
                    "status": doc.status.value if doc.status else "enabled",
                    "source_type": doc.source_type,
                    "is_active": doc.is_active,
                    "created_at": (
                        doc.created_at.isoformat() if doc.created_at else None
                    ),
                }
            )

        return {
            "documents": result,
            "total": len(result),
        }
    except Exception as e:
        logger.error(f"[MCP] Failed to list documents: {e}")
        return {"error": str(e), "documents": [], "total": 0}
    finally:
        db.close()


def create_knowledge_base(
    token_info: TaskTokenInfo,
    name: str,
    description: Optional[str] = None,
    namespace: str = "default",
    kb_type: str = "notebook",
    summary_enabled: bool = False,
    retrieval_config: Optional[dict] = None,
    summary_model_ref: Optional[dict] = None,
) -> Dict[str, Any]:
    """Create a new knowledge base.

    Args:
        token_info: Task token info containing user_id
        name: Knowledge base display name
        description: Optional description
        namespace: "default" for personal knowledge base, or group namespace
        kb_type: Knowledge base type, e.g. "notebook" or "classic"
        summary_enabled: Enable automatic summary generation
        retrieval_config: Optional retrieval configuration dict (advanced)
        summary_model_ref: Optional model reference dict for summary generation

    Returns:
        Dictionary with created knowledge base info
    """
    db = SessionLocal()
    try:
        return _create_knowledge_base(
            db=db,
            token_info=token_info,
            name=name,
            description=description,
            namespace=namespace,
            kb_type=kb_type,
            summary_enabled=summary_enabled,
            retrieval_config=retrieval_config,
            summary_model_ref=summary_model_ref,
        )
    finally:
        db.close()


def delete_document(
    token_info: TaskTokenInfo,
    document_id: int,
) -> Dict[str, Any]:
    """Delete a document from a knowledge base.

    Args:
        token_info: Task token info containing user_id
        document_id: Document ID to delete

    Returns:
        Dictionary with deletion result
    """
    db = SessionLocal()
    try:
        return _delete_document(
            db=db,
            token_info=token_info,
            document_id=document_id,
        )
    finally:
        db.close()


def _create_knowledge_base(
    db: Session,
    token_info: TaskTokenInfo,
    name: str,
    description: Optional[str] = None,
    namespace: str = "default",
    kb_type: str = "notebook",
    summary_enabled: bool = False,
    retrieval_config: Optional[dict] = None,
    summary_model_ref: Optional[dict] = None,
) -> Dict[str, Any]:
    """Create a new knowledge base using the provided DB session."""
    from sqlalchemy.exc import IntegrityError

    from app.schemas.knowledge import KnowledgeBaseCreate
    from app.services.knowledge import KnowledgeService

    try:
        data = KnowledgeBaseCreate(
            name=name,
            description=description,
            namespace=namespace,
            kb_type=kb_type,
            retrieval_config=retrieval_config,
            summary_enabled=summary_enabled,
            summary_model_ref=summary_model_ref,
        )

        kb_id = KnowledgeService.create_knowledge_base(
            db=db,
            user_id=token_info.user_id,
            data=data,
        )
        db.commit()

        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=kb_id,
            user_id=token_info.user_id,
        )
        if not kb:
            return {"error": "Failed to retrieve created knowledge base"}

        spec = kb.json.get("spec", {})
        return {
            "success": True,
            "knowledge_base": {
                "id": kb.id,
                "name": spec.get("name", kb.name),
                "namespace": kb.namespace,
                "description": spec.get("description", ""),
                "document_count": 0,
                "kb_type": spec.get("kbType", "notebook"),
                "created_at": kb.created_at.isoformat() if kb.created_at else None,
            },
        }
    except IntegrityError:
        db.rollback()
        return {
            "error": f"Knowledge base with name '{name}' already exists in this namespace"
        }
    except ValueError as e:
        db.rollback()
        return {"error": str(e)}
    except Exception as e:
        db.rollback()
        logger.error(f"[MCP] Failed to create knowledge base: {e}")
        return {"error": str(e)}


def _delete_document(
    db: Session,
    token_info: TaskTokenInfo,
    document_id: int,
) -> Dict[str, Any]:
    """Delete a document using the provided DB session."""
    from app.services.knowledge import KnowledgeService

    try:
        result = KnowledgeService.delete_document(
            db=db,
            document_id=document_id,
            user_id=token_info.user_id,
        )
        if not result.success:
            return {"error": "Document not found or access denied"}

        return {
            "success": True,
            "deleted": True,
            "document_id": document_id,
            "knowledge_base_id": result.kb_id,
        }
    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"[MCP] Failed to delete document: {e}")
        return {"error": str(e)}


def create_document(
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    name: str,
    source_type: str,
    content: Optional[str] = None,
    file_base64: Optional[str] = None,
    file_extension: Optional[str] = None,
    url: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a new document in a knowledge base.

    Args:
        token_info: Task token info containing user_id
        knowledge_base_id: Target knowledge base ID
        name: Document name
        source_type: Source type - "text", "file", or "web"
        content: Document content when source_type="text"
        file_base64: Base64 encoded file content when source_type="file"
        file_extension: File extension when source_type="file"
        url: URL to fetch when source_type="web"

    Returns:
        Dictionary with created document info
    """
    from app.services.knowledge import KnowledgeService

    db = SessionLocal()
    try:
        # Verify user has access to this knowledge base
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=token_info.user_id,
        )
        if not kb:
            return {"error": "Knowledge base not found or access denied"}

        # Validate input based on source_type
        normalized_ext: str | None = None
        if source_type == "text":
            if not content:
                return {"error": "content is required for source_type='text'"}
            normalized_ext = _normalize_file_extension(file_extension)
        elif source_type == "file":
            if not file_base64 or not file_extension:
                return {
                    "error": "file_base64 and file_extension are required for source_type='file'"
                }
            normalized_ext = _normalize_file_extension(file_extension)
        elif source_type == "web":
            if not url:
                return {"error": "url is required for source_type='web'"}
            normalized_ext = DEFAULT_TEXT_FILE_EXTENSION
        else:
            return {"error": f"Invalid source_type: {source_type}"}

        # Handle web scraping
        if source_type == "web":
            return _create_document_from_web(
                db=db,
                token_info=token_info,
                knowledge_base_id=knowledge_base_id,
                name=name,
                url=url,
                file_extension=normalized_ext or DEFAULT_TEXT_FILE_EXTENSION,
            )

        # Handle text content
        if source_type == "text":
            return _create_document_from_text(
                db=db,
                token_info=token_info,
                knowledge_base_id=knowledge_base_id,
                name=name,
                content=content,
                file_extension=normalized_ext or DEFAULT_TEXT_FILE_EXTENSION,
            )

        # Handle file upload
        if source_type == "file":
            return _create_document_from_file(
                db=db,
                token_info=token_info,
                knowledge_base_id=knowledge_base_id,
                name=name,
                file_base64=file_base64,
                file_extension=normalized_ext or DEFAULT_TEXT_FILE_EXTENSION,
            )

        return {"error": "Unknown source_type"}
    except Exception as e:
        logger.error(f"[MCP] Failed to create document: {e}")
        return {"error": str(e)}
    finally:
        db.close()


def _create_document_from_text(
    db: Session,
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    name: str,
    content: str,
    file_extension: str,
) -> Dict[str, Any]:
    """Create a document from text content."""
    from app.schemas.knowledge import KnowledgeDocumentCreate
    from app.services.context import context_service
    from app.services.knowledge import KnowledgeService

    attachment_id: int | None = None
    try:
        normalized_ext = _normalize_file_extension(file_extension)
        filename = _build_filename(name, normalized_ext)
        binary_data = content.encode("utf-8")

        attachment, _ = context_service.upload_attachment(
            db=db,
            user_id=token_info.user_id,
            filename=filename,
            binary_data=binary_data,
            subtask_id=0,
        )
        attachment_id = attachment.id

        doc_data = KnowledgeDocumentCreate(
            name=name,
            source_type="text",
            attachment_id=attachment.id,
            file_extension=normalized_ext,
            file_size=len(binary_data),
        )

        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=token_info.user_id,
            data=doc_data,
        )

        return {
            "success": True,
            "document": {
                "id": document.id,
                "name": document.name,
                "source_type": document.source_type,
                "file_extension": document.file_extension,
                "file_size": document.file_size,
                "status": "pending",  # Indexing in progress
            },
        }
    except Exception as e:
        if attachment_id is not None:
            try:
                context_service.delete_context(
                    db=db,
                    context_id=attachment_id,
                    user_id=token_info.user_id,
                )
            except Exception as cleanup_error:
                logger.warning(
                    "[MCP] Failed to cleanup attachment context %s: %s",
                    attachment_id,
                    cleanup_error,
                )
        logger.error(f"[MCP] Failed to create document from text: {e}")
        return {"error": str(e)}


def _create_document_from_file(
    db: Session,
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    name: str,
    file_base64: str,
    file_extension: str,
) -> Dict[str, Any]:
    """Create a document from base64 encoded file."""
    from app.schemas.knowledge import KnowledgeDocumentCreate
    from app.services.context import context_service
    from app.services.knowledge import KnowledgeService

    attachment_id: int | None = None
    try:
        normalized_ext = _normalize_file_extension(file_extension)
        filename = _build_filename(name, normalized_ext)

        # Decode base64 content
        try:
            file_content = base64.b64decode(file_base64)
        except Exception as e:
            return {"error": f"Invalid base64 content: {e}"}

        # Create attachment context for file storage
        attachment, _ = context_service.upload_attachment(
            db=db,
            user_id=token_info.user_id,
            filename=filename,
            binary_data=file_content,
            subtask_id=0,
        )
        attachment_id = attachment.id

        doc_data = KnowledgeDocumentCreate(
            name=name,
            source_type="file",
            attachment_id=attachment.id,
            file_extension=normalized_ext,
            file_size=len(file_content),
        )

        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=token_info.user_id,
            data=doc_data,
        )

        return {
            "success": True,
            "document": {
                "id": document.id,
                "name": document.name,
                "file_extension": document.file_extension,
                "file_size": document.file_size,
                "source_type": document.source_type,
                "status": "pending",  # Indexing in progress
            },
        }
    except Exception as e:
        if attachment_id is not None:
            try:
                context_service.delete_context(
                    db=db,
                    context_id=attachment_id,
                    user_id=token_info.user_id,
                )
            except Exception as cleanup_error:
                logger.warning(
                    "[MCP] Failed to cleanup attachment context %s: %s",
                    attachment_id,
                    cleanup_error,
                )
        logger.error(f"[MCP] Failed to create document from file: {e}")
        return {"error": str(e)}


def _create_document_from_web(
    db: Session,
    token_info: TaskTokenInfo,
    knowledge_base_id: int,
    name: str,
    url: str,
    file_extension: str,
) -> Dict[str, Any]:
    """Create a document from web URL."""
    import asyncio

    from app.schemas.knowledge import KnowledgeDocumentCreate
    from app.services.context import context_service
    from app.services.knowledge import KnowledgeService
    from app.services.web_scraper import WebScraperService

    attachment_id: int | None = None
    try:
        # Scrape web content
        scraper = WebScraperService()
        try:
            # Run async scraper in sync context
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                scraped = loop.run_until_complete(scraper.scrape_url(url))
            finally:
                loop.close()

            if not scraped or not scraped.content:
                return {"error": f"Failed to scrape content from {url}"}

            content = scraped.content
        except Exception as e:
            return {"error": f"Web scraping failed: {e}"}

        normalized_ext = _normalize_file_extension(file_extension)
        filename = _build_filename(name, normalized_ext)
        binary_data = content.encode("utf-8")

        attachment, _ = context_service.upload_attachment(
            db=db,
            user_id=token_info.user_id,
            filename=filename,
            binary_data=binary_data,
            subtask_id=0,
        )
        attachment_id = attachment.id

        doc_data = KnowledgeDocumentCreate(
            name=name,
            source_type="web",
            source_config={"url": url},
            attachment_id=attachment.id,
            file_extension=normalized_ext,
            file_size=len(binary_data),
        )

        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=token_info.user_id,
            data=doc_data,
        )

        return {
            "success": True,
            "document": {
                "id": document.id,
                "name": document.name,
                "source_type": document.source_type,
                "file_extension": document.file_extension,
                "file_size": document.file_size,
                "source_url": url,
                "status": "pending",  # Indexing in progress
            },
        }
    except Exception as e:
        if attachment_id is not None:
            try:
                context_service.delete_context(
                    db=db,
                    context_id=attachment_id,
                    user_id=token_info.user_id,
                )
            except Exception as cleanup_error:
                logger.warning(
                    "[MCP] Failed to cleanup attachment context %s: %s",
                    attachment_id,
                    cleanup_error,
                )
        logger.error(f"[MCP] Failed to create document from web: {e}")
        return {"error": str(e)}


def update_document(
    token_info: TaskTokenInfo,
    document_id: int,
    content: str,
    mode: str = "replace",
) -> Dict[str, Any]:
    """Update a document's content.

    Args:
        token_info: Task token info containing user_id
        document_id: Document ID to update
        content: New content
        mode: Update mode - "replace" (default) or "append"

    Returns:
        Dictionary with updated document info
    """
    from app.services.knowledge import KnowledgeService

    db = SessionLocal()
    try:
        # Get document and verify access
        document = KnowledgeService.get_document(
            db=db,
            document_id=document_id,
            user_id=token_info.user_id,
        )
        if not document:
            return {"error": "Document not found or access denied"}

        # Get existing content if mode is append
        existing_content = ""
        if mode == "append":
            from app.services.context import context_service

            if document.attachment_id:
                ctx = context_service.get_context_optional(db, document.attachment_id)
                if ctx and ctx.extracted_text:
                    existing_content = ctx.extracted_text

        # Build new content
        new_content = content
        if mode == "append":
            new_content = existing_content + "\n" + content

        # Update document content
        updated = KnowledgeService.update_document_content(
            db=db,
            document_id=document_id,
            content=new_content,
            user_id=token_info.user_id,
        )

        if not updated:
            return {"error": "Failed to update document"}

        db.commit()

        return {
            "success": True,
            "document": {
                "id": updated.id,
                "name": updated.name,
                "status": "pending",  # Re-indexing in progress
                "mode": mode,
            },
        }
    except Exception as e:
        db.rollback()
        logger.error(f"[MCP] Failed to update document: {e}")
        return {"error": str(e)}
    finally:
        db.close()
