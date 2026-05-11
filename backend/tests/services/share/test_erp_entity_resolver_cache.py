# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ErpEntityResolver membership cache."""

from unittest.mock import MagicMock, patch

import pytest

from wecode.service.erp_entity_resolver import ErpEntityResolver

resolver = ErpEntityResolver()


class TestGetMembershipWithCache:
    def test_cache_miss_queries_api_and_stores(self):
        with (
            patch("wecode.service.erp_entity_resolver.cache_manager") as mock_cache,
            patch.object(resolver, "_get_user_ssn", return_value="ssn123"),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.batch_check_membership"
            ) as mock_api,
        ):
            mock_cache.get_sync.return_value = None
            mock_api.return_value = {"d1": True, "d2": False}

            result = resolver.match_entity_bindings(
                MagicMock(), 1, "org_department", ["d1", "d2"]
            )

            assert result == ["d1"]
            mock_api.assert_called_once_with("ssn123", ["d1", "d2"])
            mock_cache.set_sync.assert_called_once()
            cache_key = mock_cache.set_sync.call_args[0][0]
            assert "erp:membership:1:ssn123" == cache_key

    def test_cache_hit_avoids_api_call(self):
        with (
            patch("wecode.service.erp_entity_resolver.cache_manager") as mock_cache,
            patch.object(resolver, "_get_user_ssn", return_value="ssn123"),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.batch_check_membership"
            ) as mock_api,
        ):
            mock_cache.get_sync.return_value = {"d1": True, "d2": False}

            result = resolver.match_entity_bindings(
                MagicMock(), 1, "org_department", ["d1", "d2"]
            )

            assert result == ["d1"]
            mock_api.assert_not_called()

    def test_partial_hit_queries_only_missing(self):
        with (
            patch("wecode.service.erp_entity_resolver.cache_manager") as mock_cache,
            patch.object(resolver, "_get_user_ssn", return_value="ssn123"),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.batch_check_membership"
            ) as mock_api,
        ):
            mock_cache.get_sync.return_value = {"d1": True}
            mock_api.return_value = {"d2": False}

            result = resolver.match_entity_bindings(
                MagicMock(), 1, "org_department", ["d1", "d2"]
            )

            assert result == ["d1"]
            mock_api.assert_called_once_with("ssn123", ["d2"])
            # Updated cache should include both d1 and d2
            stored = mock_cache.set_sync.call_args[0][1]
            assert stored["d1"] is True
            assert stored["d2"] is False

    def test_cache_ttl_is_one_hour(self):
        with (
            patch("wecode.service.erp_entity_resolver.cache_manager") as mock_cache,
            patch.object(resolver, "_get_user_ssn", return_value="ssn123"),
            patch(
                "wecode.service.erp_entity_resolver.erp_client.batch_check_membership",
                return_value={"d1": True},
            ),
        ):
            mock_cache.get_sync.return_value = None

            resolver.match_entity_bindings(MagicMock(), 1, "org_department", ["d1"])

            expire = mock_cache.set_sync.call_args[1].get("expire")
            assert expire == 900
