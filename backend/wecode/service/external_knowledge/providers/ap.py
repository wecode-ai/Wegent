# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""AP external knowledge browse provider."""

from urllib.parse import urlparse

from app.schemas.external_knowledge import (
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeRef,
)
from app.services.rag.sources import (
    ExternalKnowledgeDocument,
    ExternalKnowledgeDocumentListResult,
    ExternalRefValidationError,
    RetrievalContext,
    RetrievalSourceResult,
    RetrievalSourceStatus,
    RetrievalSourceSummary,
)
from wecode.config.external_knowledge_config import ExternalKnowledgeSettings
from wecode.schemas.external_knowledge import (
    ExternalKbNode,
    ExternalKbNodesResponse,
    ExternalKnowledgeBase,
    ExternalKnowledgeBaseListResponse,
    ExternalSearchRecord,
    ExternalSearchResult,
)
from wecode.service.erp_entity_resolver import (
    EmployeeIdResolutionStatus,
    ErpEntityResolver,
)
from wecode.service.external_knowledge.base import ExternalKnowledgeProvider, RawNode
from wecode.service.external_knowledge.client import ApKnowledgeMcpClient
from wecode.service.external_knowledge.exceptions import (
    ExternalKnowledgeEmployeeRequiredError,
    ExternalKnowledgeEmployeeResolutionUnavailableError,
    ExternalKnowledgeError,
    ExternalKnowledgeNotConfiguredError,
)

LIST_KNOWLEDGE_BASES_TOOL = "ks_kb_list_knowledge_bases"
LIST_NODES_TOOL = "ks_kb_list_nodes"
SEARCH_CONTENT_TOOL = "ks_kb_search_content"
RAW_PREVIEW_URL_FIELD = "browser_open_url"
MAX_SEARCH_KNOWLEDGE_BASES = 100
DEFAULT_RETRIEVAL_MAX_RESULTS = 10
LIST_DOCUMENTS_NODE_PAGE_SIZE = 500
PREVIEW_NODE_PAGE_SIZE = 500
MAX_PREVIEW_NODE_SCAN_PAGES = 20
DINGTALK_PREVIEW_HOST = "dingtalk.com"


class ApExternalKnowledgeProvider(ExternalKnowledgeProvider):
    """AP implementation of the external knowledge browse provider."""

    name = "ap"

    def __init__(
        self,
        settings: ExternalKnowledgeSettings,
        client: ApKnowledgeMcpClient | None = None,
    ) -> None:
        self._settings = settings
        self._client = client or ApKnowledgeMcpClient(settings)
        self._erp_resolver = ErpEntityResolver()

    async def health(self) -> bool:
        return await self._client.health()

    async def list_knowledge_bases(
        self,
        employee_id: str,
        *,
        scope: str,
        query: str | None,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeBaseListResponse:
        self._ensure_configured()
        arguments = {
            "scope": scope,
            "limit": limit,
            "offset": offset,
        }
        if query:
            arguments["query"] = query
        payload = await self._client.call_tool(
            LIST_KNOWLEDGE_BASES_TOOL,
            arguments,
            employee_id,
        )
        return ExternalKnowledgeBaseListResponse(
            provider=self.name,
            total=int(payload.get("total") or 0),
            total_returned=int(payload.get("total_returned") or 0),
            has_more=bool(payload.get("has_more")),
            limit=int(payload.get("limit") or limit),
            offset=int(payload.get("offset") or offset),
            items=[
                self._map_knowledge_base(item) for item in payload.get("items") or []
            ],
        )

    async def list_nodes(
        self,
        employee_id: str,
        *,
        kb_id: str,
        folder_id: str | None,
        recursive: bool,
        limit: int,
        offset: int,
    ) -> ExternalKbNodesResponse:
        self._ensure_configured()
        payload = await self._list_nodes_raw(
            employee_id,
            kb_id=kb_id,
            folder_id=folder_id,
            recursive=recursive,
            limit=limit,
            offset=offset,
        )
        return self._map_nodes_response(
            payload,
            fallback_kb_id=kb_id,
            include_preview_url=True,
        )

    async def search(
        self,
        employee_id: str,
        *,
        query: str,
        knowledge_base_ids: list[str],
        max_results: int,
    ) -> ExternalSearchResult:
        self._ensure_configured()
        payload = await self._client.call_tool(
            SEARCH_CONTENT_TOOL,
            {
                "query": query,
                "knowledge_base_ids": knowledge_base_ids,
                "max_results": max_results,
            },
            employee_id,
        )
        return ExternalSearchResult(
            provider=self.name,
            query=str(payload.get("query") or query),
            total=int(payload.get("total") or 0),
            records=[
                self._map_search_record(item) for item in payload.get("records") or []
            ],
            searched_knowledge_base_ids=[
                str(item) for item in payload.get("searched_knowledge_base_ids") or []
            ],
            ignored_knowledge_base_ids=[
                str(item) for item in payload.get("ignored_knowledge_base_ids") or []
            ],
            warnings=[str(item) for item in payload.get("warnings") or []],
        )

    async def retrieve(
        self,
        query: str,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
    ) -> RetrievalSourceResult:
        self._ensure_configured()
        employee_id = self._resolve_employee_id(ctx.user_id)
        resolved = await self._resolve_retrieval_kb_ids(employee_id, refs)
        if not resolved.search_ids:
            return RetrievalSourceResult(
                records=[],
                summary=RetrievalSourceSummary(
                    provider=self.name,
                    searched_source_ids=[],
                    ignored_source_ids=resolved.ignored_ids,
                    source_statuses=[
                        RetrievalSourceStatus(
                            provider=self.name,
                            source_id=source_id,
                            source_name=self._ref_name_by_source_id(refs).get(
                                source_id
                            ),
                            status="ignored",
                        )
                        for source_id in resolved.ignored_ids
                    ],
                ),
                warnings=resolved.warnings,
            )

        result = await self.search(
            employee_id,
            query=query,
            knowledge_base_ids=resolved.search_ids,
            max_results=DEFAULT_RETRIEVAL_MAX_RESULTS,
        )
        records = result.records
        ignored_ids = list(
            dict.fromkeys(resolved.ignored_ids + result.ignored_knowledge_base_ids)
        )
        searched_ids = result.searched_knowledge_base_ids or resolved.search_ids
        record_counts = self._count_records_by_source(records)
        record_names = self._record_names_by_source(records)
        ref_names = self._ref_name_by_source_id(refs)
        return RetrievalSourceResult(
            records=[self._map_retrieve_record(record) for record in records],
            summary=RetrievalSourceSummary(
                provider=self.name,
                searched_source_ids=searched_ids,
                ignored_source_ids=ignored_ids,
                source_statuses=[
                    RetrievalSourceStatus(
                        provider=self.name,
                        source_id=source_id,
                        source_name=record_names.get(source_id)
                        or ref_names.get(source_id),
                        status=(
                            "hit" if record_counts.get(source_id, 0) > 0 else "no_hit"
                        ),
                        record_count=record_counts.get(source_id, 0),
                    )
                    for source_id in searched_ids
                ]
                + [
                    RetrievalSourceStatus(
                        provider=self.name,
                        source_id=source_id,
                        source_name=ref_names.get(source_id),
                        status="ignored",
                    )
                    for source_id in ignored_ids
                ],
            ),
            warnings=resolved.warnings + result.warnings,
        )

    async def list_documents(
        self,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
        *,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeDocumentListResult:
        self._ensure_configured()
        employee_id = self._resolve_employee_id(ctx.user_id)
        resolved = await self._resolve_retrieval_kb_ids(employee_id, refs)
        if not resolved.search_ids:
            return ExternalKnowledgeDocumentListResult(
                documents=[],
                warnings=resolved.warnings,
            )

        documents: list[ExternalKnowledgeDocument] = []
        for kb_id in resolved.search_ids:
            documents.extend(
                await self._list_documents_from_kb(
                    employee_id,
                    kb_id=kb_id,
                    stop_after=offset + limit,
                )
            )
            if len(documents) >= offset + limit:
                break

        page = documents[offset : offset + limit]
        return ExternalKnowledgeDocumentListResult(
            documents=page,
            warnings=resolved.warnings,
        )

    async def _list_documents_from_kb(
        self,
        employee_id: str,
        *,
        kb_id: str,
        stop_after: int,
    ) -> list[ExternalKnowledgeDocument]:
        documents: list[ExternalKnowledgeDocument] = []
        node_offset = 0
        while True:
            payload = await self._list_nodes_raw(
                employee_id,
                kb_id=kb_id,
                folder_id=None,
                recursive=True,
                limit=LIST_DOCUMENTS_NODE_PAGE_SIZE,
                offset=node_offset,
            )
            items = payload.get("items") or []
            kb_name = payload.get("knowledge_base_name")
            kb_documents = self._flatten_document_nodes(
                items,
                kb_id=kb_id,
                kb_name=kb_name,
            )
            documents.extend(kb_documents)

            returned = int(payload.get("total_returned") or len(items))
            if len(documents) >= stop_after or not payload.get("has_more"):
                break
            if returned <= 0:
                break
            node_offset += returned

        return documents

    def validate_refs(
        self,
        refs: list[ExternalKnowledgeRef],
        *,
        binding_level: ExternalKnowledgeBindingLevel,
    ) -> None:
        del binding_level
        self._ensure_whole_kb_refs(refs)
        explicit_ids = {
            ref.id for ref in refs if ref.mode == "explicit" and ref.id is not None
        }
        if len(explicit_ids) > MAX_SEARCH_KNOWLEDGE_BASES:
            raise ExternalRefValidationError(
                "AP explicit knowledge base selection exceeds the 100 source limit"
            )

    async def resolve_preview_url(
        self,
        employee_id: str,
        *,
        kb_id: str,
        node_id: str | None,
        document_id: str | None,
        folder_id: str | None,
    ) -> str:
        self._ensure_configured()
        if node_id:
            node = await self._find_preview_node_across_pages(
                employee_id,
                kb_id=kb_id,
                folder_id=folder_id,
                recursive=False,
                node_id=node_id,
                document_id=None,
                max_pages=1 if folder_id is None else MAX_PREVIEW_NODE_SCAN_PAGES,
            )
            if not node and folder_id is None:
                node = await self._find_preview_node_across_pages(
                    employee_id,
                    kb_id=kb_id,
                    folder_id=None,
                    recursive=True,
                    node_id=node_id,
                    document_id=None,
                )
        elif document_id:
            node = await self._find_preview_node_across_pages(
                employee_id,
                kb_id=kb_id,
                folder_id=None,
                recursive=True,
                node_id=None,
                document_id=document_id,
            )
        else:
            raise ExternalKnowledgeError(
                "node_id or document_id is required",
                code="bad_request",
                status_code=400,
            )

        if not node:
            raise ExternalKnowledgeError(
                "Preview target was not found or is no longer accessible",
                code="not_found",
                status_code=404,
            )

        url = str(node.get(RAW_PREVIEW_URL_FIELD) or "")
        if not url:
            raise ExternalKnowledgeError(
                "Preview URL is unavailable for this document",
                code="not_found",
                status_code=404,
            )
        return url

    async def _find_preview_node_across_pages(
        self,
        employee_id: str,
        *,
        kb_id: str,
        folder_id: str | None,
        recursive: bool,
        node_id: str | None,
        document_id: str | None,
        max_pages: int = MAX_PREVIEW_NODE_SCAN_PAGES,
    ) -> RawNode | None:
        offset = 0
        for _ in range(max_pages):
            payload = await self._list_nodes_raw(
                employee_id,
                kb_id=kb_id,
                folder_id=folder_id,
                recursive=recursive,
                limit=PREVIEW_NODE_PAGE_SIZE,
                offset=offset,
            )
            items = payload.get("items") or []
            node = self._find_preview_node(items, node_id, document_id)
            if node:
                return node

            returned = int(payload.get("total_returned") or len(items))
            if not payload.get("has_more") or returned <= 0 or not items:
                return None
            offset += returned

        return None

    def classify_preview_mode(self, url: str) -> str:
        host = (urlparse(url).hostname or "").lower()
        iframe_hosts = {
            configured_host.lower()
            for configured_host in self._settings.AP_KNOWLEDGE_IFRAME_HOSTS
        }
        if host in iframe_hosts:
            return "iframe"
        if host == DINGTALK_PREVIEW_HOST or host.endswith(f".{DINGTALK_PREVIEW_HOST}"):
            return "new_tab"
        return "new_tab"

    def raw_debug_fields(self) -> set[str]:
        return {RAW_PREVIEW_URL_FIELD}

    def build_source_uri(self, kb_id: str, document_id: str) -> str:
        return f"ap://{kb_id}/{document_id}"

    def _ensure_configured(self) -> None:
        if not self._client.configured:
            raise ExternalKnowledgeNotConfiguredError(
                "AP knowledge system token is not configured"
            )

    def _resolve_employee_id(self, user_id: int) -> str:
        if not user_id:
            raise ExternalKnowledgeEmployeeRequiredError()

        result = self._erp_resolver.resolve_employee_id_result_for_user(user_id)
        if result.employee_id:
            return result.employee_id
        if result.status in {
            EmployeeIdResolutionStatus.IN_PROGRESS,
            EmployeeIdResolutionStatus.UNAVAILABLE,
        }:
            raise ExternalKnowledgeEmployeeResolutionUnavailableError()
        raise ExternalKnowledgeEmployeeRequiredError()

    async def _resolve_retrieval_kb_ids(
        self,
        employee_id: str,
        refs: list[ExternalKnowledgeRef],
    ) -> "_ResolvedRetrievalSources":
        del employee_id
        self._ensure_whole_kb_refs(refs)
        explicit_ids = [ref.id for ref in refs if ref.mode == "explicit" and ref.id]
        explicit_ids = list(dict.fromkeys(explicit_ids))
        if len(explicit_ids) > MAX_SEARCH_KNOWLEDGE_BASES:
            raise ExternalKnowledgeError(
                "AP explicit knowledge base selection exceeds the 100 source limit",
                code="bad_request",
                status_code=400,
            )

        return _ResolvedRetrievalSources(search_ids=explicit_ids)

    def _map_retrieve_record(self, record: ExternalSearchRecord):
        from app.api.endpoints.internal.rag import RetrieveRecord

        return RetrieveRecord(
            content=record.content,
            score=record.score,
            title=record.title,
            metadata={
                "provider": self.name,
                "document_id": record.document_id,
                "knowledge_base_id": record.knowledge_base_id,
            },
            source_type=self.name,
            source_id=record.knowledge_base_id,
            source_uri=record.source_uri,
            source_name=record.knowledge_base_name,
        )

    @staticmethod
    def _ensure_whole_kb_refs(refs: list[ExternalKnowledgeRef]) -> None:
        if any(ref.target_type not in (None, "knowledge_base") for ref in refs):
            raise ExternalRefValidationError(
                "AP supports whole knowledge base selection only"
            )

    @staticmethod
    def _count_records_by_source(
        records: list[ExternalSearchRecord],
    ) -> dict[str, int]:
        counts: dict[str, int] = {}
        for record in records:
            counts[record.knowledge_base_id] = (
                counts.get(record.knowledge_base_id, 0) + 1
            )
        return counts

    @staticmethod
    def _record_names_by_source(
        records: list[ExternalSearchRecord],
    ) -> dict[str, str]:
        names: dict[str, str] = {}
        for record in records:
            if record.knowledge_base_name:
                names.setdefault(record.knowledge_base_id, record.knowledge_base_name)
        return names

    @staticmethod
    def _ref_name_by_source_id(refs: list[ExternalKnowledgeRef]) -> dict[str, str]:
        names: dict[str, str] = {}
        for ref in refs:
            if ref.id and ref.name:
                names.setdefault(ref.id, ref.name)
        return names

    async def _list_nodes_raw(
        self,
        employee_id: str,
        *,
        kb_id: str,
        folder_id: str | None,
        recursive: bool,
        limit: int,
        offset: int,
    ) -> dict:
        arguments = {
            "knowledge_base_id": kb_id,
            "recursive": recursive,
            "limit": limit,
            "offset": offset,
        }
        if folder_id:
            arguments["folder_id"] = folder_id
        return await self._client.call_tool(LIST_NODES_TOOL, arguments, employee_id)

    def _map_knowledge_base(self, item: dict) -> ExternalKnowledgeBase:
        return ExternalKnowledgeBase(
            provider=self.name,
            knowledge_base_id=str(item.get("knowledge_base_id") or ""),
            knowledge_base_name=str(item.get("knowledge_base_name") or ""),
            description=item.get("description"),
            scope=str(item.get("scope") or ""),
            owner_id=item.get("owner_id"),
            employee_id=item.get("employee_id"),
            document_count=int(item.get("document_count") or 0),
            created_at=item.get("created_at"),
            updated_at=item.get("updated_at"),
        )

    def _map_nodes_response(
        self,
        payload: dict,
        *,
        fallback_kb_id: str,
        include_preview_url: bool = False,
    ) -> ExternalKbNodesResponse:
        return ExternalKbNodesResponse(
            provider=self.name,
            knowledge_base_id=str(payload.get("knowledge_base_id") or fallback_kb_id),
            knowledge_base_name=payload.get("knowledge_base_name"),
            owner_id=payload.get("owner_id"),
            employee_id=payload.get("employee_id"),
            folder_id=payload.get("folder_id"),
            recursive=bool(payload.get("recursive")),
            total_returned=int(payload.get("total_returned") or 0),
            total_available=int(payload.get("total_available") or 0),
            has_more=bool(payload.get("has_more")),
            warnings=[str(item) for item in payload.get("warnings") or []],
            items=[
                self._map_node(item, include_preview_url=include_preview_url)
                for item in payload.get("items") or []
            ],
        )

    def _map_node(
        self, item: dict, *, include_preview_url: bool = False
    ) -> ExternalKbNode:
        preview_url = (
            str(item.get(RAW_PREVIEW_URL_FIELD) or "") or None
            if include_preview_url
            else None
        )
        return ExternalKbNode(
            node_id=str(item.get("node_id") or ""),
            raw_id=str(item.get("raw_id") or ""),
            name=str(item.get("name") or ""),
            node_type=str(item.get("node_type") or ""),
            parent_id=item.get("parent_id"),
            has_children=bool(item.get("has_children")),
            children=[
                self._map_node(child, include_preview_url=include_preview_url)
                for child in item.get("children") or []
            ],
            owner_id=item.get("owner_id"),
            employee_id=item.get("employee_id"),
            owner_name=item.get("owner_name"),
            previewable=bool(item.get("previewable")),
            content_readable=bool(item.get("content_readable")),
            downloadable=bool(item.get("downloadable")),
            mime_type=item.get("mime_type"),
            source_type=item.get("source_type"),
            index_status=item.get("index_status"),
            file_extension=item.get("file_extension"),
            file_size=item.get("file_size"),
            browser_open_url=preview_url,
            preview=self.build_preview(preview_url),
        )

    def _map_search_record(self, item: dict) -> ExternalSearchRecord:
        kb_id = str(item.get("knowledge_base_id") or "")
        document_id = str(item.get("document_id") or "")
        return ExternalSearchRecord(
            content=str(item.get("content") or ""),
            title=str(item.get("title") or ""),
            score=item.get("score"),
            knowledge_base_id=kb_id,
            knowledge_base_name=item.get("knowledge_base_name"),
            document_id=document_id,
            owner_id=item.get("owner_id"),
            employee_id=item.get("employee_id"),
            source_uri=self.build_source_uri(kb_id, document_id),
        )

    def _find_preview_node(
        self,
        nodes: list[RawNode],
        node_id: str | None,
        document_id: str | None,
    ) -> RawNode | None:
        for node in nodes:
            if node_id and node.get("node_id") == node_id:
                return node
            if document_id and node.get("raw_id") == document_id:
                return node
            child = self._find_preview_node(
                node.get("children") or [], node_id, document_id
            )
            if child:
                return child
        return None

    def _flatten_document_nodes(
        self,
        nodes: list[RawNode],
        *,
        kb_id: str,
        kb_name: str | None,
    ) -> list[ExternalKnowledgeDocument]:
        documents: list[ExternalKnowledgeDocument] = []
        for node in nodes:
            if str(node.get("node_type") or "") == "document":
                document_id = str(node.get("raw_id") or node.get("node_id") or "")
                documents.append(
                    ExternalKnowledgeDocument(
                        provider=self.name,
                        source_id=kb_id,
                        source_name=kb_name,
                        document_id=document_id,
                        title=str(node.get("name") or ""),
                        node_id=str(node.get("node_id") or "") or None,
                        parent_id=node.get("parent_id"),
                        mime_type=node.get("mime_type"),
                        file_extension=node.get("file_extension"),
                        source_uri=self.build_source_uri(kb_id, document_id),
                    )
                )
            documents.extend(
                self._flatten_document_nodes(
                    node.get("children") or [],
                    kb_id=kb_id,
                    kb_name=kb_name,
                )
            )
        return documents


class _ResolvedRetrievalSources:
    def __init__(
        self,
        *,
        search_ids: list[str],
        ignored_ids: list[str] | None = None,
        warnings: list[str] | None = None,
    ) -> None:
        self.search_ids = search_ids
        self.ignored_ids = ignored_ids or []
        self.warnings = warnings or []
