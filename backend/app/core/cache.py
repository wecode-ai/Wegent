# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Optional
import logging

from redis.asyncio import Redis
import orjson

from app.core.config import settings

logger = logging.getLogger(__name__)

class RedisCache:
    """Redis-based cache manager for GitHub repositories"""

    def __init__(self, url: str):
        # Use binary responses (decode_responses=False) to store orjson bytes
        self._client: Redis = Redis.from_url(url, encoding="utf-8", decode_responses=False)

    def generate_full_cache_key(self, user_id: int, git_domain: str) -> str:
        """Generate cache key for full user repositories list"""
        # Keep the raw key without hashing, as requested
        return f"git_repos:{user_id}:{git_domain}"

    async def get(self, key: str) -> Optional[Any]:
        """Get value from cache"""
        data = await self._client.get(key)
        if data is None:
            return None
        try:
            return orjson.loads(data)
        except Exception:
            # If value was stored as plain bytes/string
            return data

    async def set(self, key: str, value: Any, expire: int = settings.REPO_CACHE_EXPIRED_TIME) -> bool:
        """Set value to cache with expiration (seconds)"""
        logger.info(f"Storing {key} in cache, expire: {expire}")
        payload = orjson.dumps(value)
        ok = await self._client.set(key, payload, ex=expire)
        return bool(ok)

    async def setnx(self, key: str, value: Any, expire: int = settings.REPO_CACHE_EXPIRED_TIME) -> bool:
        """Set value to cache only if key doesn't exist (SETNX operation)"""
        logger.info(f"Storing {key} in cache if not exists, expire: {expire}")
        payload = orjson.dumps(value)
        ok = await self._client.set(key, payload, ex=expire, nx=True)
        return bool(ok)
    
    async def delete(self, key: str) -> bool:
        """Delete key from cache"""
        deleted = await self._client.delete(key)
        return deleted > 0

    async def cleanup_expired(self):
        """No-op: Redis handles expiration via TTL."""
        return None

    async def get_cache_size(self) -> int:
        """Get approximate number of keys in current DB"""
        return await self._client.dbsize()

    async def is_building(self, user_id: int, git_domain: str) -> bool:
        """Check if repositories are currently being built/fetched"""
        build_key = f"building:{user_id}:{git_domain}"
        result = await self.get(build_key)
        return result is True

    async def set_building(self, user_id: int, git_domain: str, building: bool = True) -> bool:
        """Set building status for user repositories"""
        build_key = f"building:{user_id}:{git_domain}"
        if building:
            return await self.set(build_key, True, expire=300)  # 5 minutes timeout
        else:
            return await self.delete(build_key)

# Global cache instance
cache_manager = RedisCache(settings.REDIS_URL)