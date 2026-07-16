# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base exploration tools for listing and reading documents.

These tools provide Unix-like commands (kb_ls, kb_head) for AI to explore
knowledge base contents when RAG search doesn't find relevant results.

These tools share the same call limit (max_calls_per_conversation) with
knowledge_base_search tool to prevent excessive knowledge base access.
"""

import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from shared.models.knowledge import KnowledgeBaseScope
from shared.telemetry.context.large_data import log_large_string_list
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

logger = logging.getLogger(__name__)

# Default configuration values
DEFAULT_MAX_CALLS_PER_CONVERSATION = 10
DEFAULT_KB_LS_LIMIT = 20
MAX_KB_LS_LIMIT = 100

# File size constants for human-readable formatting
KB = 1024
MB = KB * KB


class KBToolCallCounter:
    """Shared call counter for KB exploration tools (kb_ls, kb_head).

    This counter is shared across kb_ls and kb_head tools to enforce
    the max_calls_per_conversation limit. The counter is separate from
    knowledge_base_search's counter since exploration tools are secondary.

    Note: While knowledge_base_search has its own internal counter with
    token-based warnings, kb_ls and kb_head share this simpler counter
    that only enforces the hard max limit.
    """

    def __init__(self, max_calls: int = DEFAULT_MAX_CALLS_PER_CONVERSATION):
        self.max_calls = max_calls
        self.call_count = 0

    def check_and_increment(self) -> tuple[bool, Optional[str]]:
        """Check if call is allowed and increment counter.

        Returns:
            Tuple of (allowed, error_message)
            - allowed: True if call should proceed
            - error_message: JSON string with rejection info if not allowed
        """
        if self.call_count >= self.max_calls:
            logger.warning(
                "[KBToolCallCounter] Call REJECTED | Reason: max_calls_exceeded | "
                "Call count: %d/%d",
                self.call_count + 1,
                self.max_calls,
            )
            return False, json.dumps(
                {
                    "status": "rejected",
                    "reason": "max_calls_exceeded",
                    "message": f"🚫 Call Rejected: Maximum knowledge base tool call limit ({self.max_calls}) "
                    f"reached for this conversation. You have made {self.call_count} calls. "
                    f"Please use the information you've already gathered to answer the user's question.",
                    "call_count": self.call_count,
                    "max_calls": self.max_calls,
                },
                ensure_ascii=False,
            )

        self.call_count += 1
        logger.info(
            "[KBToolCallCounter] Call %d/%d allowed",
            self.call_count,
            self.max_calls,
        )
        return True, None


def _format_file_size(size_bytes: int) -> str:
    """Format file size in human-readable format."""
    if size_bytes < KB:
        return f"{size_bytes}B"
    elif size_bytes < MB:
        return f"{size_bytes / KB:.1f}KB"
    else:
        return f"{size_bytes / MB:.1f}MB"


def _get_backend_url() -> str:
    """Get backend API URL from settings."""
    from chat_shell.core.config import settings

    remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
    if remote_url:
        return remote_url.replace("/api/internal", "")
    return getattr(settings, "BACKEND_API_URL", "http://localhost:8000")


def _build_backend_post_kwargs(data: dict[str, Any], auth_token: str = "") -> dict:
    """Build HTTP POST kwargs, omitting empty headers for cleaner call semantics."""
    from chat_shell.core.config import settings

    headers = {}
    service_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", "") or auth_token
    if service_token:
        headers["Authorization"] = f"Bearer {service_token}"

    kwargs = {"json": data}
    if headers:
        kwargs["headers"] = headers
    return kwargs


def _scope_payloads(scopes: list[KnowledgeBaseScope]) -> list[dict[str, Any]]:
    """Serialize KB scopes for Backend internal APIs."""
    return [
        {
            "knowledge_base_id": scope.knowledge_base_id,
            "scope_restricted": scope.scope_restricted,
            "document_ids": scope.document_ids,
        }
        for scope in scopes
    ]


def _restricted_scope_for_kb(
    scopes: list[KnowledgeBaseScope],
    knowledge_base_id: int,
) -> KnowledgeBaseScope | None:
    """Return the restricted scope for a KB, if one exists."""
    for scope in scopes:
        if scope.knowledge_base_id == knowledge_base_id and scope.scope_restricted:
            return scope
    return None


def _scope_kb_ids(scopes: list[KnowledgeBaseScope]) -> set[int]:
    """Return KB IDs represented by scope payloads."""
    return {scope.knowledge_base_id for scope in scopes}


def _format_scope_violation(message: str) -> str:
    """Format a document scope violation."""
    return json.dumps(
        {
            "status": "error",
            "error_code": "document_scope_violation",
            "message": message,
        },
        ensure_ascii=False,
    )


# ============== kb_ls Tool ==============


class KbLsInput(BaseModel):
    """Input schema for kb_ls tool."""

    knowledge_base_id: int = Field(
        description="Knowledge base ID to list documents from"
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Start offset for paginated document listing.",
    )
    limit: int = Field(
        default=DEFAULT_KB_LS_LIMIT,
        ge=1,
        le=MAX_KB_LS_LIMIT,
        description="Maximum number of documents to return in this page.",
    )


class KbLsTool(BaseTool):
    """List documents in a knowledge base with metadata and summaries.

    Similar to 'ls -l' command. Use when RAG search doesn't find relevant
    content and you need to explore what documents are available.

    This tool shares call limits with kb_head via a shared counter.
    """

    name: str = "kb_ls"
    display_name: str = "列出文档"
    description: str = (
        "List documents in a knowledge base with summaries. Similar to 'ls -l'. "
        "Use when RAG search doesn't find relevant content to explore available documents."
    )
    args_schema: type[BaseModel] = KbLsInput

    # Knowledge base IDs this tool can access (set when creating the tool)
    knowledge_base_ids: list[int] = Field(default_factory=list)
    knowledge_base_scopes: list[KnowledgeBaseScope] = Field(default_factory=list)

    # Database session (optional, used in package mode)
    db_session: Optional[Any] = None

    # User JWT for backend internal API calls that require authentication
    auth_token: str = ""

    # Shared call counter (set when creating the tool, shared with kb_head)
    _call_counter: Optional[KBToolCallCounter] = PrivateAttr(default=None)

    def _run(
        self,
        knowledge_base_id: int,
        offset: int = 0,
        limit: int = DEFAULT_KB_LS_LIMIT,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KbLsTool only supports async execution")

    @trace_async(span_name="kb_ls_arun", tracer_name="chat_shell.tools.kb_ls")
    async def _arun(
        self,
        knowledge_base_id: int,
        offset: int = 0,
        limit: int = DEFAULT_KB_LS_LIMIT,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """List documents in the specified knowledge base.

        Args:
            knowledge_base_id: Knowledge base ID to list documents from
            run_manager: Callback manager

        Returns:
            JSON string with document list
        """
        try:
            add_span_event("listing_documents")
            set_span_attribute("knowledge_base_id", knowledge_base_id)
            set_span_attribute("offset", offset)
            set_span_attribute("limit", limit)

            # Check call limit if counter is set
            if self._call_counter:
                allowed, error_msg = self._call_counter.check_and_increment()
                if not allowed:
                    return error_msg

            # Validate knowledge base ID is in allowed list
            if (
                self.knowledge_base_ids
                and knowledge_base_id not in self.knowledge_base_ids
            ):
                return json.dumps(
                    {
                        "error": f"Knowledge base {knowledge_base_id} is not accessible. "
                        f"Available KBs: {self.knowledge_base_ids}"
                    },
                    ensure_ascii=False,
                )

            if limit < 1 or limit > MAX_KB_LS_LIMIT:
                return json.dumps(
                    {
                        "error": f"limit must be between 1 and {MAX_KB_LS_LIMIT}",
                    },
                    ensure_ascii=False,
                )
            if offset < 0:
                return json.dumps(
                    {"error": "offset must be greater than or equal to 0"},
                    ensure_ascii=False,
                )

            logger.info(f"[KbLsTool] Listing documents in KB {knowledge_base_id}")

            # Try package mode first (direct DB access)
            try:
                return await self._list_docs_package_mode(
                    knowledge_base_id, offset=offset, limit=limit
                )
            except ImportError:
                # Fall back to HTTP mode
                return await self._list_docs_http_mode(
                    knowledge_base_id, offset=offset, limit=limit
                )

        except Exception as e:
            logger.error(f"[KbLsTool] Failed to list documents: {e}", exc_info=True)
            return json.dumps(
                {"error": f"Failed to list documents: {str(e)}"}, ensure_ascii=False
            )

    @trace_async(
        span_name="kb_ls_list_docs_package_mode",
        tracer_name="chat_shell.tools.kb_ls",
    )
    async def _list_docs_package_mode(
        self,
        knowledge_base_id: int,
        *,
        offset: int,
        limit: int,
    ) -> str:
        """List documents using direct database access."""
        import asyncio

        from app.models.knowledge import KnowledgeDocument

        # Check if we have a sync session with query method
        if not hasattr(self.db_session, "query"):
            raise ImportError(
                "Package mode requires sync SQLAlchemy session with query method"
            )

        add_span_event("listing_documents")
        set_span_attribute("knowledge_base_id", knowledge_base_id)
        set_span_attribute("mode", "package")

        def _query_docs():
            base_query = self.db_session.query(KnowledgeDocument).filter(
                KnowledgeDocument.kind_id == knowledge_base_id
            )
            if self.knowledge_base_scopes and knowledge_base_id not in _scope_kb_ids(
                self.knowledge_base_scopes
            ):
                return (
                    _format_scope_violation(
                        "Requested documents are outside the allowed knowledge scope."
                    ),
                    0,
                )
            restricted_scope = _restricted_scope_for_kb(
                self.knowledge_base_scopes,
                knowledge_base_id,
            )
            if restricted_scope is not None:
                if not restricted_scope.document_ids:
                    return [], 0
                base_query = base_query.filter(
                    KnowledgeDocument.id.in_(restricted_scope.document_ids)
                )
            total = base_query.count()
            documents = (
                base_query.order_by(KnowledgeDocument.created_at.desc())
                .offset(offset)
                .limit(limit)
                .all()
            )
            return documents, total

        documents, total = await asyncio.to_thread(_query_docs)
        if isinstance(documents, str):
            return documents

        doc_items = []
        for doc in documents:
            short_summary = None
            if doc.summary and isinstance(doc.summary, dict):
                short_summary = doc.summary.get("short_summary")

            doc_items.append(
                {
                    "id": doc.id,
                    "name": doc.name,
                    "type": doc.file_extension or "",
                    "size": _format_file_size(doc.file_size or 0),
                    "summary": short_summary,
                    "is_active": doc.is_active,
                }
            )

        set_span_attribute("document_count", len(doc_items))

        logger.info(
            f"[KbLsTool] Listed {len(doc_items)} documents from KB {knowledge_base_id} "
            f"(package mode, offset={offset}, limit={limit}, total={total})"
        )

        return json.dumps(
            {
                "knowledge_base_id": knowledge_base_id,
                "documents": doc_items,
                "total": total,
                "returned_count": len(doc_items),
                "offset": offset,
                "limit": limit,
                "has_more": offset + len(doc_items) < total,
            },
            ensure_ascii=False,
        )

    @trace_async(
        span_name="kb_ls_list_docs_http_mode", tracer_name="chat_shell.tools.kb_ls"
    )
    async def _list_docs_http_mode(
        self,
        knowledge_base_id: int,
        *,
        offset: int,
        limit: int,
    ) -> str:
        """List documents via HTTP API."""
        import httpx

        add_span_event("listing_documents")
        set_span_attribute("knowledge_base_id", knowledge_base_id)
        set_span_attribute("mode", "http")

        backend_url = _get_backend_url()

        try:
            add_span_event("http_request_started")
            request_data: dict[str, Any] = {
                "knowledge_base_id": knowledge_base_id,
                "offset": offset,
                "limit": limit,
            }
            if self.knowledge_base_scopes:
                request_data["knowledge_base_scopes"] = _scope_payloads(
                    self.knowledge_base_scopes
                )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{backend_url}/api/internal/rag/list-docs",
                    **_build_backend_post_kwargs(request_data, self.auth_token),
                )

                if response.status_code != 200:
                    logger.warning(
                        f"[KbLsTool] HTTP list-docs returned {response.status_code}"
                    )
                    try:
                        error_detail = response.json().get("detail")
                        if (
                            isinstance(error_detail, dict)
                            and error_detail.get("error_code")
                            == "document_scope_violation"
                        ):
                            return json.dumps(
                                {
                                    "status": "error",
                                    "error_code": "document_scope_violation",
                                    "message": error_detail.get(
                                        "message",
                                        "Requested documents are outside the allowed knowledge scope.",
                                    ),
                                },
                                ensure_ascii=False,
                            )
                    except Exception:
                        pass
                    return json.dumps(
                        {
                            "error": f"Failed to list documents: HTTP {response.status_code}"
                        },
                        ensure_ascii=False,
                    )

                data = response.json()
                documents = data.get("documents", [])

                # Format response for AI consumption
                doc_items = []
                for doc in documents:
                    doc_items.append(
                        {
                            "id": doc.get("id"),
                            "name": doc.get("name"),
                            "type": doc.get("file_extension", ""),
                            "size": _format_file_size(doc.get("file_size", 0)),
                            "summary": doc.get("short_summary"),
                            "is_active": doc.get("is_active", False),
                        }
                    )

                set_span_attribute("document_count", len(doc_items))

                logger.info(
                    f"[KbLsTool] Listed {len(doc_items)} documents from KB {knowledge_base_id} "
                    f"(HTTP mode, offset={offset}, limit={limit}, total={data.get('total', 0)})"
                )

                return json.dumps(
                    {
                        "knowledge_base_id": knowledge_base_id,
                        "documents": doc_items,
                        "total": data.get("total", len(doc_items)),
                        "returned_count": data.get("returned_count", len(doc_items)),
                        "offset": data.get("offset", offset),
                        "limit": data.get("limit", limit),
                        "has_more": data.get("has_more", False),
                    },
                    ensure_ascii=False,
                )

        except Exception as e:
            logger.error(f"[KbLsTool] HTTP list-docs failed: {e}")
            return json.dumps(
                {"error": f"Failed to list documents: {str(e)}"}, ensure_ascii=False
            )


# ============== kb_head Tool ==============


class KbHeadInput(BaseModel):
    """Input schema for kb_head tool."""

    document_ids: list[int] = Field(description="Document IDs to read content from")
    offset: int = Field(default=0, ge=0, description="Start position in characters")
    limit: int = Field(
        default=50000,
        ge=1,
        le=500000,
        description="Max characters to return (default 50KB)",
    )


class KnowledgeListDocumentsInput(BaseModel):
    """Input schema for listing mounted knowledge documents."""

    offset: int = Field(
        default=0,
        ge=0,
        description="Number of documents to skip.",
    )
    limit: int = Field(
        default=DEFAULT_KB_LS_LIMIT,
        ge=1,
        le=MAX_KB_LS_LIMIT,
        description="Maximum number of documents to return.",
    )


class KnowledgeListDocumentsTool(BaseTool):
    """List documents in mounted knowledge sources."""

    name: str = "knowledge_list_documents"
    display_name: str = "列出知识文档"
    description: str = (
        "List documents in the knowledge sources mounted to this conversation. "
        "Prefer this over kb_ls for document or file listing requests because "
        "kb_ls only lists internal knowledge bases. "
        "Use this when the user asks what documents or files are available in the "
        "selected knowledge sources. The response includes selected_sources; when "
        "answering which knowledge sources are selected, enumerate every source in "
        "selected_sources, including external providers and sources with "
        "zero documents."
    )
    args_schema: type[BaseModel] = KnowledgeListDocumentsInput

    knowledge_base_ids: list[int] = Field(default_factory=list)
    knowledge_base_scopes: list[KnowledgeBaseScope] = Field(default_factory=list)
    external_knowledge_refs: list[dict[str, Any]] = Field(default_factory=list)
    user_id: int = 0
    user_name: Optional[str] = None
    auth_token: str = ""
    _call_counter: Optional[KBToolCallCounter] = PrivateAttr(default=None)

    def _run(
        self,
        offset: int = 0,
        limit: int = DEFAULT_KB_LS_LIMIT,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError(
            "KnowledgeListDocumentsTool only supports async execution"
        )

    @trace_async(
        span_name="knowledge_list_documents_arun",
        tracer_name="chat_shell.tools.knowledge_list_documents",
    )
    async def _arun(
        self,
        offset: int = 0,
        limit: int = DEFAULT_KB_LS_LIMIT,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """List documents in mounted knowledge sources."""
        if not self.knowledge_base_ids and not self.external_knowledge_refs:
            return json.dumps(
                {
                    "documents": [],
                    "message": "No listable knowledge sources are mounted.",
                },
                ensure_ascii=False,
            )

        if limit < 1 or limit > MAX_KB_LS_LIMIT:
            return json.dumps(
                {"error": f"limit must be between 1 and {MAX_KB_LS_LIMIT}"},
                ensure_ascii=False,
            )
        if offset < 0:
            return json.dumps(
                {"error": "offset must be greater than or equal to 0"},
                ensure_ascii=False,
            )

        if self._call_counter:
            allowed, error_msg = self._call_counter.check_and_increment()
            if not allowed:
                return error_msg

        internal_documents = await self._list_internal_documents(
            offset=offset,
            limit=limit,
        )
        external_result = await self._list_external_documents(
            offset=offset,
            limit=limit,
        )
        if external_result.get("error") and not internal_documents:
            return json.dumps(external_result, ensure_ascii=False)

        external_documents = external_result.get("documents") or []
        documents = [*internal_documents, *external_documents]
        warnings = external_result.get("warnings") or []
        if external_result.get("error"):
            warnings = [
                *warnings,
                {
                    "type": "external_listing_failed",
                    "message": external_result["error"],
                    "status_code": external_result.get("status_code"),
                },
            ]
        selected_sources = self._build_selected_sources(documents)
        return json.dumps(
            {
                "selected_sources": selected_sources,
                "documents": documents,
                "total_returned": len(documents),
                "internal_returned": len(internal_documents),
                "external_returned": len(external_documents),
                "pagination_scope": "per_source",
                "must_include_all_selected_sources": True,
                "warnings": warnings,
                "answer_hint": (
                    "When answering source/document listing questions, group the "
                    "answer by every item in selected_sources and do not omit "
                    "external providers or selected sources with zero documents."
                ),
            },
            ensure_ascii=False,
        )

    def _build_selected_sources(
        self,
        documents: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Group listed documents by mounted source for model-friendly answers."""
        sources: dict[str, dict[str, Any]] = {}

        self._seed_internal_selected_sources(sources)
        self._seed_external_selected_sources(sources)

        for doc in documents:
            provider = str(doc.get("provider") or "unknown")
            source_id = str(doc.get("source_id") or "")
            key = f"{provider}:{source_id}"
            source = sources.setdefault(
                key,
                {
                    "provider": provider,
                    "source_id": source_id,
                    "source_name": doc.get("source_name") or source_id or provider,
                    "document_count": 0,
                    "documents": [],
                },
            )
            if doc.get("source_name"):
                source["source_name"] = doc["source_name"]
            self._append_selected_document(source, doc)

        for source in sources.values():
            source["document_count"] = len(source["documents"])

        return list(sources.values())

    def _seed_internal_selected_sources(
        self,
        sources: dict[str, dict[str, Any]],
    ) -> None:
        """Add selected internal KBs before documents are grouped."""
        for knowledge_base_id in self.knowledge_base_ids:
            source_id = str(knowledge_base_id)
            sources[f"internal:{source_id}"] = {
                "provider": "internal",
                "source_id": source_id,
                "source_name": f"KB-{source_id}",
                "document_count": 0,
                "documents": [],
            }

    def _seed_external_selected_sources(
        self,
        sources: dict[str, dict[str, Any]],
    ) -> None:
        """Add selected external sources before documents are grouped."""
        for ref in self.external_knowledge_refs:
            provider = str(ref.get("provider") or "external")
            source_id = str(ref.get("id") or "")
            sources[f"{provider}:{source_id}"] = {
                "provider": provider,
                "source_id": source_id,
                "source_name": ref.get("name") or source_id or provider,
                "scope": ref.get("scope"),
                "mode": ref.get("mode"),
                "document_count": 0,
                "documents": [],
            }

    @staticmethod
    def _append_selected_document(
        source: dict[str, Any],
        doc: dict[str, Any],
    ) -> None:
        """Append one listed document to a selected source group."""
        source["documents"].append(
            {
                "document_id": doc.get("document_id"),
                "title": doc.get("title"),
                "node_id": doc.get("node_id"),
                "parent_id": doc.get("parent_id"),
                "file_extension": doc.get("file_extension"),
                "source_uri": doc.get("source_uri"),
            }
        )

    async def _list_internal_documents(
        self,
        *,
        offset: int,
        limit: int,
    ) -> list[dict[str, Any]]:
        """List internal mounted KB documents through Backend internal API."""
        if not self.knowledge_base_ids:
            return []

        import httpx

        documents: list[dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=60.0) as client:
            for knowledge_base_id in self.knowledge_base_ids:
                request_data: dict[str, Any] = {
                    "knowledge_base_id": knowledge_base_id,
                    "offset": offset,
                    "limit": limit,
                }
                if self.knowledge_base_scopes:
                    request_data["knowledge_base_scopes"] = _scope_payloads(
                        self.knowledge_base_scopes
                    )
                response = await client.post(
                    f"{_get_backend_url()}/api/internal/rag/list-docs",
                    **_build_backend_post_kwargs(request_data, self.auth_token),
                )
                if response.status_code != 200:
                    logger.warning(
                        "[KnowledgeListDocumentsTool] Internal list-docs returned %s: %s",
                        response.status_code,
                        response.text,
                    )
                    continue

                payload = response.json()
                for doc in payload.get("documents") or []:
                    documents.append(
                        {
                            "provider": "internal",
                            "source_id": str(knowledge_base_id),
                            "source_name": payload.get("knowledge_base_name")
                            or f"KB-{knowledge_base_id}",
                            "document_id": doc.get("id"),
                            "title": doc.get("name"),
                            "node_id": (
                                f"document:{doc.get('id')}"
                                if doc.get("id") is not None
                                else None
                            ),
                            "parent_id": doc.get("folder_id"),
                            "mime_type": doc.get("mime_type"),
                            "file_extension": doc.get("file_extension")
                            or doc.get("type"),
                            "source_uri": None,
                            "summary": doc.get("short_summary") or doc.get("summary"),
                        }
                    )

        return documents

    async def _list_external_documents(
        self,
        *,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        """List external mounted documents through Backend provider registry."""
        if not self.external_knowledge_refs:
            return {"documents": [], "total_returned": 0, "warnings": []}

        import httpx

        request_data: dict[str, Any] = {
            "external_knowledge_refs": self.external_knowledge_refs,
            "user_id": self.user_id,
            "limit": limit,
            "offset": offset,
        }
        if self.user_name is not None:
            request_data["user_name"] = self.user_name

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{_get_backend_url()}/api/internal/knowledge/list-documents",
                **_build_backend_post_kwargs(request_data, self.auth_token),
            )

        if response.status_code != 200:
            logger.warning(
                "[KnowledgeListDocumentsTool] HTTP list-documents returned %s: %s",
                response.status_code,
                response.text,
            )
            return {
                "error": "Failed to list knowledge documents",
                "status_code": response.status_code,
            }

        return response.json()


class KbHeadTool(BaseTool):
    """Read document content with offset/limit pagination.

    Similar to 'head -c' command. Returns partial content starting from
    the specified offset. Use has_more flag to check if more content exists.

    This tool shares call limits with kb_ls via a shared counter.
    """

    name: str = "kb_head"
    display_name: str = "读取文档"
    description: str = (
        "Read document content with offset/limit. Similar to 'head -c'. "
        "Returns partial content, use offset to continue reading large files."
    )
    args_schema: type[BaseModel] = KbHeadInput

    # Knowledge base IDs this tool can access (set when creating the tool)
    knowledge_base_ids: list[int] = Field(default_factory=list)
    knowledge_base_scopes: list[KnowledgeBaseScope] = Field(default_factory=list)

    # User ID for context creation when auto-creating records
    user_id: int = 0

    # Database session (optional, used in package mode)
    db_session: Optional[Any] = None

    # User subtask ID for persistence (optional, enables kb_head tracking)
    user_subtask_id: Optional[int] = None

    # User JWT for backend internal API calls that require authentication
    auth_token: str = ""

    # Shared call counter (set when creating the tool, shared with kb_ls)
    _call_counter: Optional[KBToolCallCounter] = PrivateAttr(default=None)

    def _run(
        self,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50000,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KbHeadTool only supports async execution")

    @trace_async(span_name="kb_head_arun", tracer_name="chat_shell.tools.kb_head")
    async def _arun(
        self,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50000,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Read content from specified documents.

        Args:
            document_ids: List of document IDs to read
            offset: Start position in characters
            limit: Maximum characters to return
            run_manager: Callback manager

        Returns:
            JSON string with document contents
        """
        try:
            add_span_event("reading_documents")
            log_large_string_list("document_ids", [str(d) for d in document_ids])
            set_span_attribute("offset", offset)
            set_span_attribute("limit", limit)

            # Check call limit if counter is set
            if self._call_counter:
                allowed, error_msg = self._call_counter.check_and_increment()
                if not allowed:
                    return error_msg

            if not document_ids:
                return json.dumps(
                    {"error": "No document IDs provided"}, ensure_ascii=False
                )
            if not self.knowledge_base_ids:
                return json.dumps(
                    {"error": "No accessible knowledge bases configured"},
                    ensure_ascii=False,
                )
            violation = self._validate_scoped_document_ids(document_ids)
            if violation:
                return violation

            logger.info(
                f"[KbHeadTool] Reading {len(document_ids)} documents, offset={offset}, limit={limit}"
            )

            # Try package mode first (direct DB access)
            try:
                return await self._read_docs_package_mode(document_ids, offset, limit)
            except ImportError:
                # Fall back to HTTP mode
                return await self._read_docs_http_mode(document_ids, offset, limit)

        except Exception as e:
            logger.error(f"[KbHeadTool] Failed to read documents: {e}", exc_info=True)
            return json.dumps(
                {"error": f"Failed to read documents: {str(e)}"}, ensure_ascii=False
            )

    def _validate_scoped_document_ids(self, document_ids: list[int]) -> str | None:
        """Reject obvious scoped-only document access violations before IO."""
        restricted_scopes = [
            scope for scope in self.knowledge_base_scopes if scope.scope_restricted
        ]
        if not restricted_scopes:
            return None
        has_unscoped_scope = any(
            not scope.scope_restricted for scope in self.knowledge_base_scopes
        )
        if has_unscoped_scope:
            return None
        allowed_document_ids = {
            document_id
            for scope in restricted_scopes
            for document_id in scope.document_ids
        }
        out_of_scope = [
            document_id
            for document_id in document_ids
            if document_id not in allowed_document_ids
        ]
        if not out_of_scope:
            return None
        return _format_scope_violation(
            "Requested documents are outside the allowed knowledge scope."
        )

    @trace_async(
        span_name="kb_head_read_docs_package_mode",
        tracer_name="chat_shell.tools.kb_head",
    )
    async def _read_docs_package_mode(
        self, document_ids: list[int], offset: int, limit: int
    ) -> str:
        """Read documents using direct database access."""
        import asyncio

        from app.services.knowledge.document_read_service import document_read_service

        # Check if we have a sync session with query method
        if not hasattr(self.db_session, "query"):
            raise ImportError(
                "Package mode requires sync SQLAlchemy session with query method"
            )

        add_span_event("reading_documents")
        log_large_string_list("document_ids", [str(d) for d in document_ids])
        set_span_attribute("offset", offset)
        set_span_attribute("limit", limit)
        set_span_attribute("mode", "package")

        persistence_kwargs = {}
        if self.user_subtask_id and self.user_id > 0:
            persistence_kwargs = {
                "user_subtask_id": self.user_subtask_id,
                "user_id": self.user_id,
            }

        scope_violation = await self._validate_scoped_document_ids_package_mode(
            document_ids
        )
        if scope_violation:
            return scope_violation

        results = await asyncio.to_thread(
            document_read_service.read_documents,
            self.db_session,
            document_ids=document_ids,
            offset=offset,
            limit=limit,
            knowledge_base_ids=self.knowledge_base_ids or None,
            **persistence_kwargs,
        )

        set_span_attribute("document_count", len(results))

        logger.info(f"[KbHeadTool] Read {len(results)} documents (package mode)")

        return json.dumps({"documents": results}, ensure_ascii=False)

    async def _validate_scoped_document_ids_package_mode(
        self,
        document_ids: list[int],
    ) -> str | None:
        """Validate requested document IDs against per-KB scopes in package mode."""
        if not self.knowledge_base_scopes:
            return None
        if not hasattr(self.db_session, "query"):
            return None

        import asyncio

        from app.models.knowledge import KnowledgeDocument

        scope_by_kb = {
            scope.knowledge_base_id: scope for scope in self.knowledge_base_scopes
        }

        def _load_doc_kbs() -> dict[int, int]:
            rows = (
                self.db_session.query(KnowledgeDocument.id, KnowledgeDocument.kind_id)
                .filter(KnowledgeDocument.id.in_(document_ids))
                .all()
            )
            return {doc_id: kb_id for doc_id, kb_id in rows}

        doc_kb_map = await asyncio.to_thread(_load_doc_kbs)
        for document_id in document_ids:
            kb_id = doc_kb_map.get(document_id)
            scope = scope_by_kb.get(kb_id)
            if scope is None:
                return _format_scope_violation(
                    "Requested documents are outside the allowed knowledge scope."
                )
            if scope.scope_restricted and document_id not in scope.document_ids:
                return _format_scope_violation(
                    "Requested documents are outside the allowed knowledge scope."
                )
        return None

    @trace_async(
        span_name="kb_head_read_docs_http_mode", tracer_name="chat_shell.tools.kb_head"
    )
    async def _read_docs_http_mode(
        self, document_ids: list[int], offset: int, limit: int
    ) -> str:
        """Read documents via HTTP API."""
        import httpx

        add_span_event("reading_documents")
        log_large_string_list("document_ids", [str(d) for d in document_ids])
        set_span_attribute("offset", offset)
        set_span_attribute("limit", limit)
        set_span_attribute("mode", "http")

        backend_url = _get_backend_url()
        request_data: dict[str, Any] = {
            "document_ids": document_ids,
            "offset": offset,
            "limit": limit,
        }
        if self.knowledge_base_ids:
            request_data["knowledge_base_ids"] = self.knowledge_base_ids
        if self.knowledge_base_scopes:
            request_data["knowledge_base_scopes"] = _scope_payloads(
                self.knowledge_base_scopes
            )
        if self.user_subtask_id and self.user_id > 0:
            request_data["persistence_context"] = {
                "user_subtask_id": self.user_subtask_id,
                "user_id": self.user_id,
                "restricted_mode": False,
            }

        add_span_event("http_request_started")

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{backend_url}/api/internal/rag/read-docs",
                **_build_backend_post_kwargs(request_data, self.auth_token),
            )

            if response.status_code != 200:
                logger.warning(
                    f"[KbHeadTool] HTTP read-docs returned {response.status_code}"
                )
                try:
                    error_detail = response.json().get("detail")
                    if (
                        isinstance(error_detail, dict)
                        and error_detail.get("error_code") == "document_scope_violation"
                    ):
                        return json.dumps(
                            {
                                "status": "error",
                                "error_code": "document_scope_violation",
                                "message": error_detail.get(
                                    "message",
                                    "Requested documents are outside the allowed knowledge scope.",
                                ),
                            },
                            ensure_ascii=False,
                        )
                except Exception:
                    pass
                return json.dumps(
                    {"error": f"Failed to read documents: HTTP {response.status_code}"},
                    ensure_ascii=False,
                )

            data = response.json()
            results = data.get("documents", [])

        set_span_attribute("document_count", len(results))

        logger.info(f"[KbHeadTool] Read {len(results)} documents (HTTP mode)")

        return json.dumps({"documents": results}, ensure_ascii=False)
