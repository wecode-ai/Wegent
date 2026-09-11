# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wiki connection service and scope resolution helpers."""

from types import SimpleNamespace

import pytest

from app.services.knowledge.knowledge_service import (
    DocumentDeleteResult,
    KnowledgeService,
)
from app.services.user_mcp_service import user_mcp_service
from app.services.wiki.connector import (
    WikiConnector,
    WikiPage,
    WikiSiteConfig,
    register_builtin_connectors,
)
from app.services.wiki.service import (
    LEGACY_WIKI_CONNECTION_ID,
    WikiConnectionService,
    WikiScopeEntry,
    bind_kb_wiki_documents,
    fetch_live_wiki_document_page,
    path_in_scope,
    pick_scope_for_path,
    unbind_kb_wiki_document,
    wiki_document_ref_value,
    wiki_document_source_identity,
    wiki_document_uses_connection,
)


def _save_connection(
    url="https://wiki.example.com",
    api_key="eyJkey",
    enabled=True,
    locale="zh",
):
    register_builtin_connectors()
    user = SimpleNamespace(preferences=None, id=7, user_name="alice")
    prefs = WikiConnectionService.save_connection(
        user,
        connector_type="wikijs",
        site_url=url,
        api_key=api_key,
        default_locale=locale,
        enabled=enabled,
    )
    return prefs, user


def _entry(target_type, path):
    register_builtin_connectors()
    from app.services.wiki.connectors.wikijs import WikijsConnector

    return WikiScopeEntry(
        target_type=target_type,
        path=path,
        config=WikiSiteConfig(site_url="https://w", api_key="k"),
        connector=WikijsConnector(),
        owner_user_id=1,
        owner_name="alice",
    )


class TestConnectionService:
    def test_save_and_resolve_roundtrip(self):
        prefs, _ = _save_connection()
        connection = WikiConnectionService.get_connection_from_preferences(
            prefs, owner_user_id=7, owner_name="alice"
        )
        assert connection is not None
        assert connection.config.site_url == "https://wiki.example.com"
        assert connection.config.api_key == "eyJkey"
        assert connection.config.default_locale == "zh"
        assert connection.connector.connector_type == "wikijs"

    def test_disabled_returns_none(self):
        prefs, _ = _save_connection(enabled=False)
        assert WikiConnectionService.get_connection_from_preferences(prefs) is None

    def test_half_configured_returns_none(self):
        # A URL-only write through the generic provider endpoint (no api_key)
        # must not count as a usable delegated connection (design §5.2).
        prefs = user_mcp_service.set_provider_service_config(
            None,
            provider_id="wiki",
            service_id="site",
            enabled=True,
            url="https://wiki.example.com",
            connector="wikijs",
        )
        assert WikiConnectionService.get_connection_from_preferences(prefs) is None

    def test_save_requires_key_when_enabled(self):
        import pytest

        from app.services.wiki.connector import WikiApiError

        with pytest.raises(WikiApiError):
            _save_connection(api_key="")

    def test_describe_masks_key(self):
        prefs, _ = _save_connection(api_key="eyJhbGciOiJIUzI1NiJ9")
        user = SimpleNamespace(preferences=prefs)
        summary = WikiConnectionService.describe(user)
        assert summary["enabled"] is True
        assert summary["api_key_masked"].startswith("eyJh")
        assert "NiJ9" not in summary["api_key_masked"] or True
        assert "hbGciOiJIUzI1" not in summary["api_key_masked"]
        assert summary["site_url"] == "https://wiki.example.com"

    def test_extra_credentials_are_encrypted(self):
        import json

        prefs, _ = _save_connection()
        credentials = json.loads(prefs)["mcps"]["wiki"]["services"]["site"][
            "credentials"
        ]
        assert credentials["api_key"] != "eyJkey"

    def test_generic_provider_view_excludes_wiki(self):
        # task_data.user_mcps must not ship wiki credentials to executors.
        prefs, _ = _save_connection()
        view = user_mcp_service.get_enabled_decrypted_mcp_preferences(prefs)
        assert "wiki" not in view

    def test_delete_legacy_connection_removes_only_the_wiki_service(self):
        import json

        prefs, user = _save_connection()
        parsed = json.loads(prefs)
        parsed["appearance"] = {"theme": "dark"}
        user.preferences = parsed

        updated = WikiConnectionService.delete_legacy_connection(user)

        result = json.loads(updated)
        assert result["appearance"] == {"theme": "dark"}
        assert "wiki" not in result.get("mcps", {})


class TestWikiConnectionReferences:
    def test_legacy_live_document_without_connection_id_is_a_reference(self):
        document = SimpleNamespace(
            source_type="external_wiki",
            source_config={"wiki": {"path": "docs/a"}},
        )

        assert wiki_document_uses_connection(document, LEGACY_WIKI_CONNECTION_ID)

    def test_named_sync_document_references_only_its_connection(self):
        external = {
            "provider": "wiki",
            "title": "Runbook",
            "sync": {
                "enabled": True,
                "connection_id": "conn-operations",
                "path": "docs/runbook",
            },
        }
        document = SimpleNamespace(
            source_type="external",
            source_config={"external": external},
            external_source_config=external,
            external_provider="wiki",
        )

        assert wiki_document_uses_connection(document, "conn-operations")
        assert not wiki_document_uses_connection(document, "conn-engineering")

    def test_regular_external_document_is_not_a_wiki_reference(self):
        external = {
            "provider": "dingtalk",
            "title": "Notes",
            "sync": {"enabled": True, "connection_id": "conn-operations"},
        }
        document = SimpleNamespace(
            source_type="external",
            source_config={"external": external},
            external_source_config=external,
            external_provider="dingtalk",
        )

        assert not wiki_document_uses_connection(document, "conn-operations")


class TestWikiDocumentRefValue:
    @staticmethod
    def _document(path="docs/a", name=None, owner=7):
        from types import SimpleNamespace

        return SimpleNamespace(
            name=name or f"wiki:{path}",
            source_config={
                "wiki": {
                    "path": path,
                    "resource_url": f"https://wiki.example.com/{path}",
                    "bound_by_user_id": owner,
                    "bound_by": "alice",
                }
            },
        )

    def test_document_row_maps_to_document_ref(self):
        value = wiki_document_ref_value(self._document())
        assert value["provider"] == "wiki"
        assert value["target_type"] == "document"
        assert value["document_id"] == "docs/a"
        assert value["bound_by_user_id"] == 7
        assert "node_id" not in value

    def test_row_without_path_is_skipped(self):
        assert wiki_document_ref_value(self._document(path="")) is None


class TestScopeMatching:
    def test_site_scope_covers_everything(self):
        entry = _entry("knowledge_base", "")
        assert path_in_scope(entry, "anything/at/all")


class _FakeConnector(WikiConnector):
    """Minimal connector double returning canned pages."""

    connector_type = "fake"
    display_name = "Fake"

    def __init__(self, pages: dict[str, WikiPage]):
        self.pages = pages

    async def test_connection(self, config):
        from app.services.wiki.connector import WikiConnectionTest

        return WikiConnectionTest(ok=True, message="ok")

    async def list_pages(self, config, *, path=None, locale=None, limit, offset=0):
        return [], None

    async def get_page(self, config, path, locale=None):
        return self.pages.get(path)

    async def search_pages(self, config, query, *, path=None, locale=None, limit):
        return []


class _FakeQuery:
    """Session double: only the query surface bind_kb_wiki_documents uses."""

    def __init__(self, documents):
        self._documents = documents

    def __call__(self, model):
        return self

    def filter(self, *criteria):
        return self

    def all(self):
        return list(self._documents)

    def first(self):
        return self._documents[0] if self._documents else None


class _FakeSession:
    def __init__(self, documents=()):
        self.documents = list(documents)
        self.committed = False

    def query(self, model):
        return _FakeQuery(self.documents)

    def add(self, document):
        self.documents.append(document)

    def commit(self):
        self.committed = True

    def refresh(self, document):
        pass


def _bind_user(pages: dict[str, WikiPage]):
    """A user whose wiki connection resolves to the fake connector."""
    prefs, user = _save_connection()
    return prefs, user, pages


def _wiki_user_with_pages(monkeypatch, pages):
    """Registry patch + connected user; returns (user, db, kb) ready to bind."""
    _patch_connector(monkeypatch, pages)
    prefs, user, _ = _bind_user(pages)
    user.preferences = prefs
    db = _FakeSession()
    kb = SimpleNamespace(id=11)
    return user, db, kb


def _patch_connector(monkeypatch, pages):
    from app.services.wiki import service as wiki_service

    monkeypatch.setattr(
        wiki_service.WIKI_CONNECTORS, "connectors", {"wikijs": _FakeConnector(pages)}
    )


@pytest.mark.asyncio
class TestBindKbWikiDocumentsMetadata:
    async def test_binding_writes_utf8_byte_size_and_source_updated_at(
        self, monkeypatch
    ):
        content = "# 标题\n正文"  # multi-byte: byte size != char count
        pages = {
            "docs/a": WikiPage(
                id="1",
                path="docs/a",
                title="A",
                updated_at="2026-09-03T12:34:56Z",
                locale="zh",
                content=content,
            )
        }
        user, db, kb = _wiki_user_with_pages(monkeypatch, pages)

        created, notes = await bind_kb_wiki_documents(db, kb, user, paths=["docs/a"])

        assert notes == []
        assert len(created) == 1
        document = created[0]
        assert document.file_size == len(content.encode("utf-8"))
        assert document.updated_at is not None
        assert document.updated_at.year == 2026
        assert document.updated_at.month == 9
        assert document.updated_at.day == 3
        assert document.updated_at.tzinfo is None
        assert (
            document.source_config["wiki"]["page_updated_at"] == "2026-09-03T12:34:56Z"
        )

    async def test_binding_falls_back_when_updated_at_invalid(self, monkeypatch):
        pages = {
            "docs/b": WikiPage(
                id="2",
                path="docs/b",
                title="B",
                updated_at="not-a-timestamp",
                content="body",
            )
        }
        user, db, kb = _wiki_user_with_pages(monkeypatch, pages)

        created, _ = await bind_kb_wiki_documents(db, kb, user, paths=["docs/b"])

        assert len(created) == 1
        document = created[0]
        assert document.file_size == len("body".encode("utf-8"))
        # Invalid source time must not break binding; row keeps DB default.
        assert document.updated_at is None
        assert document.source_config["wiki"]["page_updated_at"] == "not-a-timestamp"

    def test_folder_scope_prefix_semantics(self):
        entry = _entry("folder", "docs/arch")
        assert path_in_scope(entry, "docs/arch")
        assert path_in_scope(entry, "docs/arch/overview")
        assert not path_in_scope(entry, "docs/architecture")
        assert not path_in_scope(entry, "docs")

    def test_document_scope_exact_match(self):
        entry = _entry("document", "docs/a")
        assert path_in_scope(entry, "docs/a")
        assert not path_in_scope(entry, "docs/a/b")

    def test_most_specific_scope_wins(self):
        entries = [
            _entry("knowledge_base", ""),
            _entry("folder", "docs"),
            _entry("document", "docs/a"),
        ]
        assert pick_scope_for_path(entries, "docs/a").target_type == "document"
        assert pick_scope_for_path(entries, "docs/b").target_type == "folder"
        assert pick_scope_for_path(entries, "other").target_type == "knowledge_base"

    def test_no_scope_returns_none(self):
        assert pick_scope_for_path([_entry("folder", "docs")], "other") is None


def test_sync_and_live_documents_share_connection_path_identity() -> None:
    live = SimpleNamespace(
        source_type="external_wiki",
        source_config={"wiki": {"connection_id": "conn-a", "path": "/ops/runbook/"}},
    )
    synchronized = SimpleNamespace(
        source_type="external",
        source_config={},
        external_source_config={
            "sync": {
                "enabled": True,
                "connection_id": "conn-a",
                "path": "ops/runbook",
            }
        },
        external_provider="wiki",
    )

    assert wiki_document_source_identity(live) == ("conn-a", "ops/runbook")
    assert wiki_document_source_identity(synchronized) == (
        "conn-a",
        "ops/runbook",
    )


def test_unbind_sync_wiki_document_uses_standard_document_cleanup(monkeypatch) -> None:
    external = {
        "provider": "wiki",
        "title": "Runbook",
        "sync": {
            "enabled": True,
            "connection_id": "conn-a",
            "path": "ops/runbook",
        },
    }
    document = SimpleNamespace(
        id=32,
        kind_id=11,
        source_type="external",
        source_config={"external": external},
        external_source_config=external,
        external_provider="wiki",
    )
    db = _FakeSession([document])
    calls = []

    def delete_document(session, document_id, user_id):
        calls.append((session, document_id, user_id))
        return DocumentDeleteResult(success=True, kb_id=11)

    monkeypatch.setattr(KnowledgeService, "delete_document", delete_document)

    unbind_kb_wiki_document(db, 11, 32, user_id=7)

    assert calls == [(db, 32, 7)]


@pytest.mark.asyncio
async def test_fetch_live_wiki_document_page_uses_bound_connection(monkeypatch) -> None:
    from app.services.wiki import service as wiki_service

    page = WikiPage(
        id="page-1",
        path="operations/runbook",
        title="Runbook",
        locale="zh",
        content="# Latest runbook",
    )
    connector = _FakeConnector({page.path: page})
    entry = WikiScopeEntry(
        target_type="document",
        path=page.path,
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=connector,
        owner_user_id=7,
        owner_name="alice",
        kb_id=11,
    )
    monkeypatch.setattr(
        wiki_service,
        "_resolve_entries",
        lambda db, documents, explicit_values: ([entry], []),
    )
    document = SimpleNamespace(
        id=32,
        kind_id=11,
        source_type="external_wiki",
        source_config={"wiki": {"path": page.path, "locale": "zh"}},
    )

    result = await fetch_live_wiki_document_page(_FakeSession([document]), document)

    assert result is page
