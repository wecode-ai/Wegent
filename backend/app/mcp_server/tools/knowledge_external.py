# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External MCP tools for trusted knowledge base integrations."""

import json
import logging
from dataclasses import dataclass
from functools import partial
from typing import Optional

import anyio
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.rate_limit import (
    ExternalMcpRateLimitStatus,
    check_external_mcp_dimension_rate_limit,
)
from app.db.session import SessionLocal
from app.mcp_server.server import (
    EXTERNAL_KNOWLEDGE_MCP_MOUNT_PATH,
    _external_knowledge_request_mount_path,
    _external_knowledge_request_user,
    external_knowledge_mcp_server,
)
from app.models.knowledge import KnowledgeFolder
from app.schemas.knowledge import ResourceScope
from app.schemas.knowledge_external import (
    ExternalDocumentContentResponse,
    ExternalDocumentDownloadResponse,
    ExternalKnowledgeNodeListResponse,
    ExternalKnowledgeSpace,
    ExternalKnowledgeSpaceListResponse,
    ExternalSearchContentRecord,
    ExternalSearchContentResponse,
)
from app.services.knowledge.document_read_service import (
    DOCUMENT_READ_ERROR_ACCESS_DENIED,
    DOCUMENT_READ_ERROR_NOT_FOUND,
    document_read_service,
)
from app.services.knowledge.external_document_access import (
    DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS,
    DOWNLOAD_TOKEN_HEADER,
    ExternalDocumentAccessError,
    create_document_download_token,
    get_document_access_or_raise,
    normalize_disposition,
)
from app.services.knowledge.external_nodes import (
    ExternalKnowledgeInputError,
    count_nodes,
    get_document_counts,
    list_direct_nodes,
    list_recursive_nodes,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.orchestrator import MAX_DOCUMENT_READ_LIMIT
from app.services.rag.document_id_utils import extract_document_id
from app.services.rag.gateway_factory import get_query_gateway
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import (
    RemoteRagGatewayError,
    should_fallback_to_local,
)
from app.services.rag.runtime_resolver import RagRuntimeResolver
from app.services.rag.runtime_specs import QueryRuntimeSpec

logger = logging.getLogger(__name__)

MAX_SEARCH_RESULTS = 50
MAX_SEARCH_QUERY_LENGTH = 2000
MAX_SEARCH_KNOWLEDGE_BASE_IDS = 100
DEFAULT_KNOWLEDGE_BASE_LIST_LIMIT = 50
MAX_KNOWLEDGE_BASE_LIST_LIMIT = 100
DEFAULT_DIRECT_NODE_LIMIT = 100
MAX_DIRECT_NODE_LIMIT = 500
INTERNAL_ERROR_MESSAGE = "Internal error"
IGNORED_KNOWLEDGE_BASES_WARNING = (
    "Some requested knowledge_base_ids were ignored because they are not accessible"
)
DOCUMENT_CONTENT_FORMAT = "text"
DOCUMENT_CONTENT_SOURCE = "parsed_attachment"


@dataclass(frozen=True)
class SearchPreparation:
    """Pure search state prepared in a worker thread."""

    runtime_spec: QueryRuntimeSpec
    target_ids: list[int]
    ignored_knowledge_base_ids: list[int]
    warnings: list[str]
    kb_name_map: dict[int, str]


def _normalize_url_path(path: str) -> str:
    normalized = (path or "").strip()
    if not normalized:
        return ""
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    return normalized.rstrip("/")


def _external_knowledge_document_file_url(document_id: int) -> str:
    current_mount_path = _external_knowledge_request_mount_path.get()
    mount_path = current_mount_path or (
        f"{_normalize_url_path(settings.API_PREFIX)}{EXTERNAL_KNOWLEDGE_MCP_MOUNT_PATH}"
    )
    return f"{mount_path}/documents/{document_id}/file"


def _get_external_user():
    return _external_knowledge_request_user.get()


def _json_error(message: str, code: str = "bad_request") -> str:
    return json.dumps({"error": message, "code": code}, ensure_ascii=False)


def _is_int(value) -> bool:
    return type(value) is int


def _is_bool(value) -> bool:
    return type(value) is bool


def _document_index_status(document) -> Optional[str]:
    if document.index_status is None:
        return None
    return (
        document.index_status.value
        if hasattr(document.index_status, "value")
        else str(document.index_status)
    )


def _validate_document_id(document_id) -> Optional[str]:
    if not _is_int(document_id):
        return "document_id must be an integer"
    if document_id <= 0:
        return "document_id must be a positive integer"
    return None


def _validate_document_read_paging(offset, limit) -> Optional[str]:
    if not _is_int(offset):
        return "offset must be an integer"
    if not _is_int(limit):
        return "limit must be an integer"
    if offset < 0:
        return "offset must be greater than or equal to 0"
    if limit < 1 or limit > MAX_DOCUMENT_READ_LIMIT:
        return f"limit must be between 1 and {MAX_DOCUMENT_READ_LIMIT}"
    return None


def _search_rate_limit_status(user_id: int) -> ExternalMcpRateLimitStatus:
    if not settings.EXTERNAL_KNOWLEDGE_MCP_SEARCH_RATE_LIMIT_ENABLED:
        return ExternalMcpRateLimitStatus.ALLOWED
    return check_external_mcp_dimension_rate_limit(
        dimensions=[f"user:{user_id}"],
        namespace="search",
        limit=settings.EXTERNAL_KNOWLEDGE_MCP_SEARCH_RATE_LIMIT_REQUESTS,
        window_seconds=settings.EXTERNAL_KNOWLEDGE_MCP_SEARCH_RATE_LIMIT_WINDOW_SECONDS,
    )


def _list_knowledge_bases_sync(
    *,
    user_id: int,
    scope: ResourceScope,
    group_name: Optional[str],
    query: Optional[str],
    limit: int,
    offset: int,
) -> str:
    db = SessionLocal()
    try:
        kbs = KnowledgeService.list_knowledge_bases(
            db, user_id, scope=scope, group_name=group_name
        )
        keyword = (query or "").strip().lower()
        if keyword:
            kbs = [
                kb
                for kb in kbs
                if keyword
                in ((kb.json.get("spec", {}) or {}).get("name", "") or "").lower()
                or keyword
                in (
                    (kb.json.get("spec", {}) or {}).get("description", "") or ""
                ).lower()
            ]
        kbs = sorted(kbs, key=lambda kb: (kb.created_at, kb.id), reverse=True)

        total = len(kbs)
        page_kbs = kbs[offset : offset + limit]
        counts = get_document_counts(db, [kb.id for kb in page_kbs])
        items = []
        for kb in page_kbs:
            spec = kb.json.get("spec", {}) or {}
            items.append(
                ExternalKnowledgeSpace(
                    knowledge_base_id=kb.id,
                    knowledge_base_name=spec.get("name", ""),
                    description=spec.get("description") or None,
                    namespace=kb.namespace,
                    owner_user_id=kb.user_id,
                    document_count=counts.get(kb.id, 0),
                    created_at=kb.created_at,
                    updated_at=kb.updated_at,
                )
            )

        return ExternalKnowledgeSpaceListResponse(
            total=total,
            total_returned=len(items),
            has_more=offset + len(items) < total,
            limit=limit,
            offset=offset,
            items=items,
        ).model_dump_json()
    except Exception as exc:
        logger.exception("wegent_kb_list_knowledge_bases failed: %s", exc)
        return _json_error(INTERNAL_ERROR_MESSAGE, "internal_error")
    finally:
        db.close()


def _list_nodes_sync(
    *,
    user_id: int,
    knowledge_base_id: int,
    folder_id: int,
    recursive: bool,
    include_inactive: bool,
    limit: int,
    offset: int,
) -> str:
    db = SessionLocal()
    try:
        kb, has_access = KnowledgeService.get_knowledge_base(
            db, knowledge_base_id, user_id
        )
        if not kb:
            return _json_error("Knowledge base not found", "not_found")
        if not has_access:
            return _json_error("Access denied to knowledge base", "forbidden")

        if folder_id != 0:
            folder = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.id == folder_id,
                    KnowledgeFolder.kind_id == knowledge_base_id,
                )
                .first()
            )
            if not folder:
                return _json_error("Folder not found in knowledge base", "not_found")

        warnings: list[str] = []
        if recursive:
            items, warnings = list_recursive_nodes(
                db,
                knowledge_base_id=knowledge_base_id,
                folder_id=folder_id,
                include_inactive=include_inactive,
            )
            total_returned = count_nodes(items)
            total_available = total_returned
            has_more = False
        else:
            direct_nodes = list_direct_nodes(
                db,
                knowledge_base_id=knowledge_base_id,
                folder_id=folder_id,
                include_inactive=include_inactive,
                limit=limit,
                offset=offset,
            )
            items = direct_nodes.items
            total_available = direct_nodes.total_available
            has_more = direct_nodes.has_more
            total_returned = len(items)

        spec = kb.json.get("spec", {}) or {}
        return ExternalKnowledgeNodeListResponse(
            knowledge_base_id=knowledge_base_id,
            knowledge_base_name=spec.get("name", ""),
            folder_id=folder_id,
            recursive=recursive,
            total_returned=total_returned,
            total_available=total_available,
            has_more=has_more,
            items=items,
            warnings=warnings,
        ).model_dump_json()
    except ExternalKnowledgeInputError as exc:
        return _json_error(str(exc), exc.code)
    except Exception as exc:
        logger.exception("wegent_kb_list_nodes failed: %s", exc)
        return _json_error(INTERNAL_ERROR_MESSAGE, "internal_error")
    finally:
        db.close()


def _get_document_content_sync(
    *,
    user_id: int,
    document_id: int,
    offset: int,
    limit: int,
) -> str:
    db = SessionLocal()
    try:
        access = get_document_access_or_raise(
            db,
            user_id=user_id,
            document_id=document_id,
        )
        results = document_read_service.read_documents(
            db=db,
            document_ids=[document_id],
            offset=offset,
            limit=limit,
            knowledge_base_ids=[access.knowledge_base_id],
        )
        result = results[0] if results else None
        if result is None or result.get("error_code") == DOCUMENT_READ_ERROR_NOT_FOUND:
            return _json_error("Document not found", "not_found")
        if result.get("error_code") == DOCUMENT_READ_ERROR_ACCESS_DENIED:
            return _json_error(result["error"], "forbidden")
        if result.get("error"):
            return _json_error(result["error"], "forbidden")

        return ExternalDocumentContentResponse(
            document_id=document_id,
            node_id=f"document:{document_id}",
            knowledge_base_id=access.knowledge_base_id,
            name=result["name"],
            content=result["content"],
            content_format=DOCUMENT_CONTENT_FORMAT,
            content_source=DOCUMENT_CONTENT_SOURCE,
            content_available=result["total_length"] > 0,
            offset=result["offset"],
            returned_length=result["returned_length"],
            total_length=result["total_length"],
            has_more=result["has_more"],
            index_status=_document_index_status(access.document),
        ).model_dump_json()
    except ExternalDocumentAccessError as exc:
        return _json_error(str(exc), exc.code)
    except Exception as exc:
        logger.exception("wegent_kb_get_document_content failed: %s", exc)
        return _json_error(INTERNAL_ERROR_MESSAGE, "internal_error")
    finally:
        db.close()


def _get_document_download_sync(
    *,
    user_id: int,
    document_id: int,
    disposition: str,
    resource_url: str,
) -> str:
    db = SessionLocal()
    try:
        access = get_document_access_or_raise(
            db,
            user_id=user_id,
            document_id=document_id,
        )
        if not access.downloadable:
            return _json_error("Document file is unavailable", "file_unavailable")
        if disposition == "inline" and not access.previewable:
            return _json_error(
                "Document file is not previewable", "unsupported_media_type"
            )

        token = create_document_download_token(
            user_id=user_id,
            document_id=document_id,
            disposition=disposition,
        )
        return ExternalDocumentDownloadResponse(
            document_id=document_id,
            node_id=f"document:{document_id}",
            knowledge_base_id=access.knowledge_base_id,
            resource_url=resource_url,
            headers={DOWNLOAD_TOKEN_HEADER: token},
            expiration_seconds=DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS,
            disposition=disposition,
            mime_type=access.mime_type or "application/octet-stream",
            file_name=access.file_name,
            file_extension=access.file_extension,
            file_size=access.file_size,
            downloadable=access.downloadable,
            previewable=access.previewable,
        ).model_dump_json()
    except ExternalDocumentAccessError as exc:
        return _json_error(str(exc), exc.code)
    except Exception as exc:
        logger.exception("wegent_kb_get_document_download failed: %s", exc)
        return _json_error(INTERNAL_ERROR_MESSAGE, "internal_error")
    finally:
        db.close()


def _prepare_search_content_sync(
    *,
    user_id: int,
    user_name: str,
    query: str,
    requested_ids: list[int],
    max_results: int,
) -> SearchPreparation | str:
    search_rate_limit_status = _search_rate_limit_status(user_id)
    if search_rate_limit_status == ExternalMcpRateLimitStatus.LIMITED:
        return _json_error("Rate limit exceeded", "rate_limited")
    if search_rate_limit_status == ExternalMcpRateLimitStatus.UNAVAILABLE:
        return _json_error(
            "Rate limit service unavailable",
            "rate_limit_unavailable",
        )

    db = SessionLocal()
    try:
        ignored_knowledge_base_ids: list[int] = []
        warnings: list[str] = []
        target_ids = []
        kb_name_map = {}
        for requested_knowledge_base_id in requested_ids:
            if requested_knowledge_base_id <= 0:
                ignored_knowledge_base_ids.append(requested_knowledge_base_id)
                continue

            kb, has_access = KnowledgeService.get_knowledge_base(
                db, requested_knowledge_base_id, user_id
            )
            if kb and has_access:
                spec = kb.json.get("spec", {}) or {}
                target_ids.append(kb.id)
                kb_name_map[kb.id] = spec.get("name", "")
            else:
                ignored_knowledge_base_ids.append(requested_knowledge_base_id)

        if ignored_knowledge_base_ids:
            warnings.append(IGNORED_KNOWLEDGE_BASES_WARNING)

        if not target_ids:
            return _json_error("No accessible knowledge bases found", "not_found")

        runtime_resolver = RagRuntimeResolver()
        runtime_spec = runtime_resolver.build_query_runtime_spec(
            knowledge_base_ids=target_ids,
            query=query,
            max_results=max_results,
            route_mode="rag_retrieval",
            user_id=user_id,
            user_name=user_name,
            knowledge_base_configs=[],
        )
        return SearchPreparation(
            runtime_spec=runtime_spec,
            target_ids=target_ids,
            ignored_knowledge_base_ids=ignored_knowledge_base_ids,
            warnings=warnings,
            kb_name_map=kb_name_map,
        )
    except Exception as exc:
        logger.exception("wegent_kb_search_content preparation failed: %s", exc)
        return _json_error(INTERNAL_ERROR_MESSAGE, "internal_error")
    finally:
        db.close()


def _with_local_query_configs(
    runtime_spec: QueryRuntimeSpec,
    db: Session,
) -> QueryRuntimeSpec:
    if (
        runtime_spec.route_mode != "rag_retrieval"
        or runtime_spec.knowledge_base_configs
    ):
        return runtime_spec

    knowledge_base_configs = RagRuntimeResolver().build_query_knowledge_base_configs(
        db=db,
        knowledge_base_ids=runtime_spec.knowledge_base_ids,
        current_user_id=runtime_spec.user_id,
        user_name=runtime_spec.user_name,
    )
    return runtime_spec.model_copy(
        update={"knowledge_base_configs": knowledge_base_configs}
    )


def _query_content_local_sync(runtime_spec: QueryRuntimeSpec) -> dict:
    db = SessionLocal()
    try:
        local_runtime_spec = _with_local_query_configs(runtime_spec, db)
        return anyio.run(partial(LocalRagGateway().query, local_runtime_spec, db=db))
    finally:
        db.close()


async def _query_content(runtime_spec: QueryRuntimeSpec) -> dict:
    gateway = get_query_gateway()
    if isinstance(gateway, LocalRagGateway):
        return await run_in_threadpool(_query_content_local_sync, runtime_spec)

    try:
        return await gateway.query(runtime_spec, db=None)
    except RemoteRagGatewayError as exc:
        if not should_fallback_to_local(exc):
            raise
        logger.warning(
            "External knowledge search remote query failed; falling back to local: %s",
            exc,
        )
        return await run_in_threadpool(_query_content_local_sync, runtime_spec)


@external_knowledge_mcp_server.tool()
async def wegent_kb_list_knowledge_bases(
    scope: str = "all",
    group_name: Optional[str] = None,
    query: Optional[str] = None,
    limit: int = DEFAULT_KNOWLEDGE_BASE_LIST_LIMIT,
    offset: int = 0,
) -> str:
    """List knowledge bases visible to the authenticated external user."""
    user = _get_external_user()
    if not user:
        return _json_error("Authentication required", "unauthorized")

    if not isinstance(scope, str):
        return _json_error("scope must be a string")
    if group_name is not None and not isinstance(group_name, str):
        return _json_error("group_name must be a string")
    if query is not None and not isinstance(query, str):
        return _json_error("query must be a string")
    if not _is_int(limit):
        return _json_error("limit must be an integer")
    if not _is_int(offset):
        return _json_error("offset must be an integer")
    if limit < 1 or limit > MAX_KNOWLEDGE_BASE_LIST_LIMIT:
        return _json_error(
            f"limit must be between 1 and {MAX_KNOWLEDGE_BASE_LIST_LIMIT}"
        )
    if offset < 0:
        return _json_error("offset must be greater than or equal to 0")

    try:
        scope_enum = ResourceScope(scope.strip())
    except ValueError:
        return _json_error("Invalid scope")
    normalized_group_name = (group_name or "").strip() or None
    if scope_enum == ResourceScope.GROUP and not normalized_group_name:
        return _json_error("group_name is required when scope is group")

    return await run_in_threadpool(
        partial(
            _list_knowledge_bases_sync,
            user_id=user.id,
            scope=scope_enum,
            group_name=normalized_group_name,
            query=query,
            limit=limit,
            offset=offset,
        )
    )


@external_knowledge_mcp_server.tool()
async def wegent_kb_list_nodes(
    knowledge_base_id: int,
    folder_id: int = 0,
    recursive: bool = False,
    include_inactive: bool = True,
    limit: int = DEFAULT_DIRECT_NODE_LIMIT,
    offset: int = 0,
) -> str:
    """List folder and document nodes in a knowledge base."""
    user = _get_external_user()
    if not user:
        return _json_error("Authentication required", "unauthorized")
    if not _is_int(knowledge_base_id):
        return _json_error("knowledge_base_id must be an integer")
    if not _is_int(folder_id):
        return _json_error("folder_id must be an integer")
    if not _is_bool(recursive):
        return _json_error("recursive must be a boolean")
    if not _is_bool(include_inactive):
        return _json_error("include_inactive must be a boolean")
    if not _is_int(limit):
        return _json_error("limit must be an integer")
    if not _is_int(offset):
        return _json_error("offset must be an integer")
    if knowledge_base_id <= 0:
        return _json_error("knowledge_base_id is required")
    if folder_id < 0:
        return _json_error("folder_id must be greater than or equal to 0")
    if limit < 1 or limit > MAX_DIRECT_NODE_LIMIT:
        return _json_error(f"limit must be between 1 and {MAX_DIRECT_NODE_LIMIT}")
    if offset < 0:
        return _json_error("offset must be greater than or equal to 0")

    return await run_in_threadpool(
        partial(
            _list_nodes_sync,
            user_id=user.id,
            knowledge_base_id=knowledge_base_id,
            folder_id=folder_id,
            recursive=recursive,
            include_inactive=include_inactive,
            limit=limit,
            offset=offset,
        )
    )


@external_knowledge_mcp_server.tool()
async def wegent_kb_get_document_content(
    document_id: int,
    offset: int = 0,
    limit: int = MAX_DOCUMENT_READ_LIMIT,
) -> str:
    """Read parsed text content for an accessible knowledge document."""
    user = _get_external_user()
    if not user:
        return _json_error("Authentication required", "unauthorized")

    validation_error = _validate_document_id(document_id)
    if validation_error:
        return _json_error(validation_error)
    validation_error = _validate_document_read_paging(offset, limit)
    if validation_error:
        return _json_error(validation_error)

    return await run_in_threadpool(
        partial(
            _get_document_content_sync,
            user_id=user.id,
            document_id=document_id,
            offset=offset,
            limit=limit,
        )
    )


@external_knowledge_mcp_server.tool()
async def wegent_kb_get_document_download(
    document_id: int,
    disposition: str = "inline",
) -> str:
    """Get a short-lived original file download credential for a document."""
    user = _get_external_user()
    if not user:
        return _json_error("Authentication required", "unauthorized")

    validation_error = _validate_document_id(document_id)
    if validation_error:
        return _json_error(validation_error)

    try:
        normalized_disposition = normalize_disposition(disposition)
    except ExternalDocumentAccessError as exc:
        return _json_error(str(exc), exc.code)

    resource_url = _external_knowledge_document_file_url(document_id)
    return await run_in_threadpool(
        partial(
            _get_document_download_sync,
            user_id=user.id,
            document_id=document_id,
            disposition=normalized_disposition,
            resource_url=resource_url,
        )
    )


@external_knowledge_mcp_server.tool()
async def wegent_kb_search_content(
    query: str,
    knowledge_base_ids: Optional[list[int]] = None,
    max_results: int = 10,
) -> str:
    """Search document content in accessible knowledge bases."""
    user = _get_external_user()
    if not user:
        return _json_error("Authentication required", "unauthorized")

    if not isinstance(query, str):
        return _json_error("query must be a string")
    normalized_query = query.strip()
    if not normalized_query:
        return _json_error("query must not be empty")
    if len(normalized_query) > MAX_SEARCH_QUERY_LENGTH:
        return _json_error(
            f"query must be at most {MAX_SEARCH_QUERY_LENGTH} characters"
        )
    if not _is_int(max_results):
        return _json_error("max_results must be an integer")
    if max_results < 1 or max_results > MAX_SEARCH_RESULTS:
        return _json_error(f"max_results must be between 1 and {MAX_SEARCH_RESULTS}")
    if knowledge_base_ids is None:
        return _json_error("knowledge_base_ids is required")
    if not isinstance(knowledge_base_ids, list):
        return _json_error("knowledge_base_ids must be a list of integers")
    if any(not _is_int(knowledge_base_id) for knowledge_base_id in knowledge_base_ids):
        return _json_error("knowledge_base_ids must contain only integers")
    requested_ids = list(dict.fromkeys(knowledge_base_ids))
    if not requested_ids:
        return _json_error("knowledge_base_ids must not be empty")
    if len(requested_ids) > MAX_SEARCH_KNOWLEDGE_BASE_IDS:
        return _json_error(
            f"knowledge_base_ids must contain at most {MAX_SEARCH_KNOWLEDGE_BASE_IDS} items"
        )

    preparation = await run_in_threadpool(
        partial(
            _prepare_search_content_sync,
            user_id=user.id,
            user_name=user.user_name,
            query=normalized_query,
            requested_ids=requested_ids,
            max_results=max_results,
        )
    )
    if isinstance(preparation, str):
        return preparation

    try:
        result = await _query_content(preparation.runtime_spec)

        records = []
        for item in result.get("records", []):
            kb_id = item.get("knowledge_base_id")
            records.append(
                ExternalSearchContentRecord(
                    content=item.get("content", ""),
                    title=item.get("title", ""),
                    score=item.get("score"),
                    knowledge_base_id=kb_id,
                    knowledge_base_name=(
                        preparation.kb_name_map.get(kb_id)
                        if kb_id is not None
                        else None
                    ),
                    document_id=extract_document_id(item),
                )
            )

        return ExternalSearchContentResponse(
            query=normalized_query,
            total=result.get("total", len(records)),
            total_estimated_tokens=result.get("total_estimated_tokens", 0),
            searched_knowledge_base_ids=preparation.target_ids,
            ignored_knowledge_base_ids=preparation.ignored_knowledge_base_ids,
            warnings=preparation.warnings,
            records=records,
        ).model_dump_json()
    except Exception as exc:
        logger.exception("wegent_kb_search_content failed: %s", exc)
        return _json_error(INTERNAL_ERROR_MESSAGE, "internal_error")
