# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import orjson
import pytest

from wecode.cache.base import NULL_MARKER
from wecode.service.erp_entity_resolver import ErpEntityResolver


class _MemRedis:
    """Minimal in-memory replacement for the redis client used by the resolver."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def get(self, key: str):
        return self.store.get(key)

    def set(self, key: str, value, ex: int | None = None) -> bool:
        self.store[key] = value
        return True


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

    def test_resolve_employee_id_uses_existing_profile_before_erp(self):
        resolver = ErpEntityResolver()
        db = MagicMock()
        profile = SimpleNamespace(employee_id="230473")
        db.query.return_value.filter.return_value.first.return_value = profile

        with patch(
            "wecode.service.erp_entity_resolver.erp_client.search_employee"
        ) as mock_search:
            result = resolver.resolve_employee_id(db, 1)

        assert result == "230473"
        mock_search.assert_not_called()

    def test_resolve_employee_id_lazy_syncs_by_email_when_profile_missing(self):
        resolver = ErpEntityResolver()
        db = MagicMock()
        profile_query = MagicMock()
        user_query = MagicMock()
        user = SimpleNamespace(email="user@example.com")
        erp_employee = SimpleNamespace(
            ssn="230473",
            department="Engineering",
            name="Test User",
            email="user@example.com",
        )
        independent_db = MagicMock()
        lock = MagicMock()
        lock.__enter__.return_value = True
        lock.__exit__.return_value = None

        profile_query.filter.return_value.first.side_effect = [None, None]
        user_query.filter.return_value.first.return_value = user
        db.query.side_effect = [profile_query, user_query, profile_query]

        with (
            patch(
                "wecode.service.erp_entity_resolver.distributed_lock.acquire_context",
                return_value=lock,
            ),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.search_employee",
                return_value=erp_employee,
            ) as mock_search,
            patch("app.db.session.SessionLocal", return_value=independent_db),
            patch(
                "wecode.service.erp_entity_resolver.ErpUserService.upsert_profile"
            ) as mock_upsert,
        ):
            result = resolver.resolve_employee_id(db, 1)

        assert result == "230473"
        mock_search.assert_called_once_with("user@example.com")
        mock_upsert.assert_called_once_with(
            db=independent_db,
            user_id=1,
            employee_id="230473",
            department_name="Engineering",
            erp_name="Test User",
            email="user@example.com",
        )
        independent_db.close.assert_called_once()

    def test_resolve_employee_id_for_user_manages_session(self):
        resolver = ErpEntityResolver()
        db = MagicMock()

        with (
            patch("app.db.session.SessionLocal", return_value=db),
            patch.object(
                resolver,
                "resolve_employee_id",
                return_value="230473",
            ) as mock_resolve,
        ):
            result = resolver.resolve_employee_id_for_user(1)

        assert result == "230473"
        mock_resolve.assert_called_once_with(db, 1, None)
        db.close.assert_called_once()

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


def _lazy_sync_db(user_email: str = "ghost@example.com"):
    """Build a session mock that returns no profile and one user row."""
    profile_query = MagicMock()
    user_query = MagicMock()
    profile_query.filter.return_value.first.return_value = None
    user_query.filter.return_value.first.return_value = SimpleNamespace(
        email=user_email
    )

    db = MagicMock()
    # profile read, user read, profile re-read under the lock
    db.query.side_effect = [profile_query, user_query, profile_query, profile_query]
    return db


def _acquired_lock() -> MagicMock:
    lock = MagicMock()
    lock.__enter__.return_value = True
    lock.__exit__.return_value = None
    return lock


class TestNoProfileNegativeCache:
    """A user the directory does not know must not be re-queried every request."""

    def test_miss_is_cached_with_long_ttl(self):
        client = MagicMock()
        db = _lazy_sync_db()

        with (
            patch(
                "wecode.service.erp_entity_resolver.get_redis_client",
                return_value=client,
            ),
            patch(
                "wecode.service.erp_entity_resolver.distributed_lock.acquire_context",
                return_value=_acquired_lock(),
            ),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.search_employee",
                return_value=None,
            ) as mock_search,
        ):
            resolver = ErpEntityResolver()
            result = resolver.resolve_employee_id(db, 1)

        assert result is None
        mock_search.assert_called_once_with("ghost@example.com")
        client.set.assert_called_once_with(
            "erp:no_profile:1",
            orjson.dumps(NULL_MARKER),
            ex=ErpEntityResolver._NO_PROFILE_CACHE_TTL,
        )
        assert ErpEntityResolver._NO_PROFILE_CACHE_TTL > ErpEntityResolver._CACHE_TTL

    def test_cached_miss_skips_upstream_search(self, resolver_with_mem_redis):
        resolver = resolver_with_mem_redis
        resolver._cache_set(
            resolver._no_profile_cache_key(1),
            NULL_MARKER,
            ttl=resolver._NO_PROFILE_CACHE_TTL,
        )
        db = MagicMock()
        profile_query = MagicMock()
        profile_query.filter.return_value.first.return_value = None
        db.query.side_effect = [profile_query]

        with patch(
            "wecode.service.erp_entity_resolver.erp_client.search_employee"
        ) as mock_search:
            result = resolver.resolve_employee_id(db, 1)

        assert result is None
        mock_search.assert_not_called()
        # Short-circuits before the email lookup, so only the profile read ran.
        assert db.query.call_count == 1

    def test_profile_row_wins_over_cached_miss(self, resolver_with_mem_redis):
        """A profile written later (CAS/OIDC login) must resolve immediately."""
        resolver = resolver_with_mem_redis
        resolver._cache_set(
            resolver._no_profile_cache_key(1),
            NULL_MARKER,
            ttl=resolver._NO_PROFILE_CACHE_TTL,
        )
        db = MagicMock()
        profile_query = MagicMock()
        profile_query.filter.return_value.first.return_value = SimpleNamespace(
            employee_id="230473"
        )
        db.query.side_effect = [profile_query]

        with patch(
            "wecode.service.erp_entity_resolver.erp_client.search_employee"
        ) as mock_search:
            result = resolver.resolve_employee_id(db, 1)

        assert result == "230473"
        mock_search.assert_not_called()

    def test_transient_error_is_not_cached(self, resolver_with_mem_redis):
        """A directory outage must be retried, not pinned for the long TTL."""
        resolver = resolver_with_mem_redis
        db = _lazy_sync_db()

        with (
            patch(
                "wecode.service.erp_entity_resolver.distributed_lock.acquire_context",
                return_value=_acquired_lock(),
            ),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.search_employee",
                side_effect=RuntimeError("directory unavailable"),
            ),
        ):
            result = resolver.resolve_employee_id(db, 1)

        assert result is None
        assert resolver._cache_get(resolver._no_profile_cache_key(1)) is None
