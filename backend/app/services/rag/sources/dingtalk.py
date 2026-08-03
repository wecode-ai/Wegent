# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk MCP-backed external knowledge retrieval provider."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.external_knowledge import (
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeRef,
)
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService
from app.services.rag.sources.models import (
    ExternalRefValidationError,
    RetrievalContext,
    RetrievalSourceResult,
    RetrievalSourceStatus,
    RetrievalSourceSummary,
)

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from app.api.endpoints.internal.rag import RetrieveRecord

PROVIDER_NAME = "dingtalk"
PERSONAL_ROOT_ID = "docs-root"
MAX_RESULTS = 5
MAX_SEARCH_PAGES = 4
MAX_FOLDER_DEPTH = 20
MAX_SCOPED_NODES = 5000


class DingTalkKnowledgeProvider:
    """Resolve structured DingTalk ranges through the current user's Docs MCP."""

    name = PROVIDER_NAME

    def validate_refs(
        self,
        refs: list[ExternalKnowledgeRef],
        *,
        binding_level: ExternalKnowledgeBindingLevel,
    ) -> None:
        del binding_level
        for ref in refs:
            if ref.provider != self.name:
                raise ExternalRefValidationError("Invalid DingTalk provider")
            if ref.mode != "explicit" or not ref.id:
                raise ExternalRefValidationError(
                    "DingTalk knowledge scopes require an explicit container id"
                )
            if ref.scope_mode not in {"all", "custom"}:
                raise ExternalRefValidationError(
                    "DingTalk knowledge scopes require scope_mode=all or custom"
                )
            if (
                ref.scope_mode == "custom"
                and not ref.folder_ids
                and not ref.document_ids
            ):
                raise ExternalRefValidationError(
                    "Custom DingTalk scopes require folders or documents"
                )

    async def retrieve(
        self,
        query: str,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
    ) -> RetrievalSourceResult:
        self.validate_refs(refs, binding_level="conversation")
        mcp_url = self._get_mcp_url(ctx.user_id)
        if not mcp_url:
            raise RuntimeError("DingTalk Docs MCP is not configured")

        records: list[RetrieveRecord] = []
        statuses: list[RetrievalSourceStatus] = []
        warnings: list[str] = []
        async with self._session(mcp_url) as session:
            for ref in refs:
                try:
                    ref_records = await self._retrieve_ref(session, query, ref)
                    records.extend(ref_records)
                    statuses.append(
                        RetrievalSourceStatus(
                            provider=self.name,
                            source_id=ref.id or PERSONAL_ROOT_ID,
                            source_name=ref.name,
                            status="hit" if ref_records else "no_hit",
                            record_count=len(ref_records),
                            mode=ref.scope_mode,
                        )
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to retrieve DingTalk scope %s", ref.id, exc_info=True
                    )
                    warnings.append(f"{ref.name or ref.id}: retrieval failed")
                    statuses.append(
                        RetrievalSourceStatus(
                            provider=self.name,
                            source_id=ref.id or PERSONAL_ROOT_ID,
                            source_name=ref.name,
                            status="failed",
                            mode=ref.scope_mode,
                        )
                    )

        searched_ids = [ref.id for ref in refs if ref.id]
        return RetrievalSourceResult(
            records=records[:MAX_RESULTS],
            summary=RetrievalSourceSummary(
                provider=self.name,
                searched_source_ids=searched_ids,
                ignored_source_ids=[],
                source_statuses=statuses,
            ),
            warnings=warnings,
        )

    async def _retrieve_ref(
        self, session: Any, query: str, ref: ExternalKnowledgeRef
    ) -> list[RetrieveRecord]:
        workspace_id = None if ref.id == PERSONAL_ROOT_ID else ref.id
        allowed_ids: set[str] | None = None

        if ref.scope_mode == "custom" or ref.id == PERSONAL_ROOT_ID:
            allowed_ids = set(ref.document_ids or [])
            folders = list(ref.folder_ids or [])
            if ref.scope_mode == "all" and ref.id == PERSONAL_ROOT_ID:
                folders = [""]
            for folder_id in folders:
                allowed_ids.update(
                    await self._list_document_ids(
                        session,
                        folder_id=folder_id or None,
                        workspace_id=workspace_id,
                        include_descendants=ref.include_descendants is not False,
                    )
                )

        excluded_ids = set(ref.excluded_node_ids or [])
        for node_id in list(ref.excluded_node_ids or []):
            excluded_ids.update(
                await self._list_document_ids(
                    session,
                    folder_id=node_id,
                    workspace_id=workspace_id,
                    tolerate_non_folder=True,
                )
            )

        direct_ids = [
            node_id
            for node_id in (ref.document_ids or [])
            if node_id not in excluded_ids
        ]
        candidates: list[dict[str, Any]] = [
            {"nodeId": node_id, "name": node_id} for node_id in direct_ids
        ]
        remaining_allowed_ids = (
            allowed_ids.difference(direct_ids) if allowed_ids is not None else None
        )
        if len(candidates) < MAX_RESULTS and (
            remaining_allowed_ids is None or remaining_allowed_ids
        ):
            searched = await self._search_documents(
                session,
                query=query,
                workspace_id=workspace_id,
                allowed_ids=allowed_ids,
                excluded_ids=excluded_ids,
                limit=MAX_RESULTS - len(candidates),
            )
            seen = {self._node_id(item) for item in candidates}
            candidates.extend(
                item for item in searched if self._node_id(item) not in seen
            )

        records = []
        for candidate in candidates[:MAX_RESULTS]:
            node_id = self._node_id(candidate)
            if not node_id:
                continue
            content = await self._get_document_content(session, node_id)
            if not content:
                continue
            records.append(self._to_record(ref, candidate, node_id, content))
        return records

    async def _search_documents(
        self,
        session: Any,
        *,
        query: str,
        workspace_id: str | None,
        allowed_ids: set[str] | None,
        excluded_ids: set[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        page_token: str | None = None
        for _ in range(MAX_SEARCH_PAGES):
            args: dict[str, Any] = {"keyword": query, "pageSize": 30}
            if workspace_id:
                args["workspaceIds"] = [workspace_id]
            if page_token:
                args["pageToken"] = page_token
            payload = self._parse_payload(
                await session.call_tool("search_documents", args)
            )
            items = self._extract_items(payload)
            for item in items:
                node_id = self._node_id(item)
                if not node_id or node_id in excluded_ids:
                    continue
                if allowed_ids is not None and node_id not in allowed_ids:
                    continue
                results.append(item)
                if len(results) >= limit:
                    return results
            page_token = self._next_token(payload)
            if not page_token:
                break
        return results

    async def _list_document_ids(
        self,
        session: Any,
        *,
        folder_id: str | None,
        workspace_id: str | None,
        include_descendants: bool = True,
        tolerate_non_folder: bool = False,
    ) -> set[str]:
        document_ids: set[str] = set()
        pending: list[tuple[str | None, int]] = [(folder_id, 0)]
        visited_folders: set[str] = set()
        while pending:
            current_folder, depth = pending.pop()
            if depth >= MAX_FOLDER_DEPTH:
                continue
            if current_folder and current_folder in visited_folders:
                continue
            if current_folder:
                visited_folders.add(current_folder)
                if len(visited_folders) + len(document_ids) > MAX_SCOPED_NODES:
                    raise RuntimeError(
                        "DingTalk scope exceeds the supported node limit"
                    )
            page_token: str | None = None
            while True:
                args: dict[str, Any] = {"pageSize": 50}
                if current_folder:
                    args["folderId"] = current_folder
                if workspace_id:
                    args["workspaceId"] = workspace_id
                if page_token:
                    args["pageToken"] = page_token
                try:
                    payload = self._parse_payload(
                        await session.call_tool("list_nodes", args)
                    )
                except Exception:
                    if tolerate_non_folder and current_folder == folder_id:
                        return document_ids
                    raise
                for item in self._extract_items(payload):
                    node_id = self._node_id(item)
                    if not node_id:
                        continue
                    if self._node_type(item) == "folder":
                        if include_descendants:
                            pending.append((node_id, depth + 1))
                        continue
                    document_ids.add(node_id)
                    if len(visited_folders) + len(document_ids) > MAX_SCOPED_NODES:
                        raise RuntimeError(
                            "DingTalk scope exceeds the supported node limit"
                        )
                page_token = self._next_token(payload)
                if not page_token:
                    break
        return document_ids

    async def _get_document_content(self, session: Any, node_id: str) -> str:
        payload = self._parse_payload(
            await session.call_tool(
                "get_document_content", {"nodeId": node_id, "format": "markdown"}
            )
        )
        return self._extract_content(payload)

    @staticmethod
    def _get_mcp_url(user_id: int) -> str | None:
        with SessionLocal() as db:
            user = db.get(User, user_id)
            if not user:
                return None
            return DingTalkDocService.get_user_dingtalk_mcp_url(
                user
            ) or DingTalkWikiSpaceService.get_user_wikispace_mcp_url(user)

    @staticmethod
    @asynccontextmanager
    async def _session(mcp_url: str) -> AsyncIterator[Any]:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        async with streamablehttp_client(url=mcp_url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                yield session

    @staticmethod
    def _parse_payload(result: Any) -> Any:
        payloads: list[Any] = []
        for item in getattr(result, "content", []) or []:
            if getattr(item, "type", None) != "text":
                continue
            raw = getattr(item, "text", "") or ""
            try:
                payloads.append(json.loads(raw))
            except (json.JSONDecodeError, TypeError):
                if raw.strip():
                    payloads.append(raw)
        if not payloads:
            return {}
        return payloads[0] if len(payloads) == 1 else payloads

    @classmethod
    def _extract_items(cls, payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            direct = [item for item in payload if isinstance(item, dict)]
            if direct:
                return direct
            for item in payload:
                nested = cls._extract_items(item)
                if nested:
                    return nested
        if isinstance(payload, dict):
            for key in ("documents", "items", "nodes", "results", "records"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
            for key in ("result", "data"):
                nested = cls._extract_items(payload.get(key))
                if nested:
                    return nested
        return []

    @staticmethod
    def _next_token(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None
        token = payload.get("nextPageToken") or payload.get("pageToken")
        if token:
            return str(token)
        for key in ("result", "data"):
            nested = payload.get(key)
            if isinstance(nested, dict):
                token = nested.get("nextPageToken") or nested.get("pageToken")
                if token:
                    return str(token)
        return None

    @staticmethod
    def _node_id(item: dict[str, Any]) -> str:
        return str(
            item.get("nodeId")
            or item.get("dentryUuid")
            or item.get("documentId")
            or item.get("id")
            or ""
        )

    @staticmethod
    def _node_type(item: dict[str, Any]) -> str:
        return str(item.get("nodeType") or item.get("type") or "document").lower()

    @classmethod
    def _extract_content(cls, payload: Any) -> str:
        if isinstance(payload, str):
            return payload
        if isinstance(payload, list):
            return "\n".join(
                filter(None, (cls._extract_content(item) for item in payload))
            )
        if isinstance(payload, dict):
            for key in ("markdown", "content", "text"):
                value = payload.get(key)
                if isinstance(value, str):
                    return value
            for key in ("result", "data"):
                content = cls._extract_content(payload.get(key))
                if content:
                    return content
        return ""

    @staticmethod
    def _to_record(
        ref: ExternalKnowledgeRef,
        candidate: dict[str, Any],
        node_id: str,
        content: str,
    ) -> RetrieveRecord:
        from app.api.endpoints.internal.rag import RetrieveRecord

        title = str(candidate.get("name") or candidate.get("title") or node_id)
        return RetrieveRecord(
            content=content,
            score=DingTalkKnowledgeProvider._score(candidate.get("score")),
            title=title,
            metadata={"provider": PROVIDER_NAME, "container_id": ref.id},
            source_type="external_knowledge",
            source_id=ref.id,
            source_uri=str(
                candidate.get("url")
                or f"https://alidocs.dingtalk.com/i/nodes/{node_id}"
            ),
            source_name=ref.name,
        )

    @staticmethod
    def _score(value: Any) -> float | None:
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None


dingtalk_knowledge_provider = DingTalkKnowledgeProvider()
