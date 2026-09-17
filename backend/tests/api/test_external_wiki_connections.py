# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.endpoints.external_wiki import (
    delete_wiki_connection,
)
from app.api.endpoints.external_wiki import (
    test_named_wiki_connection as run_named_wiki_connection_test,
)
from app.api.endpoints.external_wiki import (
    test_wiki_connection as run_wiki_connection_test,
)
from app.api.endpoints.external_wiki import (
    update_named_wiki_connection,
)
from app.models.knowledge import KnowledgeDocument
from app.schemas.external_wiki import (
    WikiBindingCreateRequest,
    WikiConnectionTestRequest,
    WikiConnectionTestResponse,
    WikiNamedConnectionUpdateRequest,
)
from app.services.wiki.connector import WikiConnectionTest


class _DocumentQuery:
    def __init__(self, values):
        self.values = values

    def filter(self, *criteria):
        return self

    def all(self):
        return self.values


class _Session:
    def __init__(self, documents=(), knowledge_bases=()):
        self.documents = list(documents)
        self.knowledge_bases = list(knowledge_bases)

    def query(self, model):
        values = self.documents if model is KnowledgeDocument else self.knowledge_bases
        return _DocumentQuery(values)


def _user():
    return SimpleNamespace(id=7, user_name="alice")


def _references():
    documents = [
        SimpleNamespace(
            kind_id=11,
            source_type="external",
            external_provider="wiki",
            external_resource_id="v1:conn-primary:101",
        ),
        SimpleNamespace(
            kind_id=11,
            source_type="external",
            external_provider="wiki",
            external_resource_id="v1:conn-primary:102",
        ),
        SimpleNamespace(
            kind_id=12,
            source_type="external",
            external_provider="wiki",
            external_resource_id="v1:conn-primary:103",
        ),
    ]
    knowledge_bases = [
        SimpleNamespace(
            id=11, name="operations", json={"spec": {"name": "运维知识库"}}
        ),
        SimpleNamespace(id=12, name="product", json={"spec": {"name": "产品知识库"}}),
    ]
    return documents, knowledge_bases


def test_binding_requires_connection_id() -> None:
    with pytest.raises(ValidationError):
        WikiBindingCreateRequest(page_ids=["42"])


def test_binding_rejects_whitespace_only_page_id() -> None:
    with pytest.raises(ValidationError):
        WikiBindingCreateRequest(page_ids=[" \t"], connection_id="conn-primary")


def test_binding_normalizes_page_ids() -> None:
    request = WikiBindingCreateRequest(
        page_ids=[" 42 ", "\tpage-id\n"],
        connection_id="conn-primary",
    )

    assert request.page_ids == ["42", "page-id"]


@pytest.mark.asyncio
async def test_unsaved_connection_values_can_be_tested_without_connection_id(
    monkeypatch,
):
    connector = SimpleNamespace(
        test_connection=AsyncMock(
            return_value=WikiConnectionTest(ok=True, message="连接成功", version="2.5")
        )
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.WIKI_CONNECTORS",
        SimpleNamespace(get=lambda connector_type: connector),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.validate_wiki_site_url",
        lambda site_url: site_url,
    )
    body = WikiConnectionTestRequest(
        connector_type="wikijs",
        site_url="https://wiki.example.com",
        api_key="secret",
    )
    db = MagicMock()

    result = await run_wiki_connection_test(body, db=db, current_user=_user())

    assert result == WikiConnectionTestResponse(
        ok=True, message="连接成功", version="2.5"
    )
    db.commit.assert_called_once_with()
    connector.test_connection.assert_awaited_once()


@pytest.mark.asyncio
async def test_named_connection_can_be_tested_with_empty_request_body(monkeypatch):
    test_connection = AsyncMock(
        return_value=WikiConnectionTestResponse(ok=True, message="连接成功")
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.test_wiki_connection", test_connection
    )
    db = MagicMock()

    result = await run_named_wiki_connection_test(
        "conn-primary", body=None, db=db, current_user=_user()
    )

    assert result.ok is True
    request = test_connection.await_args.args[0]
    assert request.connection_id == "conn-primary"


@pytest.mark.asyncio
async def test_delete_connection_is_blocked_by_synchronized_wiki_reference():
    documents, knowledge_bases = _references()

    with (
        patch(
            "app.api.endpoints.external_wiki.external_source_connection_service.get_owned",
            return_value=SimpleNamespace(),
        ),
        pytest.raises(HTTPException) as exc_info,
    ):
        await delete_wiki_connection(
            "conn-primary",
            db=_Session(documents, knowledge_bases),
            current_user=_user(),
        )

    assert exc_info.value.status_code == 409
    assert "运维知识库（2 篇文档）" in exc_info.value.detail
    assert "产品知识库（1 篇文档）" in exc_info.value.detail


@pytest.mark.asyncio
async def test_delete_named_connection_when_unreferenced(monkeypatch):
    disable = MagicMock(return_value=True)
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.external_source_connection_service.disable_owned",
        disable,
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.external_source_connection_service.get_owned",
        lambda *args, **kwargs: SimpleNamespace(),
    )

    await delete_wiki_connection("conn-primary", db=_Session(), current_user=_user())

    disable.assert_called_once()


@pytest.mark.asyncio
async def test_referenced_connection_target_is_immutable(monkeypatch):
    documents, knowledge_bases = _references()
    stored = SimpleNamespace(
        adapter_type="wikijs",
        config={"site_url": "https://wiki.example.com"},
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.validate_wiki_site_url",
        lambda url: url.rstrip("/"),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.external_source_connection_service.get_owned",
        lambda *args, **kwargs: stored,
    )

    with pytest.raises(HTTPException) as exc_info:
        await update_named_wiki_connection(
            "conn-primary",
            WikiNamedConnectionUpdateRequest(
                display_name="Primary",
                connector_type="wikijs",
                site_url="https://other.example.com",
                enabled=True,
            ),
            db=_Session(documents, knowledge_bases),
            current_user=_user(),
        )

    assert exc_info.value.status_code == 409
    assert "运维知识库（2 篇文档）" in exc_info.value.detail
