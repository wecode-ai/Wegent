# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import hashlib
import time
from typing import Any, Optional, Dict, List
from datetime import datetime, timedelta

class MemoryCache:
    """In-memory cache manager for GitHub repositories"""
    
    def __init__(self):
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
    
    def generate_full_cache_key(self, user_id: int, git_domain: str) -> str:
        """Generate cache key for full user repositories list"""
        key_data = f"github_repos_full:{user_id}:{git_domain}"
        return hashlib.md5(key_data.encode()).hexdigest()
    
    async def get(self, key: str) -> Optional[Any]:
        """Get value from cache"""
        async with self._lock:
            if key in self._cache:
                item = self._cache[key]
                if item['expires'] > time.time():
                    return item['value']
                else:
                    del self._cache[key]
            return None
    
    async def set(self, key: str, value: Any, expire: int = 3600) -> bool:
        """Set value to cache"""
        async with self._lock:
            self._cache[key] = {
                'value': value,
                'expires': time.time() + expire
            }
            return True
    
    async def delete(self, key: str) -> bool:
        """Delete key from cache"""
        async with self._lock:
            if key in self._cache:
                del self._cache[key]
                return True
            return False
    
    async def cleanup_expired(self):
        """Clean up expired cache entries"""
        async with self._lock:
            current_time = time.time()
            expired_keys = [
                key for key, item in self._cache.items()
                if item['expires'] <= current_time
            ]
            for key in expired_keys:
                del self._cache[key]
    
    def get_cache_size(self) -> int:
        """Get current cache size"""
        return len(self._cache)
    
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
cache_manager = MemoryCache()