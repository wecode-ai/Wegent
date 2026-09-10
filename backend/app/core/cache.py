# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from threading import Lock
from typing import Any, Dict, List, Optional

import orjson
from redis import ConnectionPool as SyncConnectionPool
from redis import Redis as SyncRedis
from redis.asyncio import ConnectionPool, Redis

from app.core.config import settings

logger = logging.getLogger(__name__)

ATOMIC_POP_SCRIPT = """
local value = redis.call('GET', KEYS[1])
if value then
    redis.call('DEL', KEYS[1])
end
return value
"""


class RedisCache:
    """Redis-based cache manager."""

    def __init__(self, url: str):
        # Use binary responses (decode_responses=False) to store orjson bytes
        self._url = url
        self._connection_params = {
            "encoding": "utf-8",
            "decode_responses": False,
            "socket_timeout": 5.0,
            "socket_connect_timeout": 2.0,
            "retry_on_timeout": True,
        }
        self._pool: Optional[ConnectionPool] = None
        self._client: Optional[Redis] = None
        self._owner_loop: Optional[asyncio.AbstractEventLoop] = None
        self._async_client_lock = Lock()
        self._sync_pool: Optional[SyncConnectionPool] = None
        self._sync_client: Optional[SyncRedis] = None
        self._sync_client_lock = Lock()

    async def start(self) -> None:
        """Bind the reusable asynchronous client to the application loop."""
        loop = asyncio.get_running_loop()
        with self._async_client_lock:
            if self._owner_loop is loop and self._client is not None:
                return
            if self._owner_loop is not None:
                raise RuntimeError("Redis cache is already bound to another event loop")
            self._pool = ConnectionPool.from_url(self._url, **self._connection_params)
            # Passing an explicit pool keeps lower-level client.aclose() calls
            # from disconnecting the application-owned pool.
            self._client = Redis(connection_pool=self._pool)
            self._owner_loop = loop

    async def _get_client(self) -> Redis:
        """Return the shared owner client or an isolated caller-owned client."""
        loop = asyncio.get_running_loop()
        with self._async_client_lock:
            if self._owner_loop is loop and self._client is not None:
                return self._client
        # Redis asyncio connections are bound to the loop where they perform I/O.
        # Synchronous services use asyncio.run() on short-lived worker loops, so
        # those loops must never borrow connections from the application pool.
        return Redis.from_url(self._url, **self._connection_params)

    @asynccontextmanager
    async def _client_context(self) -> AsyncIterator[Redis]:
        """Close clients created outside the application-owned event loop."""
        loop = asyncio.get_running_loop()
        client = await self._get_client()
        with self._async_client_lock:
            application_owned = self._owner_loop is loop
        try:
            yield client
        finally:
            if not application_owned:
                await client.aclose()

    def _get_sync_client(self) -> SyncRedis:
        """Return the process-owned synchronous Redis client."""
        with self._sync_client_lock:
            if self._sync_client is None:
                self._sync_pool = SyncConnectionPool.from_url(
                    self._url, **self._connection_params
                )
                self._sync_client = SyncRedis(connection_pool=self._sync_pool)
            return self._sync_client

    @staticmethod
    def _decode(data: Any) -> Any:
        """Decode JSON cache values while preserving plain bytes."""
        try:
            return orjson.loads(data)
        except Exception:
            return data

    async def aclose(self) -> None:
        """Close process-owned asynchronous and synchronous connection pools."""
        loop = asyncio.get_running_loop()
        with self._async_client_lock:
            if self._owner_loop is not None and self._owner_loop is not loop:
                raise RuntimeError(
                    "Redis cache must be closed from its owning event loop"
                )
            client = self._client
            pool = self._pool
            self._client = None
            self._pool = None
            self._owner_loop = None
        sync_client = self._sync_client
        sync_pool = self._sync_pool
        self._sync_client = None
        self._sync_pool = None

        try:
            if client is not None:
                await client.aclose(close_connection_pool=False)
        finally:
            try:
                if pool is not None:
                    await pool.aclose()
            finally:
                if sync_client is not None:
                    sync_client.close()
                if sync_pool is not None:
                    sync_pool.disconnect()

    def generate_full_cache_key(self, user_id: int, git_domain: str) -> str:
        """Generate cache key for full user repositories list"""
        # Keep the raw key without hashing, as requested
        return f"git_repos:{user_id}:{git_domain}"

    async def get(self, key: str) -> Optional[Any]:
        """Get value from cache"""
        try:
            return await self.get_or_raise(key)
        except Exception as e:
            logger.error("Error getting cache key %s: %s", key, e)
            return None

    async def get_or_raise(self, key: str) -> Optional[Any]:
        """Get a value while keeping Redis failures distinct from cache misses."""
        async with self._client_context() as client:
            data = await client.get(key)
        if data is None:
            return None
        return self._decode(data)

    async def mget(self, keys: List[str]) -> Dict[str, Any]:
        """Get multiple values from cache in a single request.

        Args:
            keys: List of cache keys to retrieve

        Returns:
            Dict mapping keys to their values (missing keys are omitted)
        """
        if not keys:
            return {}

        try:
            return await self.mget_or_raise(keys)
        except Exception as e:
            logger.error("Error getting cache keys %s: %s", keys, e)
            return {}

    async def mget_or_raise(self, keys: List[str]) -> Dict[str, Any]:
        """Get values while keeping Redis failures distinct from missing keys."""
        if not keys:
            return {}
        async with self._client_context() as client:
            values = await client.mget(keys)
        return {
            key: self._decode(data)
            for key, data in zip(keys, values)
            if data is not None
        }

    def get_sync(self, key: str) -> Optional[Any]:
        """Get value from cache synchronously"""
        try:
            return self.get_sync_or_raise(key)
        except Exception as e:
            logger.error("Error getting cache key %s (sync): %s", key, e)
            return None

    def get_sync_or_raise(self, key: str) -> Optional[Any]:
        """Synchronously get a value without hiding Redis failures."""
        data = self._get_sync_client().get(key)
        if data is None:
            return None
        return self._decode(data)

    def set_from_sync(
        self,
        key: str,
        value: Any,
        expire: int | None = settings.REPO_CACHE_EXPIRED_TIME,
    ) -> bool:
        """Set value to cache synchronously for background threads."""
        try:
            payload = orjson.dumps(value)
            client = self._get_sync_client()
            if expire is None:
                ok = client.set(key, payload)
            else:
                ok = client.set(key, payload, ex=expire)
            return bool(ok)
        except Exception as e:
            logger.error("Error setting cache key %s (sync): %s", key, e)
            return False

    def get_user_repositories_sync(
        self, user_id: int, git_domain: str
    ) -> Optional[list]:
        """
        Get user's cached repository list synchronously.

        Args:
            user_id: User ID
            git_domain: Git domain (e.g., gitlab.com, github.com)

        Returns:
            List of cached repositories, or None if not cached
        """
        cache_key = self.generate_full_cache_key(user_id, git_domain)
        return self.get_sync(cache_key)

    async def set(
        self,
        key: str,
        value: Any,
        expire: int | None = settings.REPO_CACHE_EXPIRED_TIME,
    ) -> bool:
        """Set value to cache with optional expiration (seconds)"""
        try:
            return await self.set_or_raise(key, value, expire)
        except Exception as e:
            logger.error("Error setting cache key %s: %s", key, e)
            return False

    async def set_or_raise(
        self,
        key: str,
        value: Any,
        expire: int | None = settings.REPO_CACHE_EXPIRED_TIME,
    ) -> bool:
        """Set a value without hiding Redis failures."""
        async with self._client_context() as client:
            payload = orjson.dumps(value)
            if expire is None:
                ok = await client.set(key, payload)
            else:
                ok = await client.set(key, payload, ex=expire)
        return bool(ok)

    async def setnx(
        self, key: str, value: Any, expire: int = settings.REPO_CACHE_EXPIRED_TIME
    ) -> bool:
        """Set value to cache only if key doesn't exist (SETNX operation)"""
        try:
            async with self._client_context() as client:
                payload = orjson.dumps(value)
                ok = await client.set(key, payload, ex=expire, nx=True)
            return bool(ok)
        except Exception as e:
            logger.error("Error setting cache key %s with SETNX: %s", key, e)
            return False

    async def delete(self, key: str) -> bool:
        """Delete key from cache"""
        try:
            return await self.delete_or_raise(key)
        except Exception as e:
            logger.error("Error deleting cache key %s: %s", key, e)
            return False

    async def delete_or_raise(self, key: str) -> bool:
        """Delete a key without hiding Redis failures."""
        async with self._client_context() as client:
            deleted = await client.delete(key)
        return deleted > 0

    async def pop(self, key: str) -> Optional[Any]:
        """Atomically return and delete one cache value."""
        try:
            async with self._client_context() as client:
                data = await client.eval(ATOMIC_POP_SCRIPT, 1, key)
            if data is None:
                return None
            return self._decode(data)
        except Exception as e:
            logger.error("Error popping cache key %s: %s", key, e)
            return None

    async def cleanup_expired(self):
        """No-op: Redis handles expiration via TTL."""
        return None

    async def get_cache_size(self) -> int:
        """Get approximate number of keys in current DB"""
        try:
            async with self._client_context() as client:
                return await client.dbsize()
        except Exception as e:
            logger.error("Error getting cache size: %s", e)
            return 0

    async def is_building(self, user_id: int, git_domain: str) -> bool:
        """Check if repositories are currently being built/fetched"""
        try:
            build_key = f"building:{user_id}:{git_domain}"
            result = await self.get(build_key)
            return result is True
        except Exception as e:
            logger.error(
                f"Error checking building status for user {user_id}, domain {git_domain}: {str(e)}"
            )
            return False

    async def set_building(
        self, user_id: int, git_domain: str, building: bool = True
    ) -> bool:
        """Set building status for user repositories"""
        try:
            build_key = f"building:{user_id}:{git_domain}"
            if building:
                return await self.set(build_key, True, expire=300)  # 5 minutes timeout
            else:
                return await self.delete(build_key)
        except Exception as e:
            logger.error(
                f"Error setting building status for user {user_id}, domain {git_domain}: {str(e)}"
            )
            return False


# Global cache instance
cache_manager = RedisCache(settings.REDIS_URL)
