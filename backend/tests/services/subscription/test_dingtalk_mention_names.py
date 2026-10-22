from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.services.subscription import notification_dispatcher


@pytest.mark.asyncio
async def test_resolve_dingtalk_mention_user_ids_appends_display_names(monkeypatch):
    async def fake_lookup(_db, user_id):
        return {"41068": "陈波", "220750": "李四"}.get(user_id, "")

    monkeypatch.setattr(
        notification_dispatcher, "_lookup_dingtalk_mention_name", fake_lookup
    )
    notification_dispatcher._DINGTALK_MENTION_NAME_CACHE.clear()

    resolved = await notification_dispatcher._resolve_dingtalk_mention_user_ids(
        None, ["41068", "220750", "999", "41068:旧名称"]
    )

    assert resolved == ["41068:陈波", "220750:李四", "999", "41068:陈波"]


@pytest.mark.asyncio
async def test_lookup_dingtalk_mention_name_queries_user_info(monkeypatch):
    class FakeQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return SimpleNamespace(email="chenbo@example.com")

    class FakeDB:
        def query(self, _model):
            return FakeQuery()

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return [{"NAME": "陈波"}]

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(
        notification_dispatcher.httpx,
        "AsyncClient",
        lambda **_kwargs: FakeClient(),
    )
    monkeypatch.setattr(
        settings, "DINGTALK_USER_INFO_URL", "http://example.test/user-info"
    )

    name = await notification_dispatcher._lookup_dingtalk_mention_name(
        FakeDB(), "41068"
    )

    assert name == "陈波"
