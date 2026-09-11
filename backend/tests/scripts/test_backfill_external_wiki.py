# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.wiki.service import WikiConnectionService
from scripts.backfill_external_wiki import _fetcher_for


@pytest.mark.asyncio
async def test_backfill_resolves_the_document_named_connection(monkeypatch):
    connector = SimpleNamespace(get_page=AsyncMock(return_value="page"))
    connection = SimpleNamespace(config="config", connector=connector)
    resolve_connection = Mock(return_value=connection)
    monkeypatch.setattr(
        WikiConnectionService,
        "get_connection_by_user_id",
        resolve_connection,
    )
    document = SimpleNamespace(
        source_config={
            "wiki": {
                "bound_by_user_id": 7,
                "connection_id": "conn-team-docs",
                "path": "operations/handbook",
                "locale": "zh",
            }
        }
    )
    db = object()

    page = await _fetcher_for(db, {})(document)

    assert page == "page"
    resolve_connection.assert_called_once_with(
        db,
        7,
        connection_id="conn-team-docs",
    )
    connector.get_page.assert_called_once_with(
        "config",
        "operations/handbook",
        "zh",
    )
