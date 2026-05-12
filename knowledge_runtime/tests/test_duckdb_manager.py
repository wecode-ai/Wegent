# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DuckDB cache manager with LRU+TTL eviction."""

from __future__ import annotations

import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import duckdb
import pytest

from knowledge_runtime.services.content_fetcher import ContentFetchError
from knowledge_runtime.services.duckdb_manager import DuckDBManager, _CacheEntry
from shared.models import BackendAttachmentStreamContentRef


def _make_content_ref() -> BackendAttachmentStreamContentRef:
    """Create a test content reference."""
    return BackendAttachmentStreamContentRef(
        kind="backend_attachment_stream",
        url="http://backend:8000/api/internal/rag/content/42",
        auth_token="test-token",
    )


def _create_test_duckdb_bytes() -> bytes:
    """Create a small valid DuckDB file in memory and return its bytes."""
    tmp_dir = tempfile.mkdtemp(prefix="duckdb_test_")
    db_path = Path(tmp_dir) / "test.duckdb"

    conn = duckdb.connect(str(db_path))
    try:
        conn.execute("CREATE TABLE test_data (id INTEGER, value VARCHAR)")
        conn.execute("INSERT INTO test_data VALUES (1, 'hello')")
        conn.execute("CHECKPOINT")
    finally:
        conn.close()

    data = db_path.read_bytes()

    # Cleanup
    import shutil

    shutil.rmtree(tmp_dir, ignore_errors=True)
    return data


@pytest.fixture
def mock_settings():
    """Create mock settings for cache manager."""
    settings = MagicMock()
    settings.duckdb_cache_dir = tempfile.mkdtemp(prefix="duckdb_cache_test_")
    settings.duckdb_cache_max_size_gb = 5.0
    settings.duckdb_cache_ttl_hours = 24
    settings.content_fetch_timeout = 120
    return settings


@pytest.fixture
def mock_content_fetcher():
    """Create a mock ContentFetcher."""
    with patch("knowledge_runtime.services.duckdb_manager.ContentFetcher") as mock_cls:
        fetcher = MagicMock()
        mock_cls.return_value = fetcher
        yield fetcher


@pytest.fixture
def manager(mock_settings, mock_content_fetcher):
    """Create a DuckDBManager with mocked dependencies."""
    with patch(
        "knowledge_runtime.services.duckdb_manager.get_settings",
        return_value=mock_settings,
    ):
        mgr = DuckDBManager()
        yield mgr
        # Cleanup
        mgr.clear_cache()
        import shutil

        shutil.rmtree(mock_settings.duckdb_cache_dir, ignore_errors=True)


class TestCacheKeyGeneration:
    """Tests for cache key generation."""

    def test_cache_key_is_deterministic(self, manager) -> None:
        """Same attachment_id should always produce the same cache key."""
        key1 = manager._get_cache_key(42)
        key2 = manager._get_cache_key(42)
        assert key1 == key2

    def test_cache_key_differs_for_different_ids(self, manager) -> None:
        """Different attachment_ids should produce different cache keys."""
        key1 = manager._get_cache_key(1)
        key2 = manager._get_cache_key(2)
        assert key1 != key2

    def test_cache_key_is_sha256_hex(self, manager) -> None:
        """Cache key should be a SHA-256 hex string (64 chars)."""
        key = manager._get_cache_key(42)
        assert len(key) == 64
        assert all(c in "0123456789abcdef" for c in key)


class TestLRUEviction:
    """Tests for LRU eviction when cache exceeds size limit."""

    def test_eviction_removes_oldest_entries(self, manager, mock_settings) -> None:
        """Eviction should remove least recently accessed entries first."""
        # Set a very small cache limit
        mock_settings.duckdb_cache_max_size_gb = 0.00001  # ~10KB

        # Create multiple cache entries manually
        now = time.time()
        for i in range(3):
            cache_key = manager._get_cache_key(i)
            cache_path = manager._get_cache_path(cache_key)
            cache_path.write_bytes(b"x" * 5000)  # 5KB each
            manager._cache[cache_key] = _CacheEntry(
                path=cache_path,
                attachment_id=i,
                access_time=now - (3 - i) * 100,  # Older entries first
                create_time=now,
                size=5000,
            )

        # Trigger eviction
        manager._evict_if_needed()

        # The oldest entry should have been removed
        oldest_key = manager._get_cache_key(0)
        assert oldest_key not in manager._cache

    def test_eviction_keeps_recently_accessed(self, manager, mock_settings) -> None:
        """Eviction should keep recently accessed entries."""
        # Set cache limit very small so 2 entries definitely exceed it
        mock_settings.duckdb_cache_max_size_gb = 0.000005  # ~5KB

        now = time.time()
        # Create two entries: old and new
        old_key = manager._get_cache_key(100)
        new_key = manager._get_cache_key(101)

        old_path = manager._get_cache_path(old_key)
        new_path = manager._get_cache_path(new_key)
        old_path.write_bytes(b"x" * 5000)
        new_path.write_bytes(b"y" * 5000)

        manager._cache[old_key] = _CacheEntry(
            path=old_path,
            attachment_id=100,
            access_time=now - 1000,
            create_time=now - 1000,
            size=5000,
        )
        manager._cache[new_key] = _CacheEntry(
            path=new_path,
            attachment_id=101,
            access_time=now,
            create_time=now,
            size=5000,
        )

        manager._evict_if_needed()

        # New entry should survive, old should be evicted
        assert new_key in manager._cache
        assert old_key not in manager._cache


class TestTTLExpiration:
    """Tests for TTL-based cache expiration."""

    def test_cache_entry_expired_past_ttl(self, manager, mock_settings) -> None:
        """Cache entries older than TTL should be considered expired."""
        mock_settings.duckdb_cache_ttl_hours = 1  # 1 hour TTL

        now = time.time()
        cache_key = manager._get_cache_key(200)
        cache_path = manager._get_cache_path(cache_key)
        cache_path.write_bytes(b"test data")

        # Create an entry that's 2 hours old (past 1-hour TTL)
        manager._cache[cache_key] = _CacheEntry(
            path=cache_path,
            attachment_id=200,
            access_time=now,
            create_time=now - 7200,  # 2 hours ago
            size=9,
        )

        # Should be expired
        assert not manager._is_cache_valid(cache_key, cache_path)

    def test_cache_entry_valid_within_ttl(self, manager, mock_settings) -> None:
        """Cache entries within TTL should be considered valid."""
        mock_settings.duckdb_cache_ttl_hours = 24

        now = time.time()
        cache_key = manager._get_cache_key(201)
        cache_path = manager._get_cache_path(cache_key)
        cache_path.write_bytes(b"test data")

        # Create an entry that's 1 hour old (within 24-hour TTL)
        manager._cache[cache_key] = _CacheEntry(
            path=cache_path,
            attachment_id=201,
            access_time=now,
            create_time=now - 3600,  # 1 hour ago
            size=9,
        )

        assert manager._is_cache_valid(cache_key, cache_path)


class TestCacheMissDownloadFlow:
    """Tests for cache miss -> download flow."""

    @pytest.mark.asyncio
    async def test_cache_miss_triggers_download(
        self, manager, mock_content_fetcher
    ) -> None:
        """Cache miss should trigger download via ContentFetcher."""
        duckdb_bytes = _create_test_duckdb_bytes()
        mock_content_fetcher.fetch = AsyncMock(
            return_value=(duckdb_bytes, "data.duckdb", ".duckdb")
        )

        content_ref = _make_content_ref()
        result_path = await manager.get_duckdb_path(
            attachment_id=300, content_ref=content_ref
        )

        # ContentFetcher should have been called
        mock_content_fetcher.fetch.assert_called_once_with(content_ref)

        # The returned path should exist
        assert result_path.exists()

    @pytest.mark.asyncio
    async def test_cache_hit_avoids_download(
        self, manager, mock_content_fetcher
    ) -> None:
        """Cache hit should not trigger download."""
        duckdb_bytes = _create_test_duckdb_bytes()

        # First call: cache miss -> download
        mock_content_fetcher.fetch = AsyncMock(
            return_value=(duckdb_bytes, "data.duckdb", ".duckdb")
        )
        await manager.get_duckdb_path(
            attachment_id=301, content_ref=_make_content_ref()
        )

        # Second call: cache hit -> no download
        mock_content_fetcher.fetch.reset_mock()
        await manager.get_duckdb_path(
            attachment_id=301, content_ref=_make_content_ref()
        )

        # Should not fetch again
        mock_content_fetcher.fetch.assert_not_called()

    @pytest.mark.asyncio
    async def test_download_failure_raises_content_fetch_error(
        self, manager, mock_content_fetcher
    ) -> None:
        """Download failure should raise ContentFetchError."""
        mock_content_fetcher.fetch = AsyncMock(
            side_effect=ContentFetchError("Network error", retryable=True)
        )

        with pytest.raises(ContentFetchError, match="Network error"):
            await manager.get_duckdb_path(
                attachment_id=302, content_ref=_make_content_ref()
            )


class TestCacheValidation:
    """Tests for DuckDB file validation."""

    def test_valid_duckdb_data_passes_check(self, manager) -> None:
        """Valid DuckDB data should pass the validity check."""
        duckdb_bytes = _create_test_duckdb_bytes()
        assert manager._is_valid_duckdb_data(duckdb_bytes) is True

    def test_invalid_data_fails_check(self, manager) -> None:
        """Non-DuckDB data should fail the validity check."""
        assert manager._is_valid_duckdb_data(b"not a duckdb file") is False

    def test_too_small_data_fails_check(self, manager) -> None:
        """Data smaller than 4 bytes should fail the validity check."""
        assert manager._is_valid_duckdb_data(b"abc") is False
