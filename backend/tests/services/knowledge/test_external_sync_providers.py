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
from app.services.wiki.connector import WikiApiError, WikiSiteConfig


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
        get_page=AsyncMock(
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

    resolved = await wiki_external_sync_provider.resolve_selections(
        MagicMock(), SimpleNamespace(id=7), "conn-primary", ["/ops/runbook/"]
    )

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
    }


@pytest.mark.asyncio
async def test_wiki_remote_inspection_batches_by_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = SimpleNamespace(
        list_pages=AsyncMock(
            return_value=(
                [
                    SimpleNamespace(
                        id="42",
                        path="ops/runbook",
                        title="Runbook v2",
                        locale="zh",
                        updated_at="2026-09-06T02:00:00Z",
                    )
                ],
                None,
            )
        ),
        get_page_metadata_by_id=AsyncMock(return_value=None),
    )
    connection = SimpleNamespace(
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
    ]

    states = await wiki_external_sync_provider.inspect_remote_states(db, candidates)

    connector.list_pages.assert_awaited_once()
    assert states[10].remote_version == "2026-09-06T02:00:00Z"
    assert states[10].metadata["path"] == "ops/runbook"
    assert states[11].exists is False
    assert states[11].error_code == "external_source_missing"


@pytest.mark.asyncio
async def test_wiki_remote_inspection_verifies_pages_outside_list_window(
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
        list_pages=AsyncMock(return_value=([], None)),
        get_page_metadata_by_id=AsyncMock(return_value=outside_window),
    )
    connection = SimpleNamespace(
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

    states = await wiki_external_sync_provider.inspect_remote_states(db, [candidate])

    connector.get_page_metadata_by_id.assert_awaited_once_with(
        connection.config, "5001"
    )
    assert states[12].exists is True
    assert states[12].remote_version == "2026-09-08T02:00:00Z"
    assert states[12].metadata["path"] == "ops/recent-runbook"


@pytest.mark.asyncio
async def test_wiki_remote_inspection_does_not_treat_lookup_error_as_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = SimpleNamespace(
        list_pages=AsyncMock(return_value=([], None)),
        get_page_metadata_by_id=AsyncMock(
            side_effect=WikiApiError("wiki_auth_failed", "bad key")
        ),
    )
    connection = SimpleNamespace(
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

    states = await wiki_external_sync_provider.inspect_remote_states(db, [candidate])

    assert states[13].exists is True
    assert states[13].error_code == "wiki_auth_failed"


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
    connector = SimpleNamespace(
        get_page_metadata_by_id=AsyncMock(return_value=meta),
        get_page=AsyncMock(return_value=page),
    )
    connection = SimpleNamespace(
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key="secret"),
        connector=connector,
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_sync_providers."
        "WikiConnectionService.get_user_wiki_connection",
        lambda *args, **kwargs: connection,
    )

    content = await wiki_external_sync_provider.fetch_content(
        MagicMock(), SimpleNamespace(id=7), "v1:conn-primary:42"
    )

    connector.get_page_metadata_by_id.assert_awaited_once_with(connection.config, "42")
    connector.get_page.assert_awaited_once_with(
        connection.config, "ops/renamed-runbook", "zh"
    )
    assert content.content == b"# Renamed"
    assert content.metadata["sync"]["path"] == "ops/renamed-runbook"
