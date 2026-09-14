# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the provider-neutral external synchronization seam."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.knowledge.external_sync_providers import (
    ExternalSyncLocator,
    SyncCandidate,
    decode_external_sync_resource_id,
    encode_external_sync_resource_id,
    wiki_external_sync_provider,
)
from app.services.wiki.connector import WikiApiError, WikiPageProbe, WikiSiteConfig


def test_external_sync_identity_round_trip() -> None:
    locator = ExternalSyncLocator("wiki", "conn-primary", "42")

    encoded = encode_external_sync_resource_id(locator)

    assert encoded == "v1:conn-primary:42"
    assert decode_external_sync_resource_id("wiki", encoded) == locator


@pytest.mark.asyncio
async def test_wiki_selection_is_resolved_with_server_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = SimpleNamespace(
        get_page_metadata_by_path=AsyncMock(
            return_value=SimpleNamespace(
                id="42",
                path="ops/runbook",
                title="Runbook",
                locale="zh",
                updated_at="2026-09-06T01:02:03Z",
            )
        )
    )
    connection = SimpleNamespace(
        connection_id="conn-primary",
        config=WikiSiteConfig(
            site_url="https://wiki.example.com",
            api_key="secret",
            default_locale="zh",
        ),
        connector=connector,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )

    db = MagicMock()
    resolved = await wiki_external_sync_provider.resolve_selections(
        db, SimpleNamespace(id=7), "conn-primary", ["/ops/runbook/"]
    )

    db.commit.assert_called_once_with()
    db.close.assert_not_called()
    assert len(resolved) == 1
    assert resolved[0].encoded_resource_id == "v1:conn-primary:42"
    assert resolved[0].external_metadata()["sync"] == {
        "enabled": True,
        "connection_id": "conn-primary",
        "resource_id": "42",
        "observed_version": "2026-09-06T01:02:03Z",
        "content_version": None,
        "indexed_version": None,
        "path": "ops/runbook",
        "locale": "zh",
        "site_url": "https://wiki.example.com",
    }


@pytest.mark.asyncio
async def test_wiki_remote_inspection_batches_by_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = SimpleNamespace(
        supports_scheduled_sync=True,
        inspect_page_metadata_by_ids=AsyncMock(
            return_value={
                "42": WikiPageProbe(
                    page=SimpleNamespace(
                        id="42",
                        path="ops/runbook",
                        title="Runbook v2",
                        locale="zh",
                        updated_at="2026-09-06T02:00:00Z",
                    )
                ),
                "missing": WikiPageProbe(confirmed_missing=True),
                "forbidden": WikiPageProbe(error_code="wiki_page_forbidden"),
            }
        ),
    )
    connection = SimpleNamespace(
        display_name="Primary Wiki",
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=connector,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )
    db = MagicMock()
    db.get.return_value = SimpleNamespace(id=7)
    candidates = [
        SyncCandidate(10, 7, ExternalSyncLocator("wiki", "conn-primary", "42")),
        SyncCandidate(11, 7, ExternalSyncLocator("wiki", "conn-primary", "missing")),
        SyncCandidate(12, 7, ExternalSyncLocator("wiki", "conn-primary", "forbidden")),
    ]

    prepared = wiki_external_sync_provider.prepare_remote_inspection(db, candidates)
    states = await wiki_external_sync_provider.inspect_remote_states(prepared)

    assert prepared.connection_names[(7, "conn-primary")] == "Primary Wiki"
    connector.inspect_page_metadata_by_ids.assert_awaited_once()
    assert states[10].remote_version == "2026-09-06T02:00:00Z"
    assert states[10].metadata["path"] == "ops/runbook"
    assert states[11].exists is False
    assert states[11].error_code == "external_source_missing"
    assert states[12].error_code == "wiki_page_forbidden"
    assert states[12].error_message == "无权访问 Wiki 源文档"


@pytest.mark.asyncio
async def test_wiki_remote_inspection_queries_bound_id_without_listing_site(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outside_window = SimpleNamespace(
        id="5001",
        path="ops/recent-runbook",
        title="Recent Runbook",
        locale="en",
        updated_at="2026-09-08T02:00:00Z",
    )
    connector = SimpleNamespace(
        supports_scheduled_sync=True,
        inspect_page_metadata_by_ids=AsyncMock(
            return_value={"5001": WikiPageProbe(page=outside_window)}
        ),
    )
    connection = SimpleNamespace(
        display_name="Primary Wiki",
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=connector,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )
    db = MagicMock()
    db.get.return_value = SimpleNamespace(id=7)
    candidate = SyncCandidate(
        12, 7, ExternalSyncLocator("wiki", "conn-primary", "5001")
    )

    prepared = wiki_external_sync_provider.prepare_remote_inspection(db, [candidate])
    states = await wiki_external_sync_provider.inspect_remote_states(prepared)

    connector.inspect_page_metadata_by_ids.assert_awaited_once()
    assert states[12].exists is True
    assert states[12].remote_version == "2026-09-08T02:00:00Z"
    assert states[12].metadata["path"] == "ops/recent-runbook"


@pytest.mark.asyncio
async def test_wiki_remote_inspection_does_not_treat_lookup_error_as_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = SimpleNamespace(
        supports_scheduled_sync=True,
        inspect_page_metadata_by_ids=AsyncMock(
            side_effect=WikiApiError("wiki_auth_failed", "bad key")
        ),
    )
    connection = SimpleNamespace(
        display_name="Primary Wiki",
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=connector,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )
    db = MagicMock()
    db.get.return_value = SimpleNamespace(id=7)
    candidate = SyncCandidate(
        13, 7, ExternalSyncLocator("wiki", "conn-primary", "5002")
    )

    prepared = wiki_external_sync_provider.prepare_remote_inspection(db, [candidate])
    states = await wiki_external_sync_provider.inspect_remote_states(prepared)

    assert states[13].exists is True
    assert states[13].error_code == "wiki_auth_failed"
    assert states[13].error_message == "bad key"


def test_wiki_remote_inspection_skips_inactive_owner() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    candidate = SyncCandidate(
        14, 7, ExternalSyncLocator("wiki", "conn-primary", "5003")
    )

    prepared = wiki_external_sync_provider.prepare_remote_inspection(db, [candidate])

    assert prepared.payload == ()
    assert prepared.immediate_states[14].error_code == (
        "external_connection_unavailable"
    )
    assert prepared.immediate_states[14].error_message == "Wiki 连接不可用"


@pytest.mark.asyncio
async def test_wiki_remote_inspection_skips_unsupported_connector(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inspect_pages = AsyncMock()
    connection = SimpleNamespace(
        display_name="Manual Wiki",
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=SimpleNamespace(
            supports_scheduled_sync=False,
            inspect_page_metadata_by_ids=inspect_pages,
        ),
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(id=7)
    candidate = SyncCandidate(15, 7, ExternalSyncLocator("wiki", "conn-manual", "5004"))

    prepared = wiki_external_sync_provider.prepare_remote_inspection(db, [candidate])
    states = await wiki_external_sync_provider.inspect_remote_states(prepared)

    assert prepared.payload == ()
    assert prepared.immediate_states == {}
    assert prepared.skipped_document_ids == frozenset({15})
    assert states == {}
    inspect_pages.assert_not_awaited()


@pytest.mark.asyncio
async def test_wiki_fetch_content_resolves_current_path_by_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    meta = SimpleNamespace(
        id="42",
        path="ops/renamed-runbook",
        title="Renamed Runbook",
        locale="zh",
        updated_at="2026-09-08T03:00:00Z",
    )
    page = SimpleNamespace(
        id="42",
        path=meta.path,
        title=meta.title,
        locale=meta.locale,
        updated_at=meta.updated_at,
        content="# Renamed",
    )
    connector = SimpleNamespace(get_page_by_id=AsyncMock(return_value=page))
    connection = SimpleNamespace(
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=connector,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )

    prepared = wiki_external_sync_provider.prepare_content_fetch(
        MagicMock(), SimpleNamespace(id=7), "v1:conn-primary:42"
    )
    content = await wiki_external_sync_provider.fetch_prepared_content(prepared)

    connector.get_page_by_id.assert_awaited_once_with(connection.config, "42")
    assert content.content == b"# Renamed"
    assert content.metadata["sync"]["path"] == "ops/renamed-runbook"


def test_wiki_remote_state_requires_updated_timestamp() -> None:
    state = wiki_external_sync_provider._state_from_page(
        "https://wiki.example.com",
        SimpleNamespace(
            path="ops/runbook",
            title="Runbook",
            locale="zh",
            updated_at="",
        ),
    )

    assert state.exists is True
    assert state.remote_version is None
    assert state.error_code == "external_version_unavailable"
