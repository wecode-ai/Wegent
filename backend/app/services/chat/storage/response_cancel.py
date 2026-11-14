# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Coordinate committed Responses cancellation with concurrent stream cleanup."""

import logging
import uuid

from app.core.cache import RedisCache
from shared.telemetry.decorators import trace_async, trace_sync

logger = logging.getLogger(__name__)

CANCEL_INTENT_KEY_PREFIX = "chat:cancel-intent:"
CANCEL_KEY_PREFIX = "chat:cancel:"
CANCEL_FLAG_TTL = 300
REGISTER_SCRIPT = """
if redis.call('EXISTS', KEYS[2]) == 0 then
    return redis.call('DEL', KEYS[1])
end
return 0
"""
FINALIZE_SCRIPT = """
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], 'true', 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
"""
ABORT_SCRIPT = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
"""


class ResponseCancelCoordinator:
    """The intent is non-notifying until its database transaction commits."""

    def __init__(self, cache: RedisCache) -> None:
        self._cache = cache

    @staticmethod
    def _keys(subtask_id: int) -> tuple[str, str]:
        return (
            f"{CANCEL_KEY_PREFIX}{subtask_id}",
            f"{CANCEL_INTENT_KEY_PREFIX}{subtask_id}",
        )

    @trace_sync("response_cancel.prepare", "backend.chat")
    def prepare(self, subtask_id: int) -> str | None:
        token = uuid.uuid4().hex
        try:
            client = self._cache._get_sync_client()
            try:
                # Never yield while the caller holds synchronous SQL row locks.
                # No expiry bounds an in-flight transaction or active stream.
                if not client.set(self._keys(subtask_id)[1], token):
                    raise RuntimeError("Redis did not acknowledge cancellation intent")
            except BaseException:
                try:
                    client.eval(ABORT_SCRIPT, 1, self._keys(subtask_id)[1], token)
                except Exception:
                    logger.exception(
                        "Failed to abort response cancel for %s", subtask_id
                    )
                raise
            return token
        except Exception:
            logger.exception("Failed to prepare response cancel for %s", subtask_id)
            return None

    @trace_async("response_cancel.finalize", "backend.chat")
    async def finalize(self, subtask_id: int, token: str) -> bool:
        try:
            async with self._cache._client_context() as client:
                return bool(
                    await client.eval(
                        FINALIZE_SCRIPT,
                        2,
                        *self._keys(subtask_id),
                        token,
                        CANCEL_FLAG_TTL,
                    )
                )
        except Exception:
            logger.exception("Failed to finalize response cancel for %s", subtask_id)
            return False

    @trace_async("response_cancel.abort", "backend.chat")
    async def abort(self, subtask_id: int, token: str) -> None:
        try:
            async with self._cache._client_context() as client:
                await client.eval(ABORT_SCRIPT, 1, self._keys(subtask_id)[1], token)
        except Exception:
            logger.exception("Failed to abort response cancel for %s", subtask_id)

    async def register(self, subtask_id: int) -> None:
        try:
            async with self._cache._client_context() as client:
                await client.eval(REGISTER_SCRIPT, 2, *self._keys(subtask_id))
        except Exception:
            logger.exception("Failed to register response cancel for %s", subtask_id)

    async def unregister(self, subtask_id: int) -> None:
        try:
            async with self._cache._client_context() as client:
                await client.delete(*self._keys(subtask_id))
        except Exception:
            logger.exception("Failed to unregister response cancel for %s", subtask_id)
