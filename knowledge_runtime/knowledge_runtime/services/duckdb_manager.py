# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local cache management for DuckDB files with LRU+TTL eviction.

Provides a file-based cache for .duckdb files downloaded from Backend storage,
with per-key async locking to prevent duplicate downloads, TTL-based expiration,
and LRU eviction when cache size exceeds the configured limit.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any

from knowledge_runtime.config import get_settings
from knowledge_runtime.services.content_fetcher import ContentFetcher, ContentFetchError
from shared.models.knowledge_runtime_protocol import ContentRef

logger = logging.getLogger(__name__)


class _CacheEntry:
    """Metadata for a cached DuckDB file."""

    __slots__ = ("path", "attachment_id", "access_time", "create_time", "size")

    def __init__(
        self,
        path: Path,
        attachment_id: int,
        access_time: float,
        create_time: float,
        size: int,
    ) -> None:
        self.path = path
        self.attachment_id = attachment_id
        self.access_time = access_time
        self.create_time = create_time
        self.size = size


class DuckDBManager:
    """Manages local DuckDB file cache with LRU+TTL eviction.

    Downloads .duckdb files from Backend via ContentFetcher and caches them
    locally. Implements:
    - LRU eviction when total cache exceeds configured size limit
    - TTL expiration for stale entries
    - Per-key async lock to prevent duplicate downloads
    """

    def __init__(self) -> None:
        self._settings = get_settings()
        self._content_fetcher = ContentFetcher()
        self._cache_dir = Path(self._settings.duckdb_cache_dir)
        self._cache: dict[str, _CacheEntry] = {}
        self._locks: dict[str, Any] = {}
        self._initialized = False

    def _ensure_cache_dir(self) -> None:
        """Create the cache directory if it does not exist."""
        if not self._initialized:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            # Scan existing cache files on first access
            self._scan_existing_cache()
            self._initialized = True

    def _scan_existing_cache(self) -> None:
        """Scan cache directory for existing .duckdb files and load metadata."""
        if not self._cache_dir.exists():
            return

        for entry in self._cache_dir.glob("*.duckdb"):
            try:
                stat = entry.stat()
                cache_key = entry.stem
                self._cache[cache_key] = _CacheEntry(
                    path=entry,
                    attachment_id=0,  # Unknown for pre-existing files
                    access_time=stat.st_mtime,
                    create_time=stat.st_ctime,
                    size=stat.st_size,
                )
                logger.debug("Loaded existing cache entry: %s", cache_key)
            except OSError as exc:
                logger.warning("Failed to stat cache file %s: %s", entry, exc)

    def _get_cache_key(self, attachment_id: int) -> str:
        """Generate a cache key from attachment ID.

        Uses SHA-256 hash for consistent, collision-free key generation.

        Args:
            attachment_id: The attachment ID.

        Returns:
            SHA-256 hash string used as cache key.
        """
        raw = f"attachment_{attachment_id}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def _get_cache_path(self, cache_key: str) -> Path:
        """Get the full path for a cache entry.

        Args:
            cache_key: The cache key.

        Returns:
            Path to the cached .duckdb file.
        """
        return self._cache_dir / f"{cache_key}.duckdb"

    async def get_duckdb_path(
        self,
        attachment_id: int,
        content_ref: ContentRef,
    ) -> Path:
        """Download .duckdb file if not cached, return local path.

        Uses ContentFetcher to download the binary data from Backend.
        Caches to {DUCKDB_CACHE_DIR}/{attachment_id_sha256}.duckdb

        Args:
            attachment_id: Attachment ID for the DuckDB file.
            content_ref: Content reference for downloading the file.

        Returns:
            Path to the local cached DuckDB file.

        Raises:
            ContentFetchError: If downloading fails.
            RuntimeError: If cache operations fail.
        """
        self._ensure_cache_dir()

        cache_key = self._get_cache_key(attachment_id)
        cache_path = self._get_cache_path(cache_key)

        # Check if the file is already cached and not expired
        if self._is_cache_valid(cache_key, cache_path):
            # Update access time for LRU tracking
            self._touch_cache_entry(cache_key)
            logger.debug(
                "Cache hit for attachment_id=%d (key=%s)", attachment_id, cache_key
            )
            return cache_path

        # Acquire per-key lock to prevent duplicate downloads
        lock = self._get_lock(cache_key)

        async with lock:
            # Double-check after acquiring lock (another coroutine may have downloaded)
            if self._is_cache_valid(cache_key, cache_path):
                self._touch_cache_entry(cache_key)
                return cache_path

            # Download the DuckDB file
            logger.info("Downloading DuckDB file for attachment_id=%d", attachment_id)

            try:
                binary_data, _, _ = await self._content_fetcher.fetch(content_ref)
            except ContentFetchError:
                raise
            except Exception as exc:
                raise ContentFetchError(
                    f"Failed to download DuckDB file: {exc}",
                    retryable=True,
                ) from exc

            # Verify it looks like a DuckDB file (basic magic byte check)
            if not self._is_valid_duckdb_data(binary_data):
                raise RuntimeError(
                    f"Downloaded data for attachment_id={attachment_id} "
                    f"does not appear to be a valid DuckDB file"
                )

            # Write to cache
            try:
                cache_path.write_bytes(binary_data)
                stat = cache_path.stat()
                now = time.time()
                self._cache[cache_key] = _CacheEntry(
                    path=cache_path,
                    attachment_id=attachment_id,
                    access_time=now,
                    create_time=now,
                    size=stat.st_size,
                )
                logger.info(
                    "Cached DuckDB file for attachment_id=%d " "(size=%.1f KB, key=%s)",
                    attachment_id,
                    len(binary_data) / 1024,
                    cache_key,
                )
            except OSError as exc:
                raise RuntimeError(f"Failed to write cache file: {exc}") from exc

            # Run eviction check in background
            self._evict_if_needed()

            return cache_path

    def _is_cache_valid(self, cache_key: str, cache_path: Path) -> bool:
        """Check if a cache entry is valid (exists and not expired).

        Args:
            cache_key: The cache key.
            cache_path: Expected path of the cached file.

        Returns:
            True if the cache entry is valid.
        """
        if not cache_path.exists():
            return False

        # Check TTL
        entry = self._cache.get(cache_key)
        if entry is not None:
            ttl_seconds = self._settings.duckdb_cache_ttl_hours * 3600
            age = time.time() - entry.create_time
            if age > ttl_seconds:
                logger.info(
                    "Cache entry expired (key=%s, age=%.1fh, ttl=%dh)",
                    cache_key,
                    age / 3600,
                    self._settings.duckdb_cache_ttl_hours,
                )
                self._remove_cache_entry(cache_key)
                return False

        return True

    def _touch_cache_entry(self, cache_key: str) -> None:
        """Update access time for LRU tracking.

        Args:
            cache_key: The cache key.
        """
        entry = self._cache.get(cache_key)
        if entry is not None:
            entry.access_time = time.time()

    def _remove_cache_entry(self, cache_key: str) -> None:
        """Remove a cache entry and delete the file.

        Args:
            cache_key: The cache key.
        """
        entry = self._cache.pop(cache_key, None)
        if entry is not None:
            try:
                entry.path.unlink(missing_ok=True)
                logger.debug("Removed cache entry: %s", cache_key)
            except OSError as exc:
                logger.warning("Failed to delete cache file %s: %s", entry.path, exc)

    def _evict_if_needed(self) -> None:
        """Evict cache entries if total size exceeds the configured limit.

        Uses LRU strategy: removes least recently accessed entries first
        until total size is under the limit.
        """
        max_size_bytes = self._settings.duckdb_cache_max_size_gb * 1024 * 1024 * 1024
        current_size = sum(entry.size for entry in self._cache.values())

        if current_size <= max_size_bytes:
            return

        logger.info(
            "Cache size (%.2f GB) exceeds limit (%.2f GB), starting eviction",
            current_size / (1024**3),
            self._settings.duckdb_cache_max_size_gb,
        )

        # Sort by access time (oldest first)
        sorted_entries = sorted(
            self._cache.items(), key=lambda item: item[1].access_time
        )

        for cache_key, entry in sorted_entries:
            if current_size <= max_size_bytes:
                break

            logger.info(
                "Evicting cache entry: key=%s, size=%.1f KB, last_accessed=%.1fh ago",
                cache_key,
                entry.size / 1024,
                (time.time() - entry.access_time) / 3600,
            )
            current_size -= entry.size
            self._remove_cache_entry(cache_key)

        logger.info(
            "Eviction complete. Cache size: %.2f GB",
            current_size / (1024**3),
        )

    def _get_lock(self, cache_key: str) -> Any:
        """Get or create an asyncio lock for a cache key.

        Prevents duplicate downloads of the same file when multiple
        coroutines request the same attachment concurrently.

        Args:
            cache_key: The cache key.

        Returns:
            An asyncio.Lock instance.
        """
        import asyncio

        if cache_key not in self._locks:
            self._locks[cache_key] = asyncio.Lock()
        return self._locks[cache_key]

    def _is_valid_duckdb_data(self, data: bytes) -> bool:
        """Check if data appears to be a valid DuckDB file.

        DuckDB files start with a specific magic number.

        Args:
            data: Binary data to check.

        Returns:
            True if the data appears to be a valid DuckDB file.
        """
        if len(data) < 4:
            return False

        # DuckDB file magic: the first 4 bytes are a version number
        # followed by a specific signature. DuckDB files typically start
        # with bytes that identify them. A simple heuristic: check if
        # the file is at least 4KB and can be parsed.
        # More robust: try to open it with DuckDB
        try:
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".duckdb", delete=True) as tmp:
                tmp.write(data)
                tmp.flush()

                import duckdb

                conn = duckdb.connect(tmp.name, read_only=True)
                try:
                    conn.execute("SELECT 1").fetchone()
                    return True
                finally:
                    conn.close()
        except Exception:
            return False

    def clear_cache(self) -> None:
        """Clear all cached DuckDB files."""
        self._ensure_cache_dir()

        for cache_key in list(self._cache.keys()):
            self._remove_cache_entry(cache_key)

        logger.info("DuckDB cache cleared")
