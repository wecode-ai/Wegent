# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo Open IM token and WebSocket client."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlencode

import aiohttp

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

DEFAULT_WS_ENDPOINT = "ws://open-im.api.weibo.com/ws/stream"
DEFAULT_TOKEN_ENDPOINT = "https://open-im.api.weibo.com/open/auth/ws_token"
PING_INTERVAL_SECONDS = 30.0
PONG_TIMEOUT_SECONDS = 10.0
INITIAL_RECONNECT_DELAY_SECONDS = 1.0
MAX_RECONNECT_DELAY_SECONDS = 60.0
TOKEN_EXPIRY_BUFFER_SECONDS = 60
TOKEN_FETCH_MAX_RETRIES = 2
RETRYABLE_TOKEN_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


@dataclass(frozen=True)
class WeiboClientConfig:
    """Configuration for the Weibo Open IM client."""

    channel_id: int
    app_id: str
    app_secret: str
    ws_endpoint: str = DEFAULT_WS_ENDPOINT
    token_endpoint: str = DEFAULT_TOKEN_ENDPOINT


@dataclass
class WeiboToken:
    """Cached Weibo Open IM token."""

    token: str
    expires_in: int
    acquired_at: float
    uid: int

    def is_valid(self) -> bool:
        expires_at = self.acquired_at + self.expires_in - TOKEN_EXPIRY_BUFFER_SECONDS
        return time.time() < expires_at


class WeiboTokenFetchError(Exception):
    """Raised when a Weibo token request fails."""

    def __init__(self, message: str, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


def build_weibo_message_id(*, channel_id: int, task_id: int, subtask_id: int) -> str:
    """Build the stable Weibo message ID for one assistant streaming response."""
    return f"weibo_{channel_id}_{task_id}_{subtask_id}"


class WeiboWebSocketClient:
    """Small aiohttp-based Weibo Open IM WebSocket client."""

    def __init__(
        self,
        *,
        config: WeiboClientConfig,
        cache=cache_manager,
        session_factory: Callable[[], aiohttp.ClientSession] = aiohttp.ClientSession,
        on_message: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
    ):
        self.config = config
        self._cache = cache
        self._session_factory = session_factory
        self._on_message = on_message
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Any = None
        self._task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._running = False
        self._last_pong_at = 0.0
        self._last_error: Optional[str] = None

    @property
    def is_connected(self) -> bool:
        return bool(self._ws is not None and not getattr(self._ws, "closed", True))

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    def _token_cache_key(self) -> str:
        return (
            "weibo:token:"
            f"{self.config.channel_id}:"
            f"{self.config.app_id}:"
            f"{self.config.token_endpoint}"
        )

    async def get_valid_token(self) -> str:
        cached = await self._cache.get(self._token_cache_key())
        if isinstance(cached, dict):
            token = WeiboToken(
                token=str(cached.get("token") or ""),
                expires_in=int(cached.get("expires_in") or 0),
                acquired_at=float(cached.get("acquired_at") or 0),
                uid=int(cached.get("uid") or 0),
            )
            if token.token and token.is_valid():
                return token.token

        token = await self._fetch_token_with_retries()
        await self._cache.set(
            self._token_cache_key(),
            {
                "token": token.token,
                "expires_in": token.expires_in,
                "acquired_at": token.acquired_at,
                "uid": token.uid,
            },
            expire=max(1, token.expires_in),
        )
        return token.token

    async def clear_token_cache(self) -> None:
        await self._cache.delete(self._token_cache_key())

    async def _fetch_token_with_retries(self) -> WeiboToken:
        last_error: Optional[Exception] = None
        for attempt in range(TOKEN_FETCH_MAX_RETRIES + 1):
            try:
                return await self._fetch_token()
            except WeiboTokenFetchError as exc:
                last_error = exc
                if not exc.retryable or attempt >= TOKEN_FETCH_MAX_RETRIES:
                    raise
                await asyncio.sleep(min(2**attempt, 8.0))
        raise WeiboTokenFetchError(str(last_error), retryable=False)

    async def _fetch_token(self) -> WeiboToken:
        session = self._get_session()
        async with session.post(
            self.config.token_endpoint,
            json={"app_id": self.config.app_id, "app_secret": self.config.app_secret},
        ) as response:
            if response.status not in range(200, 300):
                raise WeiboTokenFetchError(
                    f"Failed to fetch token: {response.status}",
                    retryable=response.status in RETRYABLE_TOKEN_STATUS_CODES,
                )
            payload = await response.json()

        data = payload.get("data") if isinstance(payload, dict) else None
        token = data.get("token") if isinstance(data, dict) else None
        if not token:
            raise WeiboTokenFetchError(
                "Invalid token response: missing token",
                retryable=False,
            )
        return WeiboToken(
            token=str(token),
            expires_in=int(data.get("expire_in") or 0),
            acquired_at=time.time(),
            uid=int(data.get("uid") or 0),
        )

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = self._session_factory()
        return self._session

    async def connect_once(self) -> None:
        token = await self.get_valid_token()
        query = urlencode(
            {
                "app_id": self.config.app_id,
                "token": token,
                "version": "wegent-backend",
            }
        )
        separator = "&" if "?" in self.config.ws_endpoint else "?"
        url = f"{self.config.ws_endpoint}{separator}{query}"
        self._ws = await self._get_session().ws_connect(url)
        self._last_pong_at = time.time()

    async def send_ping(self) -> bool:
        return await self.send_json({"type": "ping"})

    def handle_ws_text(self, data: str) -> Optional[dict[str, Any]]:
        if data in {"pong", '{"type":"pong"}'}:
            self._last_pong_at = time.time()
            return None
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            return parsed
        return None

    async def send_json(self, data: dict[str, Any]) -> bool:
        if not self.is_connected:
            return False
        await self._ws.send_str(json.dumps(data, ensure_ascii=False))
        return True

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._run_forever())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _run_forever(self) -> None:
        reconnect_attempt = 0
        while self._running:
            try:
                await self.connect_once()
                reconnect_attempt = 0
                await self._receive_loop()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = str(exc)
                delay = min(
                    INITIAL_RECONNECT_DELAY_SECONDS * (2**reconnect_attempt),
                    MAX_RECONNECT_DELAY_SECONDS,
                )
                reconnect_attempt += 1
                await asyncio.sleep(delay)

    async def _receive_loop(self) -> None:
        if self._ws is None:
            return

        async for message in self._ws:
            data = getattr(message, "data", None)
            if not isinstance(data, str):
                continue
            parsed = self.handle_ws_text(data)
            if parsed is None:
                continue
            if self._on_message:
                await self._on_message(parsed)

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await asyncio.sleep(PING_INTERVAL_SECONDS)
            if not self.is_connected:
                continue
            if time.time() - self._last_pong_at > (
                PING_INTERVAL_SECONDS + PONG_TIMEOUT_SECONDS
            ):
                self._last_error = "Weibo pong timeout"
                await self._ws.close()
                continue
            await self.send_ping()

    async def close(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            await asyncio.gather(self._heartbeat_task, return_exceptions=True)
        if self._ws is not None:
            await self._ws.close()
        if self._session is not None:
            await self._session.close()
        self._ws = None
        self._session = None
        self._task = None
        self._heartbeat_task = None
