"""Shared external session-cache boundary for MCP OAuth transaction tests."""

import pytest

from app.core.cache import cache_manager


@pytest.fixture
def mcp_session_cache(monkeypatch):
    values = {}

    def store(key, value, expire):
        values[key] = value
        return True

    monkeypatch.setattr(cache_manager, "set_from_sync", store)
    monkeypatch.setattr(cache_manager, "get_sync_or_raise", values.get)
    return values
