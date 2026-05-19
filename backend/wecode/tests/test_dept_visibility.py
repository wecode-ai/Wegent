# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ERP department visibility filter and admin API."""

import json
from typing import Optional

import pytest
from fastapi.testclient import TestClient

from wecode.service import dept_visibility
from wecode.service.dept_visibility import (
    FIELD_HIDDEN,
    FIELD_WHITELIST,
    REDIS_KEY,
    VisibilityConfig,
    filter_hidden_for_user,
    write_field,
)
from wecode.service.erp_client import DepartmentInfo


class _FakeRedis:
    """Tiny in-memory replacement for the subset of redis-py we use."""

    def __init__(self):
        self.store: dict[str, dict[str, str]] = {}

    def hget(self, key: str, field: str):
        return self.store.get(key, {}).get(field)

    def hset(self, key: str, field: str, value: str) -> int:
        bucket = self.store.setdefault(key, {})
        existed = field in bucket
        bucket[field] = value
        return 0 if existed else 1


@pytest.fixture
def fake_redis(monkeypatch: pytest.MonkeyPatch) -> _FakeRedis:
    fake = _FakeRedis()
    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: fake)
    return fake


def _depts() -> list[DepartmentInfo]:
    return [
        DepartmentInfo(id="1001", name="高级研究院", label="高级研究院"),
        DepartmentInfo(id="1002", name="技术中心", label="技术中心"),
        DepartmentInfo(id="1003", name="战略委员会", label="战略委员会"),
    ]


def test_filter_hides_by_id_for_normal_user(fake_redis: _FakeRedis):
    fake_redis.hset(REDIS_KEY, FIELD_HIDDEN, json.dumps(["1001"]))

    result = filter_hidden_for_user("normaluser", _depts())

    assert [d.id for d in result] == ["1002", "1003"]


def test_filter_hides_by_name_for_normal_user(fake_redis: _FakeRedis):
    fake_redis.hset(REDIS_KEY, FIELD_HIDDEN, json.dumps(["战略委员会"]))

    result = filter_hidden_for_user("normaluser", _depts())

    assert [d.id for d in result] == ["1001", "1002"]


def test_filter_passthrough_for_whitelisted_user(fake_redis: _FakeRedis):
    fake_redis.hset(REDIS_KEY, FIELD_HIDDEN, json.dumps(["1001", "战略委员会"]))
    fake_redis.hset(REDIS_KEY, FIELD_WHITELIST, json.dumps(["hr_admin"]))

    result = filter_hidden_for_user("hr_admin", _depts())

    assert [d.id for d in result] == ["1001", "1002", "1003"]


def test_filter_passthrough_when_hidden_list_empty(fake_redis: _FakeRedis):
    result = filter_hidden_for_user("normaluser", _depts())

    assert [d.id for d in result] == ["1001", "1002", "1003"]


def test_filter_hides_by_id_with_leading_zeros(fake_redis: _FakeRedis):
    """Hidden list '001' should match dept.id '001' after normalization."""
    fake_redis.hset(REDIS_KEY, FIELD_HIDDEN, json.dumps(["001"]))

    depts = [
        DepartmentInfo(id="001", name="测试部", label="测试部"),
        DepartmentInfo(id="002", name="研发部", label="研发部"),
    ]

    result = filter_hidden_for_user("normaluser", depts)

    assert [d.id for d in result] == ["002"]


def test_filter_fail_open_when_redis_unavailable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: None)

    result = filter_hidden_for_user("normaluser", _depts())

    assert len(result) == 3


def test_filter_fail_open_when_redis_raises(monkeypatch: pytest.MonkeyPatch):
    class _Boom:
        def hget(self, *args, **kwargs):
            raise RuntimeError("redis exploded")

    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: _Boom())

    result = filter_hidden_for_user("normaluser", _depts())

    assert len(result) == 3


def test_write_field_normalizes_strips_dedupes(fake_redis: _FakeRedis):
    stored = write_field(FIELD_HIDDEN, ["  1001  ", "1001", "", None, "高级研究院"])

    assert stored == ["1001", "高级研究院"]
    raw = fake_redis.hget(REDIS_KEY, FIELD_HIDDEN)
    assert json.loads(raw) == ["1001", "高级研究院"]


def test_write_field_rejects_unknown_field(fake_redis: _FakeRedis):
    with pytest.raises(ValueError):
        write_field("not_a_real_field", ["x"])


def test_write_field_raises_when_redis_unavailable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: None)

    with pytest.raises(RuntimeError):
        write_field(FIELD_HIDDEN, ["1001"])


# ---------- Admin API HTTP tests ----------


@pytest.fixture
def admin_headers(test_admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_admin_token}"}


@pytest.fixture
def normal_headers(test_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_token}"}


@pytest.fixture
def http_fake_redis(monkeypatch: pytest.MonkeyPatch) -> _FakeRedis:
    """Patch the redis client wherever dept_visibility looks it up."""
    fake = _FakeRedis()
    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: fake)
    return fake


def test_admin_get_returns_current_config(
    test_client: TestClient,
    admin_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    http_fake_redis.hset(REDIS_KEY, FIELD_HIDDEN, json.dumps(["1001"]))
    http_fake_redis.hset(REDIS_KEY, FIELD_WHITELIST, json.dumps(["zhangsan"]))

    r = test_client.get("/api/internal/admin/dept-visibility", headers=admin_headers)

    assert r.status_code == 200
    body = r.json()
    assert body["hidden_items"] == ["1001"]
    assert body["whitelist_users"] == ["zhangsan"]


def test_admin_put_hidden_replaces_list(
    test_client: TestClient,
    admin_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    r = test_client.put(
        "/api/internal/admin/dept-visibility/hidden",
        headers=admin_headers,
        json={"items": ["1001", "  战略委员会  ", "1001"]},
    )

    assert r.status_code == 200
    assert r.json() == {"hidden_items": ["1001", "战略委员会"]}
    raw = http_fake_redis.hget(REDIS_KEY, FIELD_HIDDEN)
    assert json.loads(raw) == ["1001", "战略委员会"]


def test_admin_put_whitelist_replaces_list(
    test_client: TestClient,
    admin_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    r = test_client.put(
        "/api/internal/admin/dept-visibility/whitelist",
        headers=admin_headers,
        json={"user_names": ["zhangsan", "lisi"]},
    )

    assert r.status_code == 200
    assert r.json() == {"whitelist_users": ["zhangsan", "lisi"]}


def test_admin_endpoints_reject_non_admin(
    test_client: TestClient,
    normal_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    r_get = test_client.get(
        "/api/internal/admin/dept-visibility", headers=normal_headers
    )
    r_put = test_client.put(
        "/api/internal/admin/dept-visibility/hidden",
        headers=normal_headers,
        json={"items": ["1001"]},
    )

    assert r_get.status_code == 403
    assert r_put.status_code == 403
