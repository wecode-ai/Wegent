# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.endpoints.external_wiki import (
    create_kb_binding,
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


def test_binding_accepts_long_gitlab_repository_path() -> None:
    path = f"{'nested/' * 100}guide.md"

    request = WikiBindingCreateRequest(
        page_ids=[path],
        connection_id="conn-primary",
    )

    assert request.page_ids == [path]


@pytest.mark.asyncio
async def test_disabled_scheduled_sync_does_not_block_manual_binding(
    monkeypatch,
) -> None:
    db = MagicMock()
    user = _user()
    resolved_documents = [SimpleNamespace(resource_id="42")]
    provider = SimpleNamespace(
        resolve_selections=AsyncMock(return_value=resolved_documents)
    )
    import_documents = MagicMock(
        return_value=SimpleNamespace(
            created=[],
            updated=[],
            processing=[],
            duplicates=[],
        )
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.settings.EXTERNAL_DOC_SYNC_ENABLED",
        False,
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki._load_kb",
        MagicMock(return_value=SimpleNamespace(id=11)),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki._require_kb_edit",
        MagicMock(),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.get_external_sync_provider",
        MagicMock(return_value=provider),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.external_document_import_service.import_resolved_documents",
        import_documents,
    )

    result = await create_kb_binding(
        knowledge_base_id=11,
        body=WikiBindingCreateRequest(
            page_ids=["42"],
            connection_id="conn-primary",
        ),
        db=db,
        current_user=user,
    )

    assert result.created_count == 0
    assert result.updated_count == 0
    assert result.processing_count == 0
    provider.resolve_selections.assert_awaited_once_with(
        db,
        user,
        "conn-primary",
        ["42"],
        project_path=None,
        branch=None,
    )
    import_documents.assert_called_once_with(
        db=db,
        user=user,
        knowledge_base_id=11,
        provider_id="wiki",
        resolved_documents=resolved_documents,
        folder_id=0,
    )


@pytest.mark.asyncio
async def test_unsaved_connection_values_can_be_tested_without_connection_id(
    monkeypatch,
):
    connector = SimpleNamespace(
        connector_type="wikijs",
        test_connection=AsyncMock(
            return_value=WikiConnectionTest(ok=True, message="连接成功", version="2.5")
        ),
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
async def test_disabled_stored_connection_can_be_tested_without_resending_api_key(
    monkeypatch,
):
    connector = SimpleNamespace(
        connector_type="wikijs",
        test_connection=AsyncMock(
            return_value=WikiConnectionTest(ok=True, message="连接成功", version="2.5")
        ),
    )
    stored = SimpleNamespace(
        connection_id="conn-primary",
        owner_user_id=7,
        display_name="Primary",
        adapter_type="wikijs",
        enabled=False,
        config={
            "site_url": "https://wiki.example.com",
            "default_locale": "zh",
        },
        credentials={"api_key": "stored-key"},
        revision=3,
    )
    get_owned = MagicMock(return_value=stored)
    monkeypatch.setattr(
        "app.services.wiki.service.external_source_connection_service.get_owned",
        get_owned,
    )
    monkeypatch.setattr(
        "app.services.wiki.service.register_builtin_connectors",
        lambda: None,
    )
    monkeypatch.setattr(
        "app.services.wiki.service.WIKI_CONNECTORS",
        SimpleNamespace(get=lambda connector_type: connector),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.WIKI_CONNECTORS",
        SimpleNamespace(get=lambda connector_type: connector),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.validate_wiki_site_url",
        lambda site_url: site_url,
    )
    db = MagicMock()

    result = await run_wiki_connection_test(
        WikiConnectionTestRequest(connection_id="conn-primary"),
        db=db,
        current_user=_user(),
    )

    assert result == WikiConnectionTestResponse(
        ok=True, message="连接成功", version="2.5"
    )
    get_owned.assert_called_once_with(
        db,
        owner_user_id=7,
        provider_id="wiki",
        connection_id="conn-primary",
    )
    connector.test_connection.assert_awaited_once()


@pytest.mark.asyncio
async def test_stored_api_key_is_not_reused_for_a_different_target(monkeypatch):
    connector = SimpleNamespace(
        connector_type="gitlab_repo",
        test_connection=AsyncMock(),
    )
    stored = SimpleNamespace(
        connection_id="conn-primary",
        owner_user_id=7,
        display_name="Primary",
        adapter_type="gitlab_repo",
        enabled=True,
        config={"site_url": "https://gitlab.internal"},
        credentials={"api_key": "stored-key"},
        revision=3,
    )
    monkeypatch.setattr(
        "app.services.wiki.service.external_source_connection_service.get_owned",
        MagicMock(return_value=stored),
    )
    monkeypatch.setattr(
        "app.services.wiki.service.register_builtin_connectors",
        lambda: None,
    )
    monkeypatch.setattr(
        "app.services.wiki.service.WIKI_CONNECTORS",
        SimpleNamespace(get=lambda connector_type: connector),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.WIKI_CONNECTORS",
        SimpleNamespace(get=lambda connector_type: connector),
    )
    monkeypatch.setattr(
        "app.api.endpoints.external_wiki.validate_wiki_site_url",
        lambda site_url: site_url.rstrip("/"),
    )

    result = await run_wiki_connection_test(
        WikiConnectionTestRequest(
            connection_id="conn-primary",
            site_url="https://attacker.example",
        ),
        db=MagicMock(),
        current_user=_user(),
    )

    assert result.ok is False
    assert "重新输入 API Key" in result.message
    connector.test_connection.assert_not_awaited()


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


@pytest.mark.asyncio
async def test_unreferenced_connection_target_change_requires_a_new_api_key(
    monkeypatch,
):
    stored = SimpleNamespace(
        adapter_type="gitlab_repo",
        config={"site_url": "https://gitlab.internal"},
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
                connector_type="gitlab_repo",
                site_url="https://other.example.com",
                enabled=True,
            ),
            db=_Session(),
            current_user=_user(),
        )

    assert exc_info.value.status_code == 400
    assert "重新输入 API Key" in exc_info.value.detail
