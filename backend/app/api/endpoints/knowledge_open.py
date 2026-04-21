# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Open API endpoints for knowledge base and document management.

These endpoints are designed for external callers and support flexible
authentication via personal API keys or service API keys with the
wegent-username header.  Business logic is fully delegated to
KnowledgeOrchestrator so that REST API and MCP tools share the same path.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import AuthContext, get_auth_context
from app.schemas.knowledge import (
    DocumentContentReadResponse,
    DocumentContentUpdate,
    DocumentContentUpdateResponse,
    KnowledgeBaseListResponse,
    KnowledgeDocumentCreateV1,
    KnowledgeDocumentListResponse,
    KnowledgeDocumentResponse,
    KnowledgeDocumentUpdate,
    KnowledgeSearchRequest,
)
from app.schemas.rag import RetrieveResponse
from app.services.knowledge import KnowledgeService
from app.services.knowledge.orchestrator import (
    MAX_DOCUMENT_READ_LIMIT,
    knowledge_orchestrator,
)
from shared.telemetry.decorators import add_span_event, trace_async, trace_sync

router = APIRouter()


# ---------------------------------------------------------------------------
# GET /knowledge/list  — list accessible knowledge bases
# ---------------------------------------------------------------------------


@router.get(
    "/list",
    response_model=KnowledgeBaseListResponse,
)
@trace_sync("list_knowledge_bases_open", "knowledge.api")
def list_knowledge_bases_open(
    scope: str = Query(
        default="all",
        description="Scope of knowledge bases to return: 'personal' or 'all'",
    ),
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> KnowledgeBaseListResponse:
    """
    List knowledge bases with flexible authentication.

    This endpoint is compatible with OpenAPI-style authentication,
    supporting API keys via X-API-Key or Authorization headers,
    and username specification via wegent-username header for service keys.

    Args:
        scope: Filter scope for knowledge bases
            - "personal": Return only personal knowledge bases (created_by_me + shared_with_me)
            - "all": Return all accessible knowledge bases (personal + groups + organization)
            - Unrecognized values are treated as "all"

    Authentication:
        - Personal API key: Returns knowledge bases accessible to the key owner
        - Service API key: Requires wegent-username header to specify the target user
    """
    current_user = auth_context.user

    # Normalize scope: only "personal" is valid, everything else is treated as "all"
    normalized_scope = scope.lower() if scope else "all"
    if normalized_scope not in ("personal", "all"):
        normalized_scope = "all"

    # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
    return knowledge_orchestrator.list_knowledge_bases(
        db=db,
        user=current_user,
        scope=normalized_scope,
    )


# ---------------------------------------------------------------------------
# GET /knowledge/documents  — list documents in a knowledge base
# ---------------------------------------------------------------------------


@router.get(
    "/documents",
    response_model=KnowledgeDocumentListResponse,
)
@trace_sync("list_documents_open", "knowledge.api")
def list_documents_open(
    knowledge_base_id: int = Query(
        ...,
        description="Knowledge base ID to list documents from",
    ),
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> KnowledgeDocumentListResponse:
    """
    List documents in a knowledge base.

    Returns all documents belonging to the specified knowledge base,
    provided the authenticated user has access to it.

    Authentication:
        - Personal API key: Returns documents accessible to the key owner
        - Service API key: Requires wegent-username header to specify the target user
    """
    current_user = auth_context.user
    try:
        return knowledge_orchestrator.list_documents(
            db=db,
            user=current_user,
            knowledge_base_id=knowledge_base_id,
        )
    except ValueError as exc:
        error_msg = str(exc).lower()
        if "not found" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            )
        if "access denied" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(exc),
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )


# ---------------------------------------------------------------------------
# GET /knowledge/documents/{document_id}/content  — read document content
# ---------------------------------------------------------------------------


@router.get(
    "/documents/{document_id}/content",
    response_model=DocumentContentReadResponse,
)
@trace_sync("get_document_content_open", "knowledge.api")
def get_document_content_open(
    document_id: int,
    offset: int = Query(0, ge=0, description="Read start offset (characters)"),
    limit: int = Query(
        MAX_DOCUMENT_READ_LIMIT,
        ge=1,
        le=MAX_DOCUMENT_READ_LIMIT,
        description="Maximum number of characters to return",
    ),
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> DocumentContentReadResponse:
    """
    Get raw document content with pagination.

    Returns the extracted text content of the document along with
    pagination metadata and the current indexing status.

    When the document has not been indexed yet (index_status='not_indexed'
    or 'indexing'), the content field may be empty or incomplete.

    Authentication:
        - Personal API key: Returns content for documents accessible to the key owner
        - Service API key: Requires wegent-username header to specify the target user
    """
    current_user = auth_context.user

    try:
        return knowledge_orchestrator.read_document_content(
            db=db,
            user=current_user,
            document_id=document_id,
            offset=offset,
            limit=limit,
        )
    except ValueError as exc:
        error_msg = str(exc).lower()
        if "not found" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            )
        if "access denied" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(exc),
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )


# ---------------------------------------------------------------------------
# POST /knowledge/documents  — create a document
# ---------------------------------------------------------------------------


@router.post(
    "/documents",
    response_model=KnowledgeDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_async("create_document_open", "knowledge.api")
async def create_document_open(
    data: KnowledgeDocumentCreateV1,
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> KnowledgeDocumentResponse:
    """
    Create a document in a knowledge base.

    Supported source types:
    - **text**: Provide inline text via the `content` field. Optionally set
      `file_extension` (default: 'txt') for proper MIME handling.
    - **file**: Provide base64-encoded binary via `file_base64` and the file
      extension via `file_extension` (required). Maximum decoded size: 10 MB.
    - **web**: Provide a URL via the `url` field. The page is scraped and
      converted to Markdown automatically.
    - **attachment**: Provide an existing attachment ID via `attachment_id`.
      The attachment must be uploaded via POST /v1/attachments/upload and belong
      to the current user.

    The `table` source type is not supported via this endpoint;
    it is reserved for internal use and real-time external table integrations.

    Authentication:
        - Personal API key: Creates the document under the key owner's account
        - Service API key: Requires wegent-username header to specify the target user
    """
    current_user = auth_context.user
    source_type = data.source_type.value  # e.g. "text", "file", "web", "attachment"

    # Reject unsupported source types early with a clear message
    _SUPPORTED_SOURCE_TYPES = {"text", "file", "web", "attachment"}
    if source_type not in _SUPPORTED_SOURCE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"source_type '{source_type}' is not supported by this endpoint. "
                f"Supported types: {sorted(_SUPPORTED_SOURCE_TYPES)}"
            ),
        )

    # web scraping requires the dedicated async orchestrator method
    if source_type == "web":
        if not data.url:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="url is required when source_type is 'web'",
            )
        try:
            result = await knowledge_orchestrator.create_web_document(
                db=db,
                user=current_user,
                url=data.url,
                knowledge_base_id=data.knowledge_base_id,
                name=data.name,
            )
        except ValueError as exc:
            error_msg = str(exc).lower()
            if "not found" in error_msg:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=str(exc),
                )
            if "access denied" in error_msg:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=str(exc),
                )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            )

        if not result.get("success"):
            error_code = result.get("error_code", "SCRAPE_FAILED")
            error_message = result.get("error_message", "Failed to scrape URL")
            http_status = (
                status.HTTP_422_UNPROCESSABLE_ENTITY
                if error_code in ("INVALID_URL", "SSRF_BLOCKED")
                else status.HTTP_502_BAD_GATEWAY
            )
            raise HTTPException(status_code=http_status, detail=error_message)

        document = result.get("document")
        if document is None:
            # Scraping reported success but returned no document object — treat as
            # a server-side failure rather than silently crashing on attribute access.
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Web document creation succeeded but response is incomplete",
            )
        add_span_event(
            "knowledge.document.created",
            {
                "document_id": str(document.id),
                "knowledge_base_id": str(data.knowledge_base_id),
                "user_id": str(current_user.id),
            },
        )
        return document

    # Prepare splitter config for text/file/attachment types
    splitter_config_dict = (
        data.splitter_config.model_dump(exclude_none=True)
        if data.splitter_config
        else None
    )

    # attachment — requires attachment_id and validates ownership
    if source_type == "attachment":
        if not data.attachment_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="attachment_id is required when source_type is 'attachment'",
            )

    # Build common parameters for create_document_with_content
    create_doc_params = {
        "db": db,
        "user": current_user,
        "knowledge_base_id": data.knowledge_base_id,
        "name": data.name,
        "source_type": source_type,
        "trigger_indexing": True,
        "trigger_summary": True,
        "splitter_config": splitter_config_dict,
    }

    # Add source-specific parameters
    if source_type == "attachment":
        create_doc_params["attachment_id"] = data.attachment_id
    else:
        # text / file
        create_doc_params.update(
            {
                "content": data.content,
                "file_base64": data.file_base64,
                "file_extension": data.file_extension,
            }
        )

    # Unified document creation with shared error handling
    try:
        document = knowledge_orchestrator.create_document_with_content(
            **create_doc_params
        )
    except ValueError as exc:
        error_msg = str(exc).lower()
        if "not found" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            )
        if "access denied" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(exc),
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    add_span_event(
        "knowledge.document.created",
        {
            "document_id": str(document.id),
            "knowledge_base_id": str(data.knowledge_base_id),
            "user_id": str(current_user.id),
        },
    )
    return document


# ---------------------------------------------------------------------------
# POST /knowledge/search  — search document chunks via RAG retrieval
# ---------------------------------------------------------------------------


@router.post("/search", response_model=RetrieveResponse)
@trace_async("search_documents_open", "knowledge.api")
async def search_documents_open(
    data: KnowledgeSearchRequest,
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> RetrieveResponse:
    """Search document chunks in a knowledge base via RAG retrieval.

    Retriever and embedding model are resolved automatically from the
    knowledge base's ``retrievalConfig``, so callers only need to know
    the knowledge base ID and the query text.

    Authentication:
        - Personal API key: Searches within the key owner's accessible KBs
        - Service API key: Requires wegent-username header to specify the user

    Returns:
        RetrieveResponse with a ``records`` list of matching chunks,
        each containing ``content``, ``score``, and ``title``.

    Raises:
        400: Knowledge base retrieval config is incomplete (missing retriever
             or embedding model)
        403: Access denied to the knowledge base
        404: Knowledge base not found
        502: Upstream RAG gateway error
    """
    from app.services.rag.remote_gateway import RemoteRagGatewayError

    current_user = auth_context.user
    try:
        result = await knowledge_orchestrator.retrieve_knowledge(
            db=db,
            user=current_user,
            knowledge_base_id=data.knowledge_base_id,
            query=data.query,
            max_results=data.top_k,
            route_mode=data.route_mode,
            context_window=data.context_window,
            used_context_tokens=data.used_context_tokens,
            reserved_output_tokens=data.reserved_output_tokens,
            context_buffer_ratio=data.context_buffer_ratio,
            max_direct_chunks=data.max_direct_chunks,
        )
        return {"records": result.get("records", [])}
    except RemoteRagGatewayError as exc:
        raise HTTPException(
            status_code=exc.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        )
    except ValueError as exc:
        error_msg = str(exc).lower()
        if "not found" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
        if "access denied" in error_msg:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


# ---------------------------------------------------------------------------
# PUT /knowledge/documents/{document_id}  — update document metadata
# ---------------------------------------------------------------------------


@router.put("/documents/{document_id}", response_model=KnowledgeDocumentResponse)
@trace_sync("update_document_open", "knowledge.api")
def update_document_open(
    document_id: int,
    data: KnowledgeDocumentUpdate,
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> KnowledgeDocumentResponse:
    """Update document metadata (name, status, splitter_config).

    This endpoint only modifies document metadata and does **not** trigger
    RAG re-indexing.  To update document text content use the sibling
    ``PUT /knowledge/documents/{id}/content`` endpoint.

    Authentication:
        - Personal API key: Updates the document under the key owner's account
        - Service API key: Requires wegent-username header to specify the user
    """
    current_user = auth_context.user
    try:
        document = KnowledgeService.update_document(
            db=db,
            document_id=document_id,
            user_id=current_user.id,
            data=data,
        )
    except ValueError as exc:
        error_msg = str(exc).lower()
        if "not found" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
        if "access denied" in error_msg or "permission denied" in error_msg:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
        # Validation errors (e.g. invalid field value) should surface as 400
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return KnowledgeDocumentResponse.model_validate(document)


# ---------------------------------------------------------------------------
# PUT /knowledge/documents/{document_id}/content  — update document content
# ---------------------------------------------------------------------------


@router.put(
    "/documents/{document_id}/content",
    response_model=DocumentContentUpdateResponse,
)
@trace_sync("update_document_content_open", "knowledge.api")
def update_document_content_open(
    document_id: int,
    data: DocumentContentUpdate,
    auth_context: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> DocumentContentUpdateResponse:
    """Update the text content of a document and trigger RAG re-indexing.

    Only supported for TEXT-type documents and plain-text file documents
    (.txt, .md, .markdown).  Overwrites the underlying attachment content
    and schedules a Celery re-indexing job.

    Authentication:
        - Personal API key: Updates the document under the key owner's account
        - Service API key: Requires wegent-username header to specify the user

    Returns:
        ``{"success": true, "document_id": <id>, "message": "..."}``
    """
    current_user = auth_context.user
    try:
        result = knowledge_orchestrator.update_document_content(
            db=db,
            user=current_user,
            document_id=document_id,
            content=data.content,
            trigger_reindex=True,
        )
    except ValueError as exc:
        error_msg = str(exc).lower()
        if "not found" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
        if "access denied" in error_msg or "permission denied" in error_msg:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    add_span_event(
        "knowledge.document.content_updated.open",
        {
            "document_id": str(document_id),
            "user_id": str(current_user.id),
        },
    )
    return result
