from types import SimpleNamespace

import pytest

from app.core.cache import cache_manager
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
async def test_resolve_dingtalk_mention_user_ids_skips_non_numeric_ids(monkeypatch):
    calls = []

    async def fake_lookup(_db, user_id):
        calls.append(user_id)
        return ""

    monkeypatch.setattr(
        notification_dispatcher, "_lookup_dingtalk_mention_name", fake_lookup
    )
    notification_dispatcher._DINGTALK_MENTION_NAME_CACHE.clear()

    resolved = await notification_dispatcher._resolve_dingtalk_mention_user_ids(
        None, ["user-1", "999", "999"]
    )

    assert resolved == ["user-1", "999", "999"]
    assert calls == ["999", "999"]


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

    async def no_cached_name(_key):
        return None

    async def ignore_cache_set(*_args, **_kwargs):
        return True

    monkeypatch.setattr(cache_manager, "get", no_cached_name)
    monkeypatch.setattr(cache_manager, "set", ignore_cache_set)
    monkeypatch.setattr(
        notification_dispatcher,
        "_get_dingtalk_user_info_url",
        lambda: "http://example.test/user-info",
    )

    name = await notification_dispatcher._lookup_dingtalk_mention_name(
        FakeDB(), "41068"
    )

    assert name == "陈波"


@pytest.mark.asyncio
async def test_lookup_dingtalk_mention_name_falls_back_to_erp(monkeypatch):
    class FakeQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return None

    class FakeDB:
        def query(self, _model):
            return FakeQuery()

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return [{"NAME": "刘彦生"}]

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    async def no_cached_name(_key):
        return None

    async def ignore_cache_set(*_args, **_kwargs):
        return True

    async def erp_email(_staff_id):
        return "yansheng3@example.com"

    monkeypatch.setattr(cache_manager, "get", no_cached_name)
    monkeypatch.setattr(cache_manager, "set", ignore_cache_set)
    monkeypatch.setattr(notification_dispatcher, "_lookup_employee_email", erp_email)
    monkeypatch.setattr(
        notification_dispatcher.httpx,
        "AsyncClient",
        lambda **_kwargs: FakeClient(),
    )
    monkeypatch.setattr(
        notification_dispatcher,
        "_get_dingtalk_user_info_url",
        lambda: "http://example.test/user-info",
    )

    name = await notification_dispatcher._lookup_dingtalk_mention_name(
        FakeDB(), "220750"
    )

    assert name == "刘彦生"


def _stub_directory_lookup(monkeypatch, response_payload, erp_email=""):
    class FakeQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return None

    class FakeDB:
        def query(self, _model):
            return FakeQuery()

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return response_payload

    captured = {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **kwargs):
            captured["payload"] = kwargs.get("json")
            return FakeResponse()

    async def no_cached_name(_key):
        return None

    async def ignore_cache_set(*_args, **_kwargs):
        return True

    async def _resolved(_staff_id, value=erp_email):
        return value

    monkeypatch.setattr(cache_manager, "get", no_cached_name)
    monkeypatch.setattr(cache_manager, "set", ignore_cache_set)
    monkeypatch.setattr(
        notification_dispatcher,
        "_lookup_employee_email",
        _resolved,
    )
    monkeypatch.setattr(
        notification_dispatcher.httpx,
        "AsyncClient",
        lambda **_kwargs: FakeClient(),
    )
    monkeypatch.setattr(
        notification_dispatcher,
        "_get_dingtalk_user_info_url",
        lambda: "http://example.test/user-info",
    )
    return FakeDB(), captured


@pytest.mark.asyncio
async def test_lookup_dingtalk_mention_name_requires_erp_email(monkeypatch):
    """Without an ERP email the directory is never queried."""
    db, captured = _stub_directory_lookup(monkeypatch, [{"NAME": "李四"}])

    name = await notification_dispatcher._lookup_dingtalk_mention_name(db, "220750")

    assert name == ""
    assert captured == {}


@pytest.mark.asyncio
async def test_lookup_dingtalk_mention_name_ignores_unknown_staff_id(monkeypatch):
    db, _captured = _stub_directory_lookup(
        monkeypatch,
        [{"EMAIL": "220750", "notExist": True}],
        erp_email="yansheng3@staff.weibo.com",
    )

    name = await notification_dispatcher._lookup_dingtalk_mention_name(db, "220750")

    assert name == ""
