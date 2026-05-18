# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

from wecode.service.erp_entity_resolver import ErpEntityResolver


class _MemRedis:
    """Minimal in-memory replacement for the redis client used by the resolver."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def get(self, key: str):
        return self.store.get(key)

    def set(self, key: str, value, ex: int | None = None) -> None:
        self.store[key] = value


@pytest.fixture
def resolver_no_redis():
    """Resolver with the redis lookup forced to return None (cache disabled)."""
    with patch(
        "wecode.service.erp_entity_resolver.get_redis_client", return_value=None
    ):
        yield ErpEntityResolver()


@pytest.fixture
def resolver_with_mem_redis():
    """Resolver backed by an in-memory redis stand-in."""
    fake = _MemRedis()
    with patch(
        "wecode.service.erp_entity_resolver.get_redis_client", return_value=fake
    ):
        yield ErpEntityResolver()


class TestErpEntityResolver:
    def test_mask_ssn_short(self):
        resolver = ErpEntityResolver()
        assert resolver._mask_ssn("1234") == "****"
        assert resolver._mask_ssn("12") == "****"
        assert resolver._mask_ssn("") == "****"

    def test_mask_ssn_normal(self):
        resolver = ErpEntityResolver()
        assert resolver._mask_ssn("12345678") == "12****78"

    def test_cache_miss_calls_api_and_returns_result(self, resolver_no_redis):
        with patch(
            "wecode.service.erp_entity_resolver.erp_client.batch_check_membership"
        ) as mock_check:
            mock_check.return_value = {"d1": True, "d2": False}

            result = resolver_no_redis._get_membership_with_cache(
                1, "ssn", ["d1", "d2"]
            )

            assert result == {"d1": True, "d2": False}
            mock_check.assert_called_once_with("ssn", ["d1", "d2"])

    def test_cache_partial_hit_only_queries_missing_and_drops_stale(
        self, resolver_with_mem_redis
    ):
        """Partial-hit path: previously-cached d1 is reused; only d2 is queried.

        The cache is rebuilt scoped to the current request so old entries
        not in the current dept_ids do not survive indefinitely via
        repeated TTL refreshes.
        """
        with patch(
            "wecode.service.erp_entity_resolver.erp_client.batch_check_membership"
        ) as mock_check:
            # Seed the cache with a previous request that included d1 and d_old
            mock_check.return_value = {"d1": True, "d_old": True}
            resolver_with_mem_redis._get_membership_with_cache(
                1, "ssn", ["d1", "d_old"]
            )
            mock_check.assert_called_with("ssn", ["d1", "d_old"])

            # Now ask for d1 (cached) + d2 (missing). Only d2 should be queried.
            mock_check.reset_mock()
            mock_check.return_value = {"d2": False}
            result = resolver_with_mem_redis._get_membership_with_cache(
                1, "ssn", ["d1", "d2"]
            )

            assert result == {"d1": True, "d2": False}
            mock_check.assert_called_once_with("ssn", ["d2"])

            # The rebuilt cache must NOT retain the stale d_old entry.
            cached = resolver_with_mem_redis._cache_get("erp:membership:1:ssn")
            assert cached == {"d1": True, "d2": False}
            assert "d_old" not in cached

    def test_resolve_matched_departments_wrong_entity_type(self):
        resolver = ErpEntityResolver()
        db = MagicMock()
        result = resolver._resolve_matched_departments(db, 1, "org_team", ["d1"])
        assert result == []

    def test_resolve_matched_departments_empty_list(self):
        resolver = ErpEntityResolver()
        db = MagicMock()
        result = resolver._resolve_matched_departments(db, 1, "org_department", [])
        assert result == []

    def test_match_entity_bindings_no_ssn(self):
        resolver = ErpEntityResolver()
        db = MagicMock()
        with patch.object(resolver, "_get_user_ssn", return_value=None):
            result = resolver.match_entity_bindings(db, 1, "org_department", ["d1"])
            assert result == []

    def test_match_entity_bindings_filters_to_member_depts(self, resolver_no_redis):
        db = MagicMock()
        with (
            patch.object(resolver_no_redis, "_get_user_ssn", return_value="12345678"),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.batch_check_membership"
            ) as mock_check,
        ):
            mock_check.return_value = {"d1": True, "d2": False, "d3": True}
            result = resolver_no_redis.match_entity_bindings(
                db, 1, "org_department", ["d1", "d2", "d3"]
            )
            assert sorted(result) == ["d1", "d3"]

    def test_redis_lazy_load(self):
        """Constructor must not eagerly call get_redis_client.

        Lazy initialization lets the resolver recover automatically once
        Redis becomes available, instead of being permanently disabled
        because Redis was unavailable at app startup.
        """
        with patch("wecode.service.erp_entity_resolver.get_redis_client") as mock_get:
            mock_get.return_value = MagicMock()
            resolver = ErpEntityResolver()
            assert mock_get.call_count == 0  # not called in __init__

            _ = resolver._redis_client  # accessing the property triggers it
            assert mock_get.call_count == 1

            _ = resolver._redis_client  # cached: no re-fetch
            assert mock_get.call_count == 1
