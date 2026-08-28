# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral seam for importing external documents.

An external document provider resolves one external document — identified by
the requesting user plus a provider-scoped resource ID — into content that the
existing attachment / conversion / indexing pipeline can consume. DingTalk is
the first adapter; a new provider only registers an adapter here and reuses
the import state machine instead of duplicating it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, AsyncIterator

import aiohttp
from sqlalchemy.orm import Session

from app.core.async_utils import AsyncSessionManager
from app.core.config import settings
from app.models.user import User
from app.services.dingtalk_document_types import get_import_extension
from app.services.plugin_upstream_fetch import UpstreamFetchError, validate_upstream_url
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

EXTERNAL_DOCUMENT_MCP_READ_TIMEOUT_SECONDS = 180
_SPREADSHEET_MCP_SERVICES = {
    "able": ("ai_table", "AI Table"),
    "axls": ("table", "Table"),
}


class ExternalDocumentImportError(Exception):
    """Validation failure for an external document import request.

    ``status_code`` is the HTTP status the API layer should surface.
    """

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class ExternalDocumentFetchError(RuntimeError):
    """Background fetch of external document content failed."""


class ExternalSourceUnavailableError(ExternalDocumentFetchError):
    """The external source no longer exists or the user lost access to it.

    Raised by ``fetch_content`` when the provider can positively tell the
    resource is gone (or permission was revoked). The import marks the
    document's source as inaccessible; it is distinct from a transient fetch
    failure and the failed initial import may be retried.
    """


class ExternalImportLostWriteError(RuntimeError):
    """The import attempt lost its write right before attaching content.

    Raised when the guarded attachment write finds the document deleted,
    superseded by a newer generation, or no longer carrying the external
    identity this attempt was dispatched for. The caller must clean up the
    attachment created by this attempt and leave the document untouched.
    """


@asynccontextmanager
async def open_dingtalk_session(url: str) -> AsyncIterator[Any]:
    """Use the same bounded read timeout for each provider service."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(
        url=url, sse_read_timeout=EXTERNAL_DOCUMENT_MCP_READ_TIMEOUT_SECONDS
    ) as (reader, writer, _):
        async with ClientSession(
            reader,
            writer,
            read_timeout_seconds=timedelta(
                seconds=EXTERNAL_DOCUMENT_MCP_READ_TIMEOUT_SECONDS
            ),
        ) as session:
            await session.initialize()
            yield session


async def download_content(url: Any, headers: Any = None) -> bytes:
    """Download an official signed URL without redirecting credentials or logging it."""

    if not isinstance(url, str) or not url.strip():
        raise ExternalDocumentFetchError("DingTalk returned no download URL")
    if headers is not None and (
        not isinstance(headers, dict)
        or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()
        )
    ):
        raise ExternalDocumentFetchError("DingTalk returned invalid download headers")
    limit = settings.MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024
    try:
        await asyncio.to_thread(validate_upstream_url, url)
        # This client does not log or automatically trace signed request URLs.
        async with AsyncSessionManager(timeout=60) as client:
            async with client.get(
                url, headers=headers, allow_redirects=False
            ) as response:
                if not 200 <= response.status < 300:
                    raise ExternalDocumentFetchError("DingTalk file download failed")
                declared_size = int(response.headers.get("content-length", "0"))
                if declared_size < 0 or declared_size > limit:
                    raise ExternalDocumentFetchError(
                        "DingTalk file exceeds the upload size limit"
                    )
                content = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    if len(content) + len(chunk) > limit:
                        raise ExternalDocumentFetchError(
                            "DingTalk file exceeds the upload size limit"
                        )
                    content.extend(chunk)
    except (aiohttp.ClientError, TimeoutError, UpstreamFetchError, ValueError):
        # Provider URLs and signed headers must not appear in persisted errors.
        raise ExternalDocumentFetchError(
            "DingTalk file download failed or URL is unsafe"
        ) from None
    if not content:
        raise ExternalDocumentFetchError("DingTalk file is empty")
    return bytes(content)


@dataclass(frozen=True)
class ExternalDocumentContent:
    """Fetched content of one external document, ready for the RAG pipeline."""

    name: str
    file_extension: str
    content: bytes
    # Provider metadata persisted into the document's source_config["external"]
    metadata: dict[str, Any] = field(default_factory=dict)


class ExternalDocumentProvider(ABC):
    """Contract every external document provider adapter must fulfil."""

    provider_id: str

    @abstractmethod
    def resolve_importable(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> dict[str, Any]:
        """Validate the external resource and return its display metadata.

        Raises ExternalDocumentImportError when the resource does not exist
        for this user or cannot be imported.
        """

    @abstractmethod
    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        """Fetch the document body as attachment-ready content.

        Raises ExternalSourceUnavailableError when the provider can tell the
        resource is gone or access was revoked, ExternalDocumentFetchError
        for transient failures.
        """


class DingTalkExternalDocumentProvider(ExternalDocumentProvider):
    """DingTalk adapter backed by the user's DingTalk Docs MCP server."""

    provider_id = "dingtalk"

    def resolve_importable(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> dict[str, Any]:
        from app.models.dingtalk_doc import DingtalkSyncedNode
        from app.services.dingtalk_doc_service import DingTalkDocService

        node = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user.id,
                DingtalkSyncedNode.dingtalk_node_id == external_resource_id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .first()
        )
        if node is None:
            raise ExternalDocumentImportError(
                "DingTalk document not found in your synced nodes", status_code=404
            )
        if not get_import_extension(
            {
                "nodeType": node.node_type,
                "contentType": node.content_type,
                "extension": node.extension,
            }
        ):
            raise ExternalDocumentImportError(
                "This DingTalk file type cannot be imported"
            )
        if not DingTalkDocService.is_configured(user):
            raise ExternalDocumentImportError(
                "DingTalk Docs is not configured for this account"
            )
        if (
            node.content_type.strip().upper() == "ALIDOC"
            and node.extension in _SPREADSHEET_MCP_SERVICES
        ):
            service, label = _SPREADSHEET_MCP_SERVICES[node.extension]
            if not DingTalkDocService.get_user_dingtalk_mcp_url(user, service):
                raise ExternalDocumentImportError(
                    f"DingTalk {label} MCP is not configured or not enabled. Configure it in Settings > Integrations."
                )
        return {
            "provider": self.provider_id,
            "resource_id": node.dingtalk_node_id,
            "title": node.name,
            "url": node.doc_url,
        }

    @trace_async(tracer_name="knowledge.external_import")
    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        from app.services.dingtalk_doc_service import DingTalkDocService

        try:
            metadata = self.resolve_importable(db, user, external_resource_id)
        except ExternalDocumentImportError as exc:
            if exc.status_code == 404:
                # The synced node is gone or inactive: the source itself is
                # no longer accessible, not a transient fetch failure.
                raise ExternalSourceUnavailableError(str(exc)) from exc
            raise ExternalDocumentFetchError(str(exc)) from exc
        mcp_url = DingTalkDocService.get_user_dingtalk_mcp_url(user)
        if not mcp_url:
            raise ExternalDocumentFetchError(
                "DingTalk Docs MCP URL is not configured or not enabled"
            )
        try:
            async with asyncio.timeout(EXTERNAL_DOCUMENT_MCP_READ_TIMEOUT_SECONDS):
                extension, content = await self._fetch_document_content(
                    mcp_url, external_resource_id, user
                )
        except TimeoutError:
            raise ExternalDocumentFetchError("DingTalk import timed out") from None
        except ExternalDocumentFetchError:
            raise
        except Exception:
            raise ExternalDocumentFetchError("DingTalk content read failed") from None
        return ExternalDocumentContent(
            name=metadata["title"],
            file_extension=extension,
            content=content,
            metadata=metadata,
        )

    async def _fetch_document_content(
        self, mcp_url: str, node_id: str, user: User
    ) -> tuple[str, bytes]:
        """Verify live metadata before selecting the source reader."""
        from app.services.dingtalk_doc_service import DingTalkDocService

        async with open_dingtalk_session(mcp_url) as session:
            info = self._parse_mcp_response(
                await session.call_tool("get_document_info", {"nodeId": node_id}),
                "get_document_info",
            )
            extension = get_import_extension(info)
            if not extension:
                raise ExternalDocumentFetchError(
                    "This DingTalk file type cannot be imported"
                )
            if DingTalkDocService.is_online_document(info):
                payload = self._parse_mcp_response(
                    await session.call_tool(
                        "get_document_content",
                        {"nodeId": node_id, "format": "markdown"},
                    ),
                    "get_document_content",
                )
                markdown = payload.get("markdown")
                if not isinstance(markdown, str) or not markdown.strip():
                    raise ExternalDocumentFetchError(
                        "DingTalk document content is empty or unreadable"
                    )
                return "md", markdown.encode("utf-8")
            if str(info.get("contentType")).strip().upper() == "ALIDOC":
                source_extension = str(info.get("extension")).strip().lower()
                service, label = _SPREADSHEET_MCP_SERVICES[source_extension]
                export_url = DingTalkDocService.get_user_dingtalk_mcp_url(user, service)
                if not export_url:
                    raise ExternalDocumentFetchError(
                        f"DingTalk {label} MCP is not configured or not enabled. Configure it in Settings > Integrations."
                    )
                export = (
                    self._export_sheet
                    if source_extension == "axls"
                    else self._export_ai_table
                )
                return "xlsx", await export(export_url, node_id)
            payload = self._parse_mcp_response(
                await session.call_tool("download_file", {"nodeId": node_id}),
                "download_file",
            )
        urls = payload.get("resourceUrl")
        url = urls[0] if isinstance(urls, list) and urls else urls
        return extension, await download_content(url, payload.get("headers"))

    async def _export_sheet(self, url: str, node_id: str) -> bytes:
        """Export one workbook within fetch_content's existing timeout budget."""
        async with open_dingtalk_session(url) as session:
            submitted = self._parse_mcp_response(
                await session.call_tool(
                    "submit_export_job", {"nodeId": node_id, "exportFormat": "xlsx"}
                ),
                "submit_export_job",
            )
            job_id = submitted.get("jobId")
            if not isinstance(job_id, str) or not job_id.strip():
                raise ExternalDocumentFetchError(
                    "DingTalk sheet export returned no job ID"
                )
            while True:
                result = self._parse_mcp_response(
                    await session.call_tool("query_export_job", {"jobId": job_id}),
                    "query_export_job",
                )
                if result.get("jobId") != job_id:
                    raise ExternalDocumentFetchError(
                        "DingTalk sheet export job identity changed"
                    )
                if result.get("status") in {"failed", "error"}:
                    raise ExternalDocumentFetchError("DingTalk sheet export failed")
                if result.get("status") == "success" and result.get("downloadUrl"):
                    return await download_content(result["downloadUrl"])
                await asyncio.sleep(2)

    async def _export_ai_table(self, url: str, node_id: str) -> bytes:
        """Export one Base snapshot, resuming the same job within a bounded budget."""

        arguments = {
            "baseId": node_id,
            "scope": "all",
            "format": "excel",
            "timeoutMs": 30000,
        }
        async with open_dingtalk_session(url) as session:
            for _ in range(6):
                payload = self._parse_mcp_response(
                    await session.call_tool("export_data", arguments), "export_data"
                )
                data = payload.get("data")
                if not isinstance(data, dict):
                    raise ExternalDocumentFetchError(
                        "DingTalk export returned invalid data"
                    )
                task_id = data.get("taskId")
                if "taskId" in arguments and task_id != arguments["taskId"]:
                    raise ExternalDocumentFetchError(
                        "DingTalk export task identity changed"
                    )
                if data.get("status") == "success":
                    filename = data.get("fileName")
                    if not isinstance(filename, str) or not filename.lower().endswith(
                        ".xlsx"
                    ):
                        raise ExternalDocumentFetchError(
                            "DingTalk export did not return an XLSX workbook"
                        )
                    # Completion can precede publication of the download URL.
                    if data.get("downloadUrl"):
                        return await download_content(data["downloadUrl"])
                if (
                    data.get("status") not in {"pending", "success"}
                    or not isinstance(task_id, str)
                    or not task_id.strip()
                ):
                    raise ExternalDocumentFetchError("DingTalk AI Table export failed")
                arguments = {"baseId": node_id, "taskId": task_id, "timeoutMs": 30000}
                await asyncio.sleep(0.2)
        raise ExternalDocumentFetchError("DingTalk AI Table export timed out")

    @staticmethod
    def _parse_mcp_response(result: Any, tool_name: str) -> dict[str, Any]:
        """Decode the official JSON envelope without importing error text."""
        if getattr(result, "isError", False):
            raise ExternalDocumentFetchError(
                f"DingTalk MCP returned an error for {tool_name}"
            )
        texts = [
            getattr(item, "text", "")
            for item in getattr(result, "content", None) or []
            if getattr(item, "type", None) == "text"
        ]
        try:
            payload = json.loads("\n".join(texts))
        except (ValueError, TypeError) as exc:
            raise ExternalDocumentFetchError(
                f"DingTalk MCP returned invalid JSON for {tool_name}"
            ) from exc
        # AI Table tools use a status envelope; Docs tools use a boolean flag.
        succeeded = isinstance(payload, dict) and (
            payload.get("status") == "success"
            if tool_name == "export_data"
            else payload.get("success") is True
        )
        if not succeeded:
            raise ExternalDocumentFetchError(
                f"DingTalk MCP returned an unsuccessful response for {tool_name}"
            )
        return payload


_EXTERNAL_DOCUMENT_PROVIDERS: dict[str, ExternalDocumentProvider] = {}


def register_external_document_provider(provider: ExternalDocumentProvider) -> None:
    """Register a provider adapter under its provider_id."""
    _EXTERNAL_DOCUMENT_PROVIDERS[provider.provider_id] = provider


def get_external_document_provider(
    provider_id: str,
) -> ExternalDocumentProvider | None:
    """Return the registered adapter for a provider ID, or None."""
    return _EXTERNAL_DOCUMENT_PROVIDERS.get((provider_id or "").strip().lower())


register_external_document_provider(DingTalkExternalDocumentProvider())
