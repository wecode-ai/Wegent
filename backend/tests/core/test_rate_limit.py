# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for custom rate limiting helpers."""

from types import SimpleNamespace
from unittest.mock import Mock, patch

from starlette.requests import Request

from app.core import rate_limit
from app.core.config import settings


class FakePipeline:
    def __init__(self, counts):
        self.counts = counts
        self.keys = []

    def incr(self, key):
        self.keys.append(key)
        return self

    def expire(self, key, ttl):
        return self

    def execute(self):
        results = []
        for count in self.counts:
            results.extend([count, True])
        return results


class FakeRedis:
    def __init__(self, counts):
        self.pipeline_instance = FakePipeline(counts)

    def pipeline(self):
        return self.pipeline_instance


def _make_request() -> Request:
    return Request(
        {
            "type": "http",
            "client": ("203.0.113.10", 12345),
            "headers": [(b"authorization", b"Bearer wg-secret-token")],
        }
    )


def _make_request_with_authorization(authorization: str) -> Request:
    return Request(
        {
            "type": "http",
            "client": ("203.0.113.10", 12345),
            "headers": [(b"authorization", authorization.encode("utf-8"))],
        }
    )


def test_external_mcp_rate_limit_uses_ip_and_hashed_token_keys():
    fake_redis = FakeRedis(counts=[1, 1])

    with (
        patch.object(settings, "RATE_LIMIT_ENABLED", True),
        patch.object(
            rate_limit, "_get_rate_limit_redis_client", return_value=fake_redis
        ),
        patch.object(rate_limit.time, "time", return_value=60),
    ):
        limited = rate_limit.is_external_mcp_rate_limited(
            _make_request(),
            namespace="transport",
            limit=2,
            window_seconds=60,
        )

    assert limited is False
    keys = fake_redis.pipeline_instance.keys
    assert len(keys) == 2
    assert all("external_kb_mcp:rate:transport:" in key for key in keys)
    assert any(":ip:" in key for key in keys)
    assert any(":token:" in key for key in keys)
    assert all("wg-secret-token" not in key for key in keys)


def test_external_mcp_rate_limit_uses_same_bearer_parser_as_auth():
    fake_redis = FakeRedis(counts=[1, 1])

    with (
        patch.object(settings, "RATE_LIMIT_ENABLED", True),
        patch.object(
            rate_limit, "_get_rate_limit_redis_client", return_value=fake_redis
        ),
    ):
        limited = rate_limit.is_external_mcp_rate_limited(
            _make_request_with_authorization("bearer wg-secret-token"),
            namespace="transport",
            limit=2,
            window_seconds=60,
        )

    assert limited is False
    keys = fake_redis.pipeline_instance.keys
    assert len(keys) == 2
    assert any(":token:" in key for key in keys)
    assert all("wg-secret-token" not in key for key in keys)


def test_external_mcp_rate_limit_blocks_when_any_dimension_exceeds_limit():
    fake_redis = FakeRedis(counts=[1, 3])

    with (
        patch.object(settings, "RATE_LIMIT_ENABLED", True),
        patch.object(
            rate_limit, "_get_rate_limit_redis_client", return_value=fake_redis
        ),
    ):
        limited = rate_limit.is_external_mcp_rate_limited(
            _make_request(),
            namespace="transport",
            limit=2,
            window_seconds=60,
        )

    assert limited is True


def test_external_mcp_rate_limit_reports_unavailable_when_redis_client_missing():
    with patch.object(rate_limit, "_get_rate_limit_redis_client", return_value=None):
        status = rate_limit.check_external_mcp_dimension_rate_limit(
            dimensions=["user:1"],
            namespace="search",
            limit=2,
            window_seconds=60,
        )

    assert status == rate_limit.ExternalMcpRateLimitStatus.UNAVAILABLE


def test_external_mcp_rate_limit_reports_unavailable_when_pipeline_fails():
    fake_redis = FakeRedis(counts=[1])
    fake_redis.pipeline_instance.execute = Mock(side_effect=RuntimeError("down"))

    with patch.object(
        rate_limit, "_get_rate_limit_redis_client", return_value=fake_redis
    ):
        status = rate_limit.check_external_mcp_dimension_rate_limit(
            dimensions=["user:1"],
            namespace="search",
            limit=2,
            window_seconds=60,
        )

    assert status == rate_limit.ExternalMcpRateLimitStatus.UNAVAILABLE


def test_external_mcp_rate_limit_ignores_global_api_rate_limit_switch():
    fake_redis = FakeRedis(counts=[3])

    with (
        patch.object(settings, "RATE_LIMIT_ENABLED", False),
        patch.object(
            rate_limit, "_get_rate_limit_redis_client", return_value=fake_redis
        ) as get_client,
    ):
        limited = rate_limit.is_external_mcp_dimension_rate_limited(
            dimensions=["user:1"],
            namespace="search",
            limit=2,
            window_seconds=60,
        )

    assert limited is True
    get_client.assert_called_once_with(require_global_enabled=False)


def test_check_redis_available_returns_true_when_ping_succeeds():
    fake_client = Mock()
    fake_redis = SimpleNamespace(from_url=Mock(return_value=fake_client))

    with (
        patch.object(settings, "RATE_LIMIT_ENABLED", True),
        patch.object(settings, "REDIS_URL", "redis://example/0"),
        patch.dict("sys.modules", {"redis": fake_redis}),
    ):
        assert rate_limit._check_redis_available() is True

    fake_redis.from_url.assert_called_once_with(
        "redis://example/0",
        socket_connect_timeout=1,
        socket_timeout=1,
    )
    fake_client.ping.assert_called_once_with()


def test_check_redis_available_returns_false_when_ping_fails():
    fake_client = Mock()
    fake_client.ping.side_effect = RuntimeError("down")
    fake_redis = SimpleNamespace(from_url=Mock(return_value=fake_client))

    with (
        patch.object(settings, "RATE_LIMIT_ENABLED", True),
        patch.dict("sys.modules", {"redis": fake_redis}),
    ):
        assert rate_limit._check_redis_available() is False
