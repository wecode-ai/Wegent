# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reusable contract tests for external document provider adapters.

``ProviderContractSuite`` encodes the provider-neutral contract every adapter
must fulfil (registry, resolution, fetch, and the source-unavailable signal).
A new adapter — e.g. the internal WeiboAP documents provider — only subclasses
the suite and implements the small fixture hooks below; it inherits the whole
contract coverage instead of rewriting it. DingTalk is the reference adapter.
"""

import json
import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    ExternalDocumentImportError,
    ExternalSourceUnavailableError,
    get_external_document_provider,
)


class ProviderContractSuite:
    """Contract every external document provider adapter must fulfil.

    Subclasses implement the hooks so the shared tests run against the
    adapter's own backing store and configuration.
    """

    provider_id: str

    def make_provider(self):
        """Return the provider adapter instance under test."""
        raise NotImplementedError

    def configure_user(self, monkeypatch: pytest.MonkeyPatch, user: User) -> None:
        """Make the provider report as configured for this user."""
        raise NotImplementedError

    def create_resource(
        self,
        test_db: Session,
        user: User,
        resource_id: str,
        name: str = "Contract Doc",
    ) -> Any:
        """Create a backing resource the provider can resolve."""
        raise NotImplementedError

    def remove_resource(
        self,
        test_db: Session,
        user: User,
        resource_id: str,
    ) -> None:
        """Make the resource unresolvable for this user (deleted / revoked)."""
        raise NotImplementedError

    def mock_fetch_body(
        self,
        monkeypatch: pytest.MonkeyPatch,
        provider,
        markdown: str,
    ) -> None:
        """Make fetch_content return this body without external calls."""
        raise NotImplementedError

    # --- Shared contract tests ---

    def test_adapter_is_registered(self) -> None:
        provider = get_external_document_provider(self.provider_id)

        assert provider is not None
        assert provider.provider_id == self.provider_id

    def test_resolve_returns_display_metadata(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)
        self.create_resource(test_db, test_user, "contract-resolve", "Resolve Doc")

        metadata = provider.resolve_importable(test_db, test_user, "contract-resolve")

        assert metadata["provider"] == self.provider_id
        assert metadata["resource_id"] == "contract-resolve"
        assert metadata["title"] == "Resolve Doc"
        assert metadata["url"]

    def test_resolve_rejects_unknown_resource(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            provider.resolve_importable(test_db, test_user, "contract-missing")

        assert exc_info.value.status_code == 404

    def test_fetch_returns_attachment_ready_content(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import asyncio

        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)
        self.create_resource(test_db, test_user, "contract-fetch", "Fetch Doc")
        self.mock_fetch_body(monkeypatch, provider, "# Fetch Doc body")

        content = asyncio.run(
            provider.fetch_content(test_db, test_user, "contract-fetch")
        )

        assert isinstance(content, ExternalDocumentContent)
        assert content.name == "Fetch Doc"
        assert content.content == b"# Fetch Doc body"
        assert content.file_extension
        assert content.metadata.get("title") == "Fetch Doc"

    def test_fetch_of_removed_source_signals_unavailable(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import asyncio

        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)
        self.create_resource(test_db, test_user, "contract-gone", "Gone Doc")
        self.remove_resource(test_db, test_user, "contract-gone")

        with pytest.raises(ExternalSourceUnavailableError):
            asyncio.run(provider.fetch_content(test_db, test_user, "contract-gone"))


class TestDingTalkProviderContract(ProviderContractSuite):
    """The DingTalk adapter against the shared provider contract."""

    provider_id = "dingtalk"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "value,expected",
        [
            (1789562644000, 1789562644000),
            ("1789562644000", 1789562644000),
            (None, None),
            (0, None),
            (-1, None),
            (True, None),
            ("not-a-timestamp", None),
        ],
    )
    async def test_live_timestamp_probe_only_accepts_a_positive_epoch(
        self, test_user, monkeypatch, value, expected
    ):
        self.configure_user(monkeypatch, test_user)
        session = SimpleNamespace(
            call_tool=AsyncMock(
                return_value=SimpleNamespace(
                    isError=False,
                    content=[
                        SimpleNamespace(
                            type="text",
                            text=json.dumps({"success": True, "updateTime": value}),
                        )
                    ],
                )
            )
        )

        @asynccontextmanager
        async def connected(url):
            yield session

        monkeypatch.setattr(
            "app.services.knowledge.external_document_providers.open_dingtalk_session",
            connected,
        )
        assert (
            await self.make_provider().get_update_time(test_user, "probe-node")
            == expected
        )
        session.call_tool.assert_awaited_once_with(
            "get_document_info", {"nodeId": "probe-node"}
        )

    @pytest.mark.asyncio
    async def test_probe_failure_names_the_underlying_cause(
        self, test_user, monkeypatch
    ):
        from app.services.knowledge.external_document_providers import (
            ExternalDocumentFetchError,
        )

        self.configure_user(monkeypatch, test_user)
        session = SimpleNamespace(
            call_tool=AsyncMock(side_effect=RuntimeError("connection reset"))
        )

        @asynccontextmanager
        async def connected(url):
            yield session

        monkeypatch.setattr(
            "app.services.knowledge.external_document_providers.open_dingtalk_session",
            connected,
        )

        with pytest.raises(ExternalDocumentFetchError) as excinfo:
            await self.make_provider().get_update_time(test_user, "probe-node")

        assert "RuntimeError" in str(excinfo.value)

    @pytest.mark.asyncio
    async def test_unusable_update_time_is_logged_with_its_value(
        self, test_user, monkeypatch, caplog
    ):
        self.configure_user(monkeypatch, test_user)
        session = SimpleNamespace(
            call_tool=AsyncMock(
                return_value=SimpleNamespace(
                    isError=False,
                    content=[
                        SimpleNamespace(
                            type="text",
                            text=json.dumps(
                                {"success": True, "updateTime": "not-a-timestamp"}
                            ),
                        )
                    ],
                )
            )
        )

        @asynccontextmanager
        async def connected(url):
            yield session

        monkeypatch.setattr(
            "app.services.knowledge.external_document_providers.open_dingtalk_session",
            connected,
        )

        with caplog.at_level(
            logging.WARNING,
            logger="app.services.knowledge.external_document_providers",
        ):
            assert (
                await self.make_provider().get_update_time(test_user, "probe-node")
                is None
            )

        assert "Unusable updateTime" in caplog.text
        assert "not-a-timestamp" in caplog.text

    @pytest.mark.asyncio
    async def test_fetch_reports_the_live_source_timestamp(
        self, test_db, test_user, monkeypatch
    ):
        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)
        self.create_resource(test_db, test_user, "timestamped-copy", "Timestamped Doc")
        self.mock_fetch_body(monkeypatch, provider, "body")

        content = await provider.fetch_content(test_db, test_user, "timestamped-copy")

        assert content.metadata["source_update_time"] == 1789562644000

    @pytest.mark.asyncio
    async def test_fetch_requires_a_node_in_the_user_directory(
        self, test_db, test_user, monkeypatch
    ):
        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)
        self.mock_fetch_body(monkeypatch, provider, "body")

        with pytest.raises(ExternalSourceUnavailableError):
            await provider.fetch_content(test_db, test_user, "not-in-cache")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "envelope",
        [
            # Real capture (2026-09-18): a deleted document, recycled upstream.
            {
                "success": False,
                "errorCode": "invalidParameter.item.notFound",
                "errorMsg": "workspace node has been recycled",
                "logId": "2135ce2f17897129652262261e04fa",
            },
            # Real capture: a well-formed dentryUuid that never existed.
            {
                "success": False,
                "errorCode": "invalidRequest.resource.notFound",
                "errorMsg": "Data not found",
                "logId": "2135ce2f17897129141858836e057e",
            },
        ],
    )
    async def test_node_metadata_naming_a_gone_source_signals_unavailable(
        self, test_user, monkeypatch, envelope
    ):
        """A positively gone node keeps its reason distinct from a fetch failure."""
        self.configure_user(monkeypatch, test_user)
        self.answer_document_info(monkeypatch, envelope)

        with pytest.raises(ExternalSourceUnavailableError) as excinfo:
            await self.make_provider().get_update_time(test_user, "probe-node")

        assert excinfo.value.error_code == "external_source_missing"
        # The user-facing record keeps the provider's own message and logId:
        # DingTalk support asks for the logId when troubleshooting.
        assert envelope["errorMsg"] in str(excinfo.value)
        assert envelope["logId"] in str(excinfo.value)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "result",
        [
            # Real capture: a malformed nodeId is an input problem, not a
            # gone source.
            {
                "success": False,
                "errorCode": "invalidRequest.inputArgs.invalid",
                "errorMsg": (
                    "nodeId 格式不合法，非 URL 格式时 nodeId 须为 dentryUuid：32 位"
                    "字母数字字符串。收到：nonexistent-node-12345（22 个字符）。"
                ),
                "logId": "2135ce2f17897129143658854e057e",
            },
            # Real capture (read path): the message names both not-exist and
            # no-access under an input-args code. Without a captured revoked
            # permission sample no permission classification is made.
            {
                "success": False,
                "errorCode": "invalidRequest.inputArgs.invalid",
                "errorMsg": (
                    "指定的节点不存在或无权访问，请确认节点 ID 正确且您有权访问"
                    "该节点。dentryUuid: 00000000000000000000000000000000"
                ),
                "logId": "2127f60017897129501712230e04ea",
            },
            # Unknown code: only captured codes may mark a source gone.
            {"success": False, "errorCode": "server.internal.error"},
            # No structured code at all.
            {"success": False, "message": "rate limited, please retry"},
            {"success": False},
            SimpleNamespace(
                isError=True,
                content=[SimpleNamespace(type="text", text="internal server error")],
            ),
        ],
    )
    async def test_metadata_failure_without_source_evidence_stays_transient(
        self, test_user, monkeypatch, result
    ):
        """Only captured error codes may turn a probe failure into a gone source."""
        from app.services.knowledge.external_document_providers import (
            ExternalDocumentFetchError,
        )

        self.configure_user(monkeypatch, test_user)
        self.answer_document_info(monkeypatch, result)

        with pytest.raises(ExternalDocumentFetchError) as excinfo:
            await self.make_provider().get_update_time(test_user, "probe-node")

        assert not isinstance(excinfo.value, ExternalSourceUnavailableError)
        # A structured envelope failure keeps its provider detail for the
        # user-facing record instead of collapsing to a generic wrapper.
        if isinstance(result, dict) and result.get("errorCode"):
            assert result["errorCode"] in str(excinfo.value)
            if result.get("errorMsg"):
                assert result["errorMsg"] in str(excinfo.value)

    @pytest.mark.asyncio
    async def test_fetch_turns_a_deleted_node_into_a_missing_source(
        self, test_db, test_user, monkeypatch
    ):
        provider = self.make_provider()
        self.configure_user(monkeypatch, test_user)
        self.create_resource(test_db, test_user, "deleted-copy", "Deleted Doc")
        # Real capture: the node was deleted upstream and recycled.
        self.answer_document_info(
            monkeypatch,
            {
                "success": False,
                "errorCode": "invalidParameter.item.notFound",
                "errorMsg": "workspace node has been recycled",
                "logId": "2135ce2f17897129652262261e04fa",
            },
        )

        with pytest.raises(ExternalSourceUnavailableError) as excinfo:
            await provider.fetch_content(test_db, test_user, "deleted-copy")

        assert excinfo.value.error_code == "external_source_missing"
        assert "workspace node has been recycled" in str(excinfo.value)

    @staticmethod
    def answer_document_info(monkeypatch: pytest.MonkeyPatch, result: Any) -> None:
        """Answer every MCP call with one canned ``get_document_info`` result."""
        if not isinstance(result, SimpleNamespace):
            result = SimpleNamespace(
                isError=False,
                # The provider sends raw UTF-8, so payloads arrive verbatim.
                content=[
                    SimpleNamespace(
                        type="text", text=json.dumps(result, ensure_ascii=False)
                    )
                ],
            )
        session = SimpleNamespace(call_tool=AsyncMock(return_value=result))

        @asynccontextmanager
        async def connected(url):
            yield session

        monkeypatch.setattr(
            "app.services.knowledge.external_document_providers.open_dingtalk_session",
            connected,
        )

    def make_provider(self):
        from app.services.knowledge.external_document_providers import (
            DingTalkExternalDocumentProvider,
        )

        return DingTalkExternalDocumentProvider()

    def configure_user(self, monkeypatch: pytest.MonkeyPatch, user: User) -> None:
        monkeypatch.setattr(
            "app.services.dingtalk_doc_service.DingTalkDocService.is_configured",
            lambda user: True,
        )
        monkeypatch.setattr(
            "app.services.dingtalk_doc_service.DingTalkDocService"
            ".get_user_dingtalk_mcp_url",
            lambda user: "https://mcp.example.test/dingtalk",
        )

    def create_resource(
        self,
        test_db: Session,
        user: User,
        resource_id: str,
        name: str = "Contract Doc",
    ) -> Any:
        from datetime import datetime, timezone

        from app.models.dingtalk_doc import DingtalkSyncedNode

        node = DingtalkSyncedNode(
            user_id=user.id,
            dingtalk_node_id=resource_id,
            name=name,
            doc_url=f"https://alidocs.dingtalk.com/i/nodes/{resource_id}",
            parent_node_id="",
            node_type="doc",
            content_type="ALIDOC",
            raw_metadata={"extension": "adoc"},
            workspace_id="",
            is_active=True,
            last_synced_at=datetime.now(timezone.utc),
        )
        test_db.add(node)
        test_db.commit()
        return node

    def remove_resource(
        self,
        test_db: Session,
        user: User,
        resource_id: str,
    ) -> None:
        from app.models.dingtalk_doc import DingtalkSyncedNode

        test_db.query(DingtalkSyncedNode).filter(
            DingtalkSyncedNode.user_id == user.id,
            DingtalkSyncedNode.dingtalk_node_id == resource_id,
        ).update({"is_active": False})
        test_db.commit()

    def mock_fetch_body(
        self,
        monkeypatch: pytest.MonkeyPatch,
        provider,
        markdown: str,
    ) -> None:
        async def fake_fetch(
            mcp_url: str, node_id: str, user: User
        ) -> tuple[str, bytes, int | None]:
            return "md", markdown.encode("utf-8"), 1789562644000

        monkeypatch.setattr(provider, "_fetch_document_content", fake_fetch)

    @pytest.mark.asyncio
    async def test_mcp_fetch_sets_explicit_read_timeouts(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import mcp
        from mcp.client import streamable_http

        observed: dict[str, object] = {}

        @asynccontextmanager
        async def fake_transport(**kwargs):
            observed["transport"] = kwargs
            yield ("read-stream", "write-stream", lambda: None)

        class FakeClientSession:
            def __init__(self, read_stream, write_stream, read_timeout_seconds):
                observed["session"] = (
                    read_stream,
                    write_stream,
                    read_timeout_seconds.total_seconds(),
                )

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def initialize(self):
                return None

            async def call_tool(self, name, arguments):
                observed["call"] = (name, arguments)
                payload = (
                    {
                        "success": True,
                        "nodeType": "file",
                        "contentType": "ALIDOC",
                        "extension": "adoc",
                        "updateTime": 1789562644000,
                    }
                    if name == "get_document_info"
                    else {"success": True, "markdown": "# Imported"}
                )
                return SimpleNamespace(
                    isError=False,
                    content=[SimpleNamespace(type="text", text=json.dumps(payload))],
                )

        monkeypatch.setattr(streamable_http, "streamablehttp_client", fake_transport)
        monkeypatch.setattr(mcp, "ClientSession", FakeClientSession)

        provider = self.make_provider()
        extension, content, update_time = await provider._fetch_document_content(
            "https://mcp.example.test/dingtalk",
            "node-1",
            SimpleNamespace(),
        )

        assert (extension, content) == ("md", b"# Imported")
        assert update_time == 1789562644000
        assert observed["transport"] == {
            "url": "https://mcp.example.test/dingtalk",
            "sse_read_timeout": 180,
        }
        assert observed["session"] == ("read-stream", "write-stream", 180.0)
        assert observed["call"] == (
            "get_document_content",
            {"nodeId": "node-1", "format": "markdown"},
        )
