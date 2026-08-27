# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ERP-backed department visibility filtering and whitelist API."""

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from wecode.service import dept_visibility
from wecode.service.dept_visibility import (
    FIELD_WHITELIST,
    HIDDEN_DEPARTMENT_CACHE_KEY,
    HIDDEN_DEPARTMENT_CACHE_TTL,
    REDIS_KEY,
    filter_hidden_for_user,
    write_field,
)
from wecode.service.erp_client import DepartmentInfo


class _FakeRedis:
    """Tiny in-memory replacement for the subset of redis-py we use."""

    def __init__(self):
        self.hash_store: dict[str, dict[str, str]] = {}
        self.value_store: dict[str, str] = {}
        self.expirations: dict[str, int | None] = {}

    def hget(self, key: str, field: str):
        return self.hash_store.get(key, {}).get(field)

    def hset(self, key: str, field: str, value: str) -> int:
        bucket = self.hash_store.setdefault(key, {})
        existed = field in bucket
        bucket[field] = value
        return 0 if existed else 1

    def get(self, key: str):
        return self.value_store.get(key)

    def set(self, key: str, value: str, ex: int | None = None):
        self.value_store[key] = value
        self.expirations[key] = ex
        return True


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


def _set_whitelist(fake_redis: _FakeRedis, users: list[str]) -> None:
    fake_redis.hset(REDIS_KEY, FIELD_WHITELIST, json.dumps(users))


def test_filter_hides_departments_returned_by_erp_t2(fake_redis: _FakeRedis):
    _set_whitelist(fake_redis, [])

    with patch.object(
        dept_visibility.erp_client,
        "search_hidden_department_ids",
        return_value={"1001", "1003"},
    ) as mock_search:
        result = filter_hidden_for_user("normaluser", _depts())

    assert [d.id for d in result] == ["1002"]
    mock_search.assert_called_once_with()
    assert json.loads(fake_redis.value_store[HIDDEN_DEPARTMENT_CACHE_KEY]) == [
        "1001",
        "1003",
    ]
    assert (
        fake_redis.expirations[HIDDEN_DEPARTMENT_CACHE_KEY]
        == HIDDEN_DEPARTMENT_CACHE_TTL
    )


def test_filter_uses_cached_t2_departments(fake_redis: _FakeRedis):
    _set_whitelist(fake_redis, [])
    fake_redis.set(HIDDEN_DEPARTMENT_CACHE_KEY, json.dumps(["1001"]))

    with patch.object(
        dept_visibility.erp_client,
        "search_hidden_department_ids",
    ) as mock_search:
        result = filter_hidden_for_user("normaluser", _depts())

    assert [d.id for d in result] == ["1002", "1003"]
    mock_search.assert_not_called()


def test_filter_does_not_query_erp_for_whitelisted_user(fake_redis: _FakeRedis):
    _set_whitelist(fake_redis, ["hr_admin"])

    with patch.object(
        dept_visibility.erp_client,
        "search_hidden_department_ids",
    ) as mock_search:
        result = filter_hidden_for_user("hr_admin", _depts())

    assert [d.id for d in result] == ["1001", "1002", "1003"]
    mock_search.assert_not_called()


def test_successful_empty_t2_result_is_cached(fake_redis: _FakeRedis):
    _set_whitelist(fake_redis, [])

    with patch.object(
        dept_visibility.erp_client,
        "search_hidden_department_ids",
        return_value=set(),
    ) as mock_search:
        assert len(filter_hidden_for_user("normaluser", _depts())) == 3
        assert len(filter_hidden_for_user("normaluser", _depts())) == 3

    mock_search.assert_called_once_with()
    assert json.loads(fake_redis.value_store[HIDDEN_DEPARTMENT_CACHE_KEY]) == []


def test_filter_fails_open_when_erp_query_fails(fake_redis: _FakeRedis):
    _set_whitelist(fake_redis, [])

    with patch.object(
        dept_visibility.erp_client,
        "search_hidden_department_ids",
        return_value=None,
    ):
        result = filter_hidden_for_user("normaluser", _depts())

    assert len(result) == 3
    assert HIDDEN_DEPARTMENT_CACHE_KEY not in fake_redis.value_store


def test_filter_fails_open_when_redis_unavailable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: None)

    result = filter_hidden_for_user("normaluser", _depts())

    assert len(result) == 3


def test_filter_normalizes_numeric_department_ids(fake_redis: _FakeRedis):
    _set_whitelist(fake_redis, [])
    fake_redis.set(HIDDEN_DEPARTMENT_CACHE_KEY, json.dumps(["001"]))
    departments = [
        DepartmentInfo(id="1", name="测试部"),
        DepartmentInfo(id="2", name="研发部"),
    ]

    result = filter_hidden_for_user("normaluser", departments)

    assert [d.id for d in result] == ["2"]


def test_write_field_only_allows_whitelist(fake_redis: _FakeRedis):
    stored = write_field(FIELD_WHITELIST, ["  zhangsan  ", "zhangsan", ""])

    assert stored == ["zhangsan"]
    assert json.loads(fake_redis.hget(REDIS_KEY, FIELD_WHITELIST)) == ["zhangsan"]

    with pytest.raises(ValueError):
        write_field("hidden_items", ["1001"])


@pytest.fixture
def admin_headers(test_admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_admin_token}"}


@pytest.fixture
def normal_headers(test_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_token}"}


@pytest.fixture
def http_fake_redis(monkeypatch: pytest.MonkeyPatch) -> _FakeRedis:
    fake = _FakeRedis()
    monkeypatch.setattr(dept_visibility, "get_redis_client", lambda: fake)
    return fake


def test_admin_get_returns_only_current_whitelist(
    test_client: TestClient,
    admin_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    _set_whitelist(http_fake_redis, ["zhangsan"])

    response = test_client.get(
        "/api/internal/admin/dept-visibility",
        headers=admin_headers,
    )

    assert response.status_code == 200
    assert response.json() == {"whitelist_users": ["zhangsan"]}


def test_admin_hidden_update_endpoint_is_removed(
    test_client: TestClient,
    admin_headers: dict[str, str],
):
    response = test_client.put(
        "/api/internal/admin/dept-visibility/hidden",
        headers=admin_headers,
        json={"items": ["1001"]},
    )

    assert response.status_code == 404


def test_admin_put_whitelist_replaces_list(
    test_client: TestClient,
    admin_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    response = test_client.put(
        "/api/internal/admin/dept-visibility/whitelist",
        headers=admin_headers,
        json={"user_names": ["zhangsan", "lisi"]},
    )

    assert response.status_code == 200
    assert response.json() == {"whitelist_users": ["zhangsan", "lisi"]}


def test_admin_endpoints_reject_non_admin(
    test_client: TestClient,
    normal_headers: dict[str, str],
    http_fake_redis: _FakeRedis,
):
    response = test_client.get(
        "/api/internal/admin/dept-visibility",
        headers=normal_headers,
    )

    assert response.status_code == 403
