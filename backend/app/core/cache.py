# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from typing import Any, Optional

import orjson
from redis import Redis as SyncRedis
from redis.asyncio import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)


class RedisCache:
    """Redis-based cache manager for GitHub repositories"""

    def __init__(self, url: str):
        # Use binary responses (decode_responses=False) to store orjson bytes
        self._url = url
        self._connection_params = {
            "encoding": "utf-8",
            "decode_responses": False,
            "max_connections": 10,
            "socket_timeout": 5.0,
            "socket_connect_timeout": 2.0,
            "retry_on_timeout": True,
        }

    async def _get_client(self) -> Redis:
        """
        Get Redis client, simply and directly create new connection
        """
        # Create new client every time to avoid event loop closure issues
        return Redis.from_url(self._url, **self._connection_params)

    def generate_full_cache_key(self, user_id: int, git_domain: str) -> str:
        """Generate cache key for full user repositories list"""
        # Keep the raw key without hashing, as requested
        return f"git_repos:{user_id}:{git_domain}"

    async def get(self, key: str) -> Optional[Any]:
        """Get value from cache"""
        try:
            client = await self._get_client()
            try:
                data = await client.get(key)
                if data is None:
                    return None
                try:
                    return orjson.loads(data)
                except Exception:
                    # If value was stored as plain bytes/string
                    return data
            finally:
                await client.aclose()
        except Exception as e:
            logger.error(f"Error getting cache key {key}: {str(e)}")
            return None

    def get_sync(self, key: str) -> Optional[Any]:
        """Get value from cache synchronously"""
        try:
            client = SyncRedis.from_url(
                self._url,
                encoding="utf-8",
                decode_responses=False,
                socket_timeout=5.0,
                socket_connect_timeout=2.0,
            )
            try:
                data = client.get(key)
                if data is None:
                    return None
                try:
                    return orjson.loads(data)
                except Exception:
                    # If value was stored as plain bytes/string
                    return data
            finally:
                client.close()
        except Exception as e:
            logger.error(f"Error getting cache key {key} (sync): {str(e)}")
            return None

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
        self, key: str, value: Any, expire: int = settings.REPO_CACHE_EXPIRED_TIME
    ) -> bool:
        """Set value to cache with expiration (seconds)"""
        try:
            client = await self._get_client()
            try:
                payload = orjson.dumps(value)
                ok = await client.set(key, payload, ex=expire)
                return bool(ok)
            finally:
                await client.aclose()
        except Exception as e:
            logger.error(f"Error setting cache key {key}: {str(e)}")
            return False

    async def setnx(
        self, key: str, value: Any, expire: int = settings.REPO_CACHE_EXPIRED_TIME
    ) -> bool:
        """Set value to cache only if key doesn't exist (SETNX operation)"""
        try:
            client = await self._get_client()
            try:
                payload = orjson.dumps(value)
                ok = await client.set(key, payload, ex=expire, nx=True)
                return bool(ok)
            finally:
                await client.aclose()
        except Exception as e:
            logger.error(f"Error setting cache key {key} with SETNX: {str(e)}")
            return False

    async def delete(self, key: str) -> bool:
        """Delete key from cache"""
        try:
            client = await self._get_client()
            try:
                deleted = await client.delete(key)
                return deleted > 0
            finally:
                await client.aclose()
        except Exception as e:
            logger.error(f"Error deleting cache key {key}: {str(e)}")
            return False

    async def cleanup_expired(self):
        """No-op: Redis handles expiration via TTL."""
        return None

    async def get_cache_size(self) -> int:
        """Get approximate number of keys in current DB"""
        try:
            client = await self._get_client()
            try:
                return await client.dbsize()
            finally:
                await client.aclose()
        except Exception as e:
            logger.error(f"Error getting cache size: {str(e)}")
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
