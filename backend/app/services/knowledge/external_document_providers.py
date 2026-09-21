# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral seams for fetching and directly importing external documents.

Every provider can fetch a persisted external identity into content that the
attachment / conversion / indexing pipeline can consume. Providers that also
resolve caller-supplied resource IDs implement the narrower direct-import
interface. A new adapter registers here and reuses the import state machine
instead of duplicating it.
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
from app.services.knowledge.external_document_identity import WIKI_PROVIDER_ID
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

    def __init__(
        self,
        message: str,
        *,
        error_code: str = "external_import_failed",
        retryable: bool = True,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.retryable = retryable


class ExternalSourceUnavailableError(ExternalDocumentFetchError):
    """The external source no longer exists or the user lost access to it.

    Raised by ``fetch_content`` when the provider can positively tell the
    resource is gone (or permission was revoked). The import marks the
    document's source as inaccessible; it is distinct from a transient fetch
    failure and the failed initial import may be retried.
    """

    def __init__(
        self,
        message: str,
        *,
        error_code: str = "external_source_unavailable",
    ) -> None:
        super().__init__(message, error_code=error_code, retryable=True)


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


@dataclass(frozen=True)
class PreparedExternalDocumentFetch:
    """Provider-owned payload detached from the database Session."""

    external_resource_id: str
    payload: Any = field(repr=False)


class ExternalDocumentProvider(ABC):
    """Contract for fetching a persisted external document body."""

    provider_id: str

    @abstractmethod
    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        """Fetch the document body as attachment-ready content.

        Reports ``source_update_time`` in ``metadata`` when the provider can
        tell when the fetched body was last changed, so an automatic refresh
        can keep a baseline that belongs to the body it just landed.

        Raises ExternalSourceUnavailableError when the provider can tell the
        resource is gone or access was revoked, ExternalDocumentFetchError
        for transient failures.
        """


class DirectExternalDocumentImportProvider(ExternalDocumentProvider):
    """Provider that can synchronously resolve a caller-supplied resource ID."""

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


class DetachedExternalDocumentProvider(ExternalDocumentProvider):
    """Provider whose remote fetch can run after releasing the DB Session."""

    @abstractmethod
    def prepare_content_fetch(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
        external_metadata: dict[str, Any] | None = None,
    ) -> PreparedExternalDocumentFetch:
        """Resolve database-backed metadata into a detached provider payload."""

    @abstractmethod
    async def fetch_prepared_content(
        self, prepared: PreparedExternalDocumentFetch
    ) -> ExternalDocumentContent:
        """Fetch a prepared document body without a database Session."""

    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        """Fetch through the detached phases when called via the base contract."""
        prepared = self.prepare_content_fetch(db, user, external_resource_id, None)
        return await self.fetch_prepared_content(prepared)


def _positive_update_time(value: Any) -> int | None:
    """Accept a positive epoch timestamp, including one sent as a digit string."""
    if isinstance(value, str) and value.strip().isdigit():
        # DingTalk sometimes serialises the epoch as a string; it is still usable.
        value = int(value)
    return value if type(value) is int and value > 0 else None


def _read_update_time(info: dict[str, Any], node_id: str) -> int | None:
    """Read the live source timestamp, making unusable values visible.

    Without a usable timestamp the probe has nothing to compare against the
    saved baseline, so the raw value must be identifiable in logs.
    """
    raw = info.get("updateTime")
    update_time = _positive_update_time(raw)
    if update_time is None and raw is not None:
        logger.warning(
            "[DingTalk Provider] Unusable updateTime node_id=%s value=%r",
            node_id,
            raw,
        )
    return update_time


class DingTalkExternalDocumentProvider(DirectExternalDocumentImportProvider):
    """DingTalk adapter backed by the user's DingTalk Docs MCP server."""

    provider_id = "dingtalk"

    @trace_async(tracer_name="knowledge.external_import")
    async def get_update_time(self, user: User, node_id: str) -> int | None:
        """Read the live node timestamp without fetching content or changing a copy."""
        from app.services.dingtalk_doc_service import DingTalkDocService

        url = DingTalkDocService.get_user_dingtalk_mcp_url(user)
        if not url:
            raise ExternalDocumentFetchError("DingTalk Docs is not configured")
        try:
            async with asyncio.timeout(EXTERNAL_DOCUMENT_MCP_READ_TIMEOUT_SECONDS):
                async with open_dingtalk_session(url) as session:
                    info = self._parse_mcp_response(
                        await session.call_tool(
                            "get_document_info", {"nodeId": node_id}
                        ),
                        "get_document_info",
                    )
        except TimeoutError:
            raise ExternalDocumentFetchError(
                "DingTalk metadata read timed out"
            ) from None
        except ExternalDocumentFetchError:
            raise
        except Exception as exc:
            # The cause class is enough to separate transport failures from MCP
            # protocol errors without echoing provider payloads into logs.
            raise ExternalDocumentFetchError(
                f"DingTalk metadata read failed: {type(exc).__name__}"
            ) from None
        return _read_update_time(info, node_id)

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
                extension, content, update_time = await self._fetch_document_content(
                    mcp_url, external_resource_id, user
                )
        except TimeoutError:
            raise ExternalDocumentFetchError("DingTalk import timed out") from None
        except ExternalDocumentFetchError:
            raise
        except Exception:
            raise ExternalDocumentFetchError("DingTalk content read failed") from None
        if update_time is not None:
            metadata = {**metadata, "source_update_time": update_time}
        return ExternalDocumentContent(
            name=metadata["title"],
            file_extension=extension,
            content=content,
            metadata=metadata,
        )

    async def _fetch_document_content(
        self, mcp_url: str, node_id: str, user: User
    ) -> tuple[str, bytes, int | None]:
        """Verify live metadata before selecting the source reader.

        Returns the body plus the live source timestamp read in the same
        session, so the caller can record a baseline matching this body.
        """
        from app.services.dingtalk_doc_service import DingTalkDocService

        async with open_dingtalk_session(mcp_url) as session:
            info = self._parse_mcp_response(
                await session.call_tool("get_document_info", {"nodeId": node_id}),
                "get_document_info",
            )
            update_time = _read_update_time(info, node_id)
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
                return "md", markdown.encode("utf-8"), update_time
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
                return "xlsx", await export(export_url, node_id), update_time
            payload = self._parse_mcp_response(
                await session.call_tool("download_file", {"nodeId": node_id}),
                "download_file",
            )
        urls = payload.get("resourceUrl")
        url = urls[0] if isinstance(urls, list) and urls else urls
        body = await download_content(url, payload.get("headers"))
        return extension, body, update_time

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
    normalized = (provider_id or "").strip().lower()
    if (
        normalized == WIKI_PROVIDER_ID
        and normalized not in _EXTERNAL_DOCUMENT_PROVIDERS
    ):
        # Import lazily so the provider-neutral base contract remains usable on
        # its own while the Wiki adapter can implement both provider seams.
        from app.services.knowledge.external_sync_providers import (  # noqa: PLC0415
            wiki_external_sync_provider,
        )

        register_external_document_provider(wiki_external_sync_provider)
    if normalized == "xiaoxin" and normalized not in _EXTERNAL_DOCUMENT_PROVIDERS:
        from app.services.knowledge.xiaoxin import XiaoxinExternalDocumentProvider

        register_external_document_provider(XiaoxinExternalDocumentProvider())
    return _EXTERNAL_DOCUMENT_PROVIDERS.get(normalized)


register_external_document_provider(DingTalkExternalDocumentProvider())
