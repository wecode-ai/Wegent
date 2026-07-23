# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk external knowledge retrieval source provider."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.dingtalk_doc import DingTalkNodeSource, DingtalkSyncedNode
from app.models.user import User
from app.schemas.external_knowledge import external_ref_canonical_key
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_mcp_client import (
    DingTalkDocsMcpClient,
    DingTalkDocumentContent,
    DingTalkMcpError,
)
from app.services.rag.sources.models import (
    ExternalKnowledgeDocument,
    ExternalKnowledgeDocumentListResult,
    ExternalProviderCapabilities,
    ExternalRefGateRequest,
    ExternalRefValidationError,
    ExternalRefValidationResult,
    RetrievalContext,
    RetrievalSourceResult,
    RetrievalSourceStatus,
    RetrievalSourceSummary,
)
from app.services.rag.sources.registry import retrieval_source_registry

DOCS_CONTAINER_ID = "docs"
MAX_SEARCH_CANDIDATES = 10
MAX_SEARCH_PAGES = 2
MAX_DOCUMENT_CONTENT_REQUESTS = 10
MAX_MCP_CONCURRENCY = 3
MAX_ALLOWLIST_DESCENDANTS = 10_000
MAX_ALLOWLIST_DEPTH = 100
# Docs MCP currently returns markdown content only for DingTalk online documents.
READABLE_CONTENT_TYPES = frozenset({"adoc"})
CONTENT_TYPE_ALIASES = {"alidoc": "adoc"}
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PreparedRef:
    """Locally authorized DingTalk ref ready for runtime retrieval."""

    ref: Any
    source_id: str
    source_name: str | None
    canonical_ref_key: str
    allowed_node_ids: set[str]
    readable_node_ids: set[str]
    workspace_ids: list[str]


class DingTalkRetrievalSourceProvider:
    """DingTalk provider backed by the synced-node catalog as an allowlist."""

    name = "dingtalk"
    capabilities = ExternalProviderCapabilities(
        enforces_per_user_access=True,
        supports_virtual_containers=True,
    )

    async def retrieve(
        self,
        query: str,
        refs,
        ctx: RetrievalContext,
    ) -> RetrievalSourceResult:
        """Retrieve bounded DingTalk document content for the selected refs."""
        db = SessionLocal()
        records: list[Any] = []
        statuses: list[RetrievalSourceStatus] = []
        warnings: list[str] = []
        searched_source_ids: list[str] = []
        ignored_source_ids: list[str] = []
        try:
            user = db.query(User).filter(User.id == ctx.user_id).first()
            if not user:
                for ref in refs:
                    source_id = ref.id or DOCS_CONTAINER_ID
                    statuses.append(
                        _source_status(ref, source_id, _ref_name(ref), "ignored", 0)
                    )
                    ignored_source_ids.append(source_id)
                warnings.append("Current user was not found")
            else:
                prepared_refs: list[_PreparedRef] = []
                for ref in refs:
                    source_id = ref.id or DOCS_CONTAINER_ID
                    source_name = _ref_name(ref)
                    nodes = _find_matching_nodes(db, ctx.user_id, ref)
                    if not nodes:
                        ignored_source_ids.append(source_id)
                        statuses.append(
                            _source_status(ref, source_id, source_name, "ignored", 0)
                        )
                        warnings.append(_missing_catalog_warning(ref))
                        continue
                    allowed_node_ids = _allowed_node_ids(db, ctx.user_id, ref, nodes)
                    workspace_ids = _workspace_ids(nodes)
                    if (
                        _source_for_ref(ref) == DingTalkNodeSource.DOCS
                        and not _is_document_ref(ref)
                        and not workspace_ids
                    ):
                        statuses.append(
                            _source_status(
                                ref,
                                source_id,
                                source_name,
                                "failed",
                                0,
                                reason="scope_sync_required",
                            )
                        )
                        warnings.append(_missing_docs_workspace_warning())
                        continue
                    prepared_refs.append(
                        _PreparedRef(
                            ref=ref,
                            source_id=source_id,
                            source_name=source_name,
                            canonical_ref_key=external_ref_canonical_key(ref),
                            allowed_node_ids=allowed_node_ids,
                            readable_node_ids=_readable_node_ids(
                                db, ctx.user_id, ref, allowed_node_ids
                            ),
                            workspace_ids=workspace_ids,
                        )
                    )

                mcp_url = DingTalkDocService.get_user_dingtalk_mcp_url(user)
                if not mcp_url:
                    for prepared in prepared_refs:
                        statuses.append(
                            _source_status(
                                prepared.ref,
                                prepared.source_id,
                                prepared.source_name,
                                "failed",
                                0,
                            )
                        )
                    if prepared_refs:
                        warnings.append("DingTalk Docs MCP is not configured")
                else:
                    client = DingTalkDocsMcpClient(mcp_url)
                    batch_refs = [
                        ref for ref in prepared_refs if _is_batchable_wikispace(ref)
                    ]
                    batch_outcomes: dict[str, tuple[list[Any], list[str], bool]] = {}
                    if len(batch_refs) > 1:
                        try:
                            batch_outcomes = await _retrieve_wikispace_batch(
                                client=client, query=query, prepared_refs=batch_refs
                            )
                        except DingTalkMcpError:
                            # A rejected or incomplete batch contract falls back to the
                            # existing, independently scoped retrieval path.
                            batch_outcomes = {}

                    for prepared in prepared_refs:
                        outcome = batch_outcomes.get(prepared.canonical_ref_key)
                        if outcome is None:
                            outcome = await _retrieve_single_prepared_ref(
                                client, query, prepared
                            )
                        source_records, retrieval_warnings, failed = outcome
                        if failed:
                            warnings.extend(retrieval_warnings)
                            statuses.append(
                                _source_status(
                                    prepared.ref,
                                    prepared.source_id,
                                    prepared.source_name,
                                    "failed",
                                    0,
                                )
                            )
                        else:
                            searched_source_ids.append(prepared.source_id)
                            records.extend(source_records)
                            warnings.extend(retrieval_warnings)
                            statuses.append(
                                _source_status(
                                    prepared.ref,
                                    prepared.source_id,
                                    prepared.source_name,
                                    "hit" if source_records else "no_hit",
                                    len(source_records),
                                )
                            )
        finally:
            db.close()

        return RetrievalSourceResult(
            records=records,
            summary=RetrievalSourceSummary(
                provider=self.name,
                searched_source_ids=list(dict.fromkeys(searched_source_ids)),
                ignored_source_ids=list(dict.fromkeys(ignored_source_ids)),
                source_statuses=statuses,
            ),
            warnings=list(dict.fromkeys(warnings)),
        )

    async def list_documents(
        self,
        refs,
        ctx: RetrievalContext,
        *,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeDocumentListResult:
        """List selected synced DingTalk nodes for display-only inventory."""
        db = SessionLocal()
        try:
            documents: list[ExternalKnowledgeDocument] = []
            for ref in refs:
                for node in _find_matching_nodes(db, ctx.user_id, ref):
                    documents.append(
                        _node_to_document(ref.id or DOCS_CONTAINER_ID, node)
                    )
            return ExternalKnowledgeDocumentListResult(
                documents=documents[offset : offset + limit]
            )
        finally:
            db.close()

    def validate_refs(self, *, gate: ExternalRefGateRequest) -> None:
        """Validate local access scope and the Docs MCP content dependency."""
        for result in self.validate_refs_batch(gate=gate):
            if not result.is_valid:
                raise ExternalRefValidationError(
                    result.message or "DingTalk knowledge ref is unavailable",
                    reason=result.reason or "invalid_selection",
                )

    def validate_refs_batch(
        self,
        *,
        gate: ExternalRefGateRequest,
    ) -> list[ExternalRefValidationResult]:
        """Validate every DingTalk ref in one provider call."""
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == gate.actor_user_id).first()
            if not user:
                return [
                    ExternalRefValidationResult(
                        ref=ref,
                        reason="access_denied",
                        message="Current user was not found",
                    )
                    for ref in gate.refs
                ]

            if not DingTalkDocService.is_configured(user):
                return [
                    ExternalRefValidationResult(
                        ref=ref,
                        reason="not_configured",
                        message="DingTalk Docs MCP is not configured",
                    )
                    for ref in gate.refs
                ]

            results: list[ExternalRefValidationResult] = []
            for ref in gate.refs:
                if not _find_matching_nodes(db, gate.actor_user_id, ref):
                    results.append(
                        ExternalRefValidationResult(
                            ref=ref,
                            reason="inactive_or_deleted",
                            message=_missing_catalog_warning(ref),
                        )
                    )
                else:
                    results.append(ExternalRefValidationResult(ref=ref))
            return results
        finally:
            db.close()


async def _retrieve_single_prepared_ref(
    client: DingTalkDocsMcpClient,
    query: str,
    prepared: _PreparedRef,
) -> tuple[list[Any], list[str], bool]:
    """Run the established per-ref flow and convert failures to safe outcomes."""
    try:
        records, warnings = await _retrieve_ref_content(
            client=client,
            query=query,
            ref=prepared.ref,
            source_id=prepared.source_id,
            source_name=prepared.source_name,
            allowed_node_ids=prepared.allowed_node_ids,
            readable_node_ids=prepared.readable_node_ids,
            workspace_ids=prepared.workspace_ids,
        )
        return records, warnings, False
    except DingTalkMcpError as exc:
        logger.warning(
            "DingTalk Docs MCP retrieval failed for source %s: %s",
            prepared.source_id,
            exc.safe_message,
        )
        return [], [_mcp_warning(exc)], True
    except Exception:
        logger.warning(
            "Unexpected DingTalk Docs MCP retrieval failure for source %s",
            prepared.source_id,
        )
        return [], ["DingTalk Docs MCP content retrieval failed"], True


async def _retrieve_wikispace_batch(
    *,
    client: DingTalkDocsMcpClient,
    query: str,
    prepared_refs: list[_PreparedRef],
) -> dict[str, tuple[list[Any], list[str], bool]]:
    """Search complete WikiSpaces together, then keep local scope boundaries."""
    by_node_id = {
        node_id: prepared
        for prepared in prepared_refs
        for node_id in prepared.readable_node_ids
    }
    candidates: dict[str, dict[str, dict[str, Any]]] = {
        prepared.canonical_ref_key: {} for prepared in prepared_refs
    }
    page_token: str | None = None
    has_more = False
    for page_number in range(MAX_SEARCH_PAGES):
        page = await client.search_documents(
            keyword=query,
            workspace_ids=[prepared.source_id for prepared in prepared_refs],
            extensions=sorted(READABLE_CONTENT_TYPES),
            page_token=page_token,
            page_size=MAX_SEARCH_CANDIDATES,
        )
        has_more = page.has_more
        for document in page.documents:
            node_id = _record_node_id(document)
            if node_id is None:
                raise DingTalkMcpError(
                    "invalid_response",
                    "DingTalk Docs MCP search returned a document without node ID",
                )
            prepared = by_node_id.get(node_id)
            if (
                prepared is None
                or node_id not in prepared.allowed_node_ids
                or not _record_is_readable(document)
            ):
                continue
            workspace_id = document.get("workspaceId") or document.get("workspace_id")
            if workspace_id and str(workspace_id) != prepared.source_id:
                continue
            ref_candidates = candidates[prepared.canonical_ref_key]
            if len(ref_candidates) < MAX_DOCUMENT_CONTENT_REQUESTS:
                ref_candidates[node_id] = document
        if not has_more:
            break
        if page_number == MAX_SEARCH_PAGES - 1:
            break
        if not page.next_page_token:
            raise DingTalkMcpError(
                "capability_limitation",
                "DingTalk Docs MCP search pagination is unavailable",
            )
        page_token = page.next_page_token

    fallback_keys = (
        {
            prepared.canonical_ref_key
            for prepared in prepared_refs
            if not candidates[prepared.canonical_ref_key]
        }
        if has_more
        else set()
    )
    outcomes: dict[str, tuple[list[Any], list[str], bool]] = {}
    for prepared in prepared_refs:
        key = prepared.canonical_ref_key
        if key in fallback_keys:
            continue
        documents = list(candidates[key].values())
        if not documents:
            outcomes[key] = ([], [], False)
            continue
        outcomes[key] = await _read_batch_candidates(client, prepared, documents)
    return outcomes


async def _read_batch_candidates(
    client: DingTalkDocsMcpClient,
    prepared: _PreparedRef,
    documents: list[dict[str, Any]],
) -> tuple[list[Any], list[str], bool]:
    """Read one ref's deduplicated candidates without losing partial successes."""
    semaphore = asyncio.Semaphore(MAX_MCP_CONCURRENCY)

    async def read(document: dict[str, Any]) -> Any:
        node_id = _record_node_id(document)
        if node_id is None:
            raise DingTalkMcpError(
                "invalid_response", "DingTalk Docs MCP returned no node ID"
            )
        async with semaphore:
            content = await client.get_document_content(node_id=node_id)
        return _map_content_record(
            content,
            ref=prepared.ref,
            source_id=prepared.source_id,
            source_name=prepared.source_name,
            score=_record_score(document),
        )

    results = await asyncio.gather(
        *(read(document) for document in documents), return_exceptions=True
    )
    records = [result for result in results if not isinstance(result, Exception)]
    if not records:
        return [], [_mcp_warning(DingTalkMcpError("content_read_failed", ""))], True
    warnings = (
        ["Some DingTalk documents could not be retrieved"]
        if len(records) != len(results)
        else []
    )
    return records, warnings, False


def _is_batchable_wikispace(prepared: _PreparedRef) -> bool:
    """Only complete WikiSpace refs may share a global Docs MCP ranking."""
    return (
        _source_for_ref(prepared.ref) == DingTalkNodeSource.WIKISPACE
        and not _is_document_ref(prepared.ref)
        and prepared.ref.target_type in {None, "knowledge_base"}
    )


async def _retrieve_ref_content(
    *,
    client: DingTalkDocsMcpClient,
    query: str,
    ref,
    source_id: str,
    source_name: str | None,
    allowed_node_ids: set[str],
    readable_node_ids: set[str],
    workspace_ids: list[str],
) -> tuple[list[Any], list[str]]:
    """Resolve one ref using direct reads or bounded metadata search."""
    if _is_document_ref(ref):
        node_id = ref.document_id or ref.node_id
        if (
            not node_id
            or node_id not in allowed_node_ids
            or node_id not in readable_node_ids
        ):
            return [], []
        content = await client.get_document_content(node_id=node_id)
        return [
            _map_content_record(
                content,
                ref=ref,
                source_id=source_id,
                source_name=source_name,
            )
        ], []

    search_workspace_ids = (
        workspace_ids
        if _source_for_ref(ref) == DingTalkNodeSource.DOCS
        else [source_id]
    )
    candidates: list[dict[str, Any]] = []
    page_token: str | None = None
    for page_number in range(MAX_SEARCH_PAGES):
        search_page = await client.search_documents(
            keyword=query,
            workspace_ids=search_workspace_ids,
            extensions=sorted(READABLE_CONTENT_TYPES),
            page_token=page_token,
            page_size=MAX_SEARCH_CANDIDATES,
        )
        for document in search_page.documents:
            if _record_is_folder(document):
                continue
            node_id = _record_node_id(document)
            if node_id is None:
                raise DingTalkMcpError(
                    "invalid_response",
                    "DingTalk Docs MCP search returned a document without node ID",
                )
            if (
                node_id in allowed_node_ids
                and node_id in readable_node_ids
                and _record_is_readable(document)
            ):
                candidates.append(document)
        candidates = candidates[:MAX_DOCUMENT_CONTENT_REQUESTS]
        if candidates or not search_page.has_more:
            break
        if not search_page.next_page_token:
            raise DingTalkMcpError(
                "capability_limitation",
                "DingTalk Docs MCP search pagination is unavailable",
            )
        if page_number == MAX_SEARCH_PAGES - 1:
            raise DingTalkMcpError(
                "capability_limitation",
                "DingTalk Docs MCP search exceeded the bounded page limit",
            )
        page_token = search_page.next_page_token
    if not candidates:
        return [], []

    semaphore = asyncio.Semaphore(MAX_MCP_CONCURRENCY)

    async def read_candidate(document: dict[str, Any]) -> Any:
        node_id = _record_node_id(document)
        if node_id is None:
            raise DingTalkMcpError(
                "invalid_response",
                "DingTalk Docs MCP search returned a document without node ID",
            )
        async with semaphore:
            content = await client.get_document_content(node_id=node_id)
        return _map_content_record(
            content,
            ref=ref,
            source_id=source_id,
            source_name=source_name,
            score=_record_score(document),
        )

    results = await asyncio.gather(
        *(read_candidate(item) for item in candidates), return_exceptions=True
    )
    records = [result for result in results if not isinstance(result, Exception)]
    if not records:
        raise DingTalkMcpError(
            "content_read_failed", "DingTalk Docs MCP could not read matching documents"
        )
    warnings = (
        ["Some DingTalk documents could not be retrieved"]
        if len(records) != len(results)
        else []
    )
    return records, warnings


def _source_for_ref(ref) -> DingTalkNodeSource:
    if ref.id in {DOCS_CONTAINER_ID, "organization-docs"}:
        return DingTalkNodeSource.DOCS
    return DingTalkNodeSource.WIKISPACE


def _is_document_ref(ref) -> bool:
    return ref.target_type == "document" or bool(ref.document_id)


def _ref_name(ref) -> str:
    return ref.name or ref.target_name or ref.id or DOCS_CONTAINER_ID


def _missing_catalog_warning(ref) -> str:
    if ref.target_type == "knowledge_base" or not ref.target_type:
        return "DingTalk knowledge base is not available in the active synced directory"
    return "DingTalk document directory is not synced for the selected ref"


def _missing_docs_workspace_warning() -> str:
    """Return an actionable message without exposing provider details."""
    return "DingTalk personal document scope is missing; please resync DingTalk Docs"


def _mcp_warning(error: DingTalkMcpError) -> str:
    messages = {
        "tool_unavailable": "DingTalk Docs MCP tool is unavailable",
        "parameter_error": "DingTalk Docs MCP rejected the request parameters",
        "authentication_error": "DingTalk Docs MCP authentication failed",
        "timeout": "DingTalk Docs MCP request timed out",
        "invalid_response": "DingTalk Docs MCP returned an invalid response",
        "capability_limitation": "DingTalk Docs MCP search capability is limited",
    }
    return messages.get(error.code, "DingTalk Docs MCP content retrieval failed")


def _source_status(
    ref,
    source_id: str,
    source_name: str | None,
    status: str,
    record_count: int,
    *,
    reason: str | None = None,
) -> RetrievalSourceStatus:
    return RetrievalSourceStatus(
        provider="dingtalk",
        source_id=source_id,
        source_name=source_name,
        status=status,
        record_count=record_count,
        citation_count=record_count,
        canonical_ref_key=external_ref_canonical_key(ref),
        reason=reason,
    )


def _find_matching_nodes(
    db: Session,
    user_id: int,
    ref,
) -> list[DingtalkSyncedNode]:
    source = _source_for_ref(ref)
    query = db.query(DingtalkSyncedNode).filter(
        DingtalkSyncedNode.user_id == user_id,
        DingtalkSyncedNode.source == source.value,
        DingtalkSyncedNode.is_active == True,  # noqa: E712
    )
    if source == DingTalkNodeSource.WIKISPACE:
        query = query.filter(DingtalkSyncedNode.workspace_id == (ref.id or ""))
    node_identifiers = [
        value for value in (ref.node_id, ref.document_id) if value is not None
    ]
    if node_identifiers:
        query = query.filter(DingtalkSyncedNode.dingtalk_node_id.in_(node_identifiers))
    return query.all()


def _workspace_ids(nodes: list[DingtalkSyncedNode]) -> list[str]:
    """Return the non-empty provider workspace IDs recorded in the catalog."""
    return sorted(
        {
            str(node.workspace_id).strip()
            for node in nodes
            if node.workspace_id and str(node.workspace_id).strip()
        }
    )


def _allowed_node_ids(
    db: Session,
    user_id: int,
    ref,
    matched_nodes: list[DingtalkSyncedNode],
) -> set[str]:
    """Resolve the synced directory subtree used as the local allowlist."""
    node_ids = {node.dingtalk_node_id for node in matched_nodes}
    folder_ids = {
        node.dingtalk_node_id for node in matched_nodes if node.node_type == "folder"
    }
    if not folder_ids:
        return node_ids

    source = _source_for_ref(ref)
    query = db.query(DingtalkSyncedNode).filter(
        DingtalkSyncedNode.user_id == user_id,
        DingtalkSyncedNode.source == source.value,
        DingtalkSyncedNode.is_active == True,  # noqa: E712
    )
    if source == DingTalkNodeSource.WIKISPACE:
        query = query.filter(DingtalkSyncedNode.workspace_id == (ref.id or ""))

    frontier = set(folder_ids)
    depth = 0
    while frontier and depth < MAX_ALLOWLIST_DEPTH:
        children = query.filter(DingtalkSyncedNode.parent_node_id.in_(frontier)).all()
        next_frontier: set[str] = set()
        for node in children:
            if node.dingtalk_node_id in node_ids:
                continue
            node_ids.add(node.dingtalk_node_id)
            if len(node_ids) >= MAX_ALLOWLIST_DESCENDANTS:
                logger.warning(
                    "DingTalk allowlist expansion reached node limit: user_id=%s, "
                    "source=%s, source_id=%s",
                    user_id,
                    source.value,
                    ref.id,
                )
                return node_ids
            if node.node_type == "folder":
                next_frontier.add(node.dingtalk_node_id)
        frontier = next_frontier
        depth += 1
    if frontier:
        logger.warning(
            "DingTalk allowlist expansion reached depth limit: user_id=%s, "
            "source=%s, source_id=%s",
            user_id,
            source.value,
            ref.id,
        )
    return node_ids


def _record_node_id(record: dict[str, Any]) -> str | None:
    for key in ("nodeId", "node_id", "documentId", "document_id"):
        value = record.get(key)
        if value:
            return str(value)
    return None


def _record_is_folder(record: dict[str, Any]) -> bool:
    """Return whether a search result is a container that cannot be read."""
    values = (
        record.get("nodeType"),
        record.get("node_type"),
        record.get("extension"),
        record.get("contentType"),
    )
    return any(str(value).lower() == "folder" for value in values if value)


def _record_is_readable(record: dict[str, Any]) -> bool:
    """Verify Docs MCP did not return an unsupported document type."""
    for key in ("extension", "fileExtension", "file_extension"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return _normalized_content_type(value) in READABLE_CONTENT_TYPES
    return False


def _readable_node_ids(
    db: Session,
    user_id: int,
    ref,
    allowed_node_ids: set[str],
) -> set[str]:
    """Return allowlisted catalog nodes whose type Docs MCP can read."""
    if not allowed_node_ids:
        return set()
    source = _source_for_ref(ref)
    query = db.query(
        DingtalkSyncedNode.dingtalk_node_id, DingtalkSyncedNode.content_type
    ).filter(
        DingtalkSyncedNode.user_id == user_id,
        DingtalkSyncedNode.source == source.value,
        DingtalkSyncedNode.is_active == True,  # noqa: E712
        DingtalkSyncedNode.dingtalk_node_id.in_(allowed_node_ids),
    )
    if source == DingTalkNodeSource.WIKISPACE:
        query = query.filter(DingtalkSyncedNode.workspace_id == (ref.id or ""))
    return {
        node_id
        for node_id, content_type in query.all()
        if _normalized_content_type(content_type) in READABLE_CONTENT_TYPES
    }


def _normalized_content_type(value: object) -> str:
    """Normalize catalog content-type aliases to the Docs MCP extension."""
    normalized = str(value or "").strip().lower().removeprefix(".")
    return CONTENT_TYPE_ALIASES.get(normalized, normalized)


def _record_score(record: dict[str, Any]) -> float | None:
    value = record.get("score")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _map_content_record(
    content: DingTalkDocumentContent,
    *,
    ref,
    source_id: str,
    source_name: str | None,
    score: float | None = None,
) -> Any:
    from app.api.endpoints.internal.rag import RetrieveRecord

    metadata = {
        "provider": "dingtalk",
        "source_id": source_id,
        "source_name": source_name,
        "node_id": content.node_id,
        "document_id": content.node_id,
        "target_type": ref.target_type,
        "canonical_ref_key": external_ref_canonical_key(ref),
    }
    return RetrieveRecord(
        content=content.markdown,
        score=score,
        title=content.title,
        metadata={key: value for key, value in metadata.items() if value is not None},
        source_type="dingtalk",
        source_id=source_id,
        source_uri=content.doc_url,
        source_name=source_name,
    )


def _node_to_document(
    source_id: str, node: DingtalkSyncedNode
) -> ExternalKnowledgeDocument:
    return ExternalKnowledgeDocument(
        provider="dingtalk",
        source_id=source_id,
        source_name="DingTalk Docs" if source_id == DOCS_CONTAINER_ID else source_id,
        document_id=node.dingtalk_node_id,
        title=node.name,
        node_id=node.dingtalk_node_id,
        parent_id=node.parent_node_id or None,
        source_uri=node.doc_url,
    )


def register_dingtalk_retrieval_source_provider() -> None:
    """Register the DingTalk provider in the shared retrieval registry."""
    retrieval_source_registry.register(DingTalkRetrievalSourceProvider())
