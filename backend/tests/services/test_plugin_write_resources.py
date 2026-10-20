"""Coordination connections must have independent, short failure budgets."""

from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine

from app.services import plugin_write_resources as resources


def test_redis_commands_have_short_timeouts_and_no_network_retry(monkeypatch):
    factory = Mock()
    monkeypatch.setattr(resources, "_redis", None)
    monkeypatch.setattr(resources.Redis, "from_url", factory)

    assert resources.redis_client() is resources.redis_client()

    options = factory.call_args.kwargs
    assert options["socket_timeout"] == 0.5
    assert options["socket_connect_timeout"] == 0.5
    assert options["retry_on_timeout"] is False
    assert options["retry"].get_retries() == 0
    resources.close_plugin_write_resources()
    factory.return_value.close.assert_called_once()


def test_fence_pool_is_independent_and_shared_across_session_option_engines():
    business = create_engine(
        "mysql+pymysql://unused@127.0.0.1/unused", pool_size=1, max_overflow=0
    )
    try:
        fence = resources.fence_engine(business)
        configured = business.execution_options(isolation_level="READ COMMITTED")

        assert resources.fence_engine(configured) is fence
        assert fence.pool is not business.pool
        assert fence.pool.size() == 2
        assert fence.pool.timeout() == 1
    finally:
        resources.close_plugin_write_resources()
        business.dispose()


def test_redis_close_failure_still_disposes_every_fence_pool(monkeypatch):
    client = Mock()
    client.close.side_effect = RuntimeError("close failed")
    engines = [Mock(), Mock()]
    monkeypatch.setattr(resources, "_redis", client)
    monkeypatch.setattr(resources, "_fence_engines", {1: engines[0], 2: engines[1]})

    with pytest.raises(RuntimeError, match="close failed"):
        resources.close_plugin_write_resources()

    assert resources._redis is None
    assert not resources._fence_engines
    for engine in engines:
        engine.dispose.assert_called_once()
