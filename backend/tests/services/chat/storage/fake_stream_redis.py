# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Small Redis transaction fake for bounded chat streaming storage tests."""

from __future__ import annotations

from typing import Any


def redis_size(value: Any) -> int:
    if isinstance(value, bytes):
        return len(value)
    return len(str(value).encode("utf-8"))


class FakeRedisClient:
    def __init__(
        self,
        *,
        values: dict[str, Any] | None = None,
        lists: dict[str, list[Any]] | None = None,
        hashes: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.values = values or {}
        self.lists = lists or {}
        self.hashes = hashes or {}
        self.expirations: dict[str, int] = {}
        self.lset_calls: list[tuple[str, int, Any]] = []
        self.pipeline_commands: list[tuple[Any, ...]] = []
        self.pipeline_execute_count = 0
        self.pipeline_transaction_modes: list[bool] = []
        self.published: list[tuple[str, str]] = []
        self.deleted: list[tuple[str, ...]] = []
        self.get_calls: list[str] = []
        self.mget_calls: list[list[str]] = []

    async def get(self, key: str) -> Any:
        self.get_calls.append(key)
        return self.values.get(key)

    async def mget(self, keys: list[str]) -> list[Any]:
        self.mget_calls.append(list(keys))
        return [self.values.get(key) for key in keys]

    async def set(self, key: str, value: Any, ex: int | None = None) -> bool:
        self.values[key] = value
        if ex is not None:
            self.expirations[key] = ex
        return True

    async def append(self, key: str, value: Any) -> int:
        current = self.values.get(key, "")
        if isinstance(current, bytes):
            suffix = value if isinstance(value, bytes) else str(value).encode("utf-8")
            self.values[key] = current + suffix
        else:
            suffix = value.decode("utf-8") if isinstance(value, bytes) else str(value)
            self.values[key] = str(current) + suffix
        return redis_size(self.values[key])

    async def strlen(self, key: str) -> int:
        value = self.values.get(key)
        return redis_size(value) if value is not None else 0

    async def delete(self, *keys: str) -> int:
        self.deleted.append(tuple(keys))
        deleted = 0
        for key in keys:
            existed = key in self.values or key in self.lists or key in self.hashes
            self.values.pop(key, None)
            self.lists.pop(key, None)
            self.hashes.pop(key, None)
            if existed:
                deleted += 1
        return deleted

    async def rpush(self, key: str, value: Any) -> int:
        self.lists.setdefault(key, []).append(value)
        return len(self.lists[key])

    async def llen(self, key: str) -> int:
        return len(self.lists.get(key, []))

    async def lrange(self, key: str, start: int, end: int) -> list[Any]:
        values = self.lists.get(key, [])
        if end < 0:
            return values[start:]
        return values[start : end + 1]

    async def lset(self, key: str, index: int, value: Any) -> bool:
        self.lset_calls.append((key, index, value))
        self.lists[key][index] = value
        return True

    async def hget(self, key: str, field: str) -> Any:
        return self.hashes.get(key, {}).get(field)

    async def hset(
        self,
        key: str,
        *,
        mapping: dict[str, Any],
    ) -> int:
        target = self.hashes.setdefault(key, {})
        target.update(mapping)
        return len(mapping)

    async def expire(self, key: str, ttl: int) -> bool:
        self.expirations[key] = ttl
        return True

    async def eval(self, script: str, num_keys: int, *keys: str) -> list[int]:
        del script
        return [await self.strlen(key) for key in keys[:num_keys]]

    async def ping(self) -> bool:
        return True

    async def publish(self, channel: str, payload: str) -> None:
        self.published.append((channel, payload))

    def pipeline(self, transaction: bool = True) -> "FakePipeline":
        self.pipeline_transaction_modes.append(transaction)
        return FakePipeline(self)

    async def aclose(self) -> None:
        return None


class FakePipeline:
    def __init__(self, redis_client: FakeRedisClient) -> None:
        self.redis_client = redis_client
        self.commands: list[tuple[Any, ...]] = []
        self.in_multi = False

    async def __aenter__(self) -> "FakePipeline":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def watch(self, *keys: str) -> bool:
        del keys
        return True

    def multi(self) -> None:
        self.in_multi = True

    def _dispatch(self, name: str, *args: Any, **kwargs: Any) -> Any:
        if self.in_multi:
            self.commands.append((name, args, kwargs))
            return self
        return getattr(self.redis_client, name)(*args, **kwargs)

    def get(self, *args: Any) -> Any:
        return self._dispatch("get", *args)

    def mget(self, *args: Any) -> Any:
        return self._dispatch("mget", *args)

    def set(self, *args: Any, **kwargs: Any) -> Any:
        return self._dispatch("set", *args, **kwargs)

    def append(self, *args: Any) -> Any:
        return self._dispatch("append", *args)

    def strlen(self, *args: Any) -> Any:
        return self._dispatch("strlen", *args)

    def delete(self, *args: Any) -> Any:
        return self._dispatch("delete", *args)

    def rpush(self, *args: Any) -> Any:
        return self._dispatch("rpush", *args)

    def llen(self, *args: Any) -> Any:
        return self._dispatch("llen", *args)

    def lrange(self, *args: Any) -> Any:
        return self._dispatch("lrange", *args)

    def lset(self, *args: Any) -> Any:
        return self._dispatch("lset", *args)

    def hget(self, *args: Any) -> Any:
        return self._dispatch("hget", *args)

    def hset(self, *args: Any, **kwargs: Any) -> Any:
        return self._dispatch("hset", *args, **kwargs)

    def expire(self, *args: Any) -> Any:
        return self._dispatch("expire", *args)

    def eval(self, *args: Any) -> Any:
        return self._dispatch("eval", *args)

    def ping(self) -> Any:
        return self._dispatch("ping")

    async def execute(self) -> list[Any]:
        self.redis_client.pipeline_execute_count += 1
        queued = self.commands
        self.commands = []
        self.in_multi = False
        results: list[Any] = []
        for name, args, kwargs in queued:
            self.redis_client.pipeline_commands.append((name, *args))
            results.append(await getattr(self.redis_client, name)(*args, **kwargs))
        return results


class FakeCache:
    def __init__(self, redis_client: FakeRedisClient) -> None:
        self.redis_client = redis_client

    async def _get_client(self) -> FakeRedisClient:
        return self.redis_client


def usage_for(
    blocks: list[Any],
    *,
    content_bytes: int = 0,
) -> dict[str, Any]:
    return {
        "metadata_bytes": sum(redis_size(block) for block in blocks),
        "content_bytes": content_bytes,
    }
