# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.endpoints.external_wiki import delete_wiki_connection
from app.models.knowledge import KnowledgeDocument
from app.services.wiki.service import LEGACY_WIKI_CONNECTION_ID, WikiConnectionService


class _DocumentQuery:
    def __init__(self, documents):
        self.documents = documents

    def filter(self, *criteria):
        return self

    def all(self):
        return self.documents


class _DeleteSession:
    def __init__(self, documents=(), knowledge_bases=()):
        self.documents = list(documents)
        self.knowledge_bases = list(knowledge_bases)
        self.added = []
        self.committed = False

    def query(self, model):
        values = self.documents if model is KnowledgeDocument else self.knowledge_bases
        return _DocumentQuery(values)

    def add(self, value):
        self.added.append(value)

    def commit(self):
        self.committed = True


def _legacy_user():
    user = SimpleNamespace(id=7, user_name="alice", preferences=None)
    user.preferences = WikiConnectionService.save_connection(
        user,
        connector_type="wikijs",
        site_url="https://wiki.example.com",
        api_key="secret",
        default_locale="zh",
        enabled=True,
    )
    return user


@pytest.mark.asyncio
async def test_delete_connection_is_blocked_by_live_wiki_reference():
    documents = [
        SimpleNamespace(
            kind_id=11,
            name="Operations handbook",
            source_type="external_wiki",
            source_config={"wiki": {"path": "docs/handbook"}},
        ),
        SimpleNamespace(
            kind_id=11,
            name="Operations runbook",
            source_type="external_wiki",
            source_config={"wiki": {"path": "docs/runbook"}},
        ),
        SimpleNamespace(
            kind_id=12,
            name="Product handbook",
            source_type="external_wiki",
            source_config={"wiki": {"path": "product/handbook"}},
        ),
    ]
    knowledge_bases = [
        SimpleNamespace(
            id=11,
            kind="KnowledgeBase",
            name="kb-7-personal-operations",
            json={"spec": {"name": "运维知识库"}},
        ),
        SimpleNamespace(
            id=12,
            kind="KnowledgeBase",
            name="kb-7-personal-product",
            json={"spec": {"name": "产品知识库"}},
        ),
    ]
    db = _DeleteSession(documents, knowledge_bases)

    with pytest.raises(HTTPException) as exc_info:
        await delete_wiki_connection(
            LEGACY_WIKI_CONNECTION_ID,
            db=db,
            current_user=_legacy_user(),
        )

    assert exc_info.value.status_code == 409
    assert "运维知识库（2 篇文档）" in exc_info.value.detail
    assert "产品知识库（1 篇文档）" in exc_info.value.detail
    assert "Operations handbook" not in exc_info.value.detail
    assert not db.committed


@pytest.mark.asyncio
async def test_delete_legacy_connection_clears_preferences_when_unreferenced():
    user = _legacy_user()
    db = _DeleteSession()

    await delete_wiki_connection(
        LEGACY_WIKI_CONNECTION_ID,
        db=db,
        current_user=user,
    )

    assert WikiConnectionService.describe(user)["site_url"] == ""
    assert db.added == [user]
    assert db.committed
