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
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

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
        ) -> tuple[str, bytes]:
            return "md", markdown.encode("utf-8")

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
        extension, content = await provider._fetch_document_content(
            "https://mcp.example.test/dingtalk",
            "node-1",
            SimpleNamespace(),
        )

        assert (extension, content) == ("md", b"# Imported")
        assert observed["transport"] == {
            "url": "https://mcp.example.test/dingtalk",
            "sse_read_timeout": 180,
        }
        assert observed["session"] == ("read-stream", "write-stream", 180.0)
        assert observed["call"] == (
            "get_document_content",
            {"nodeId": "node-1", "format": "markdown"},
        )
