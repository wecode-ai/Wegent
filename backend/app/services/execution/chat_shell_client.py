# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Own Chat Shell connections and retry only failures before sending a request."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import socket
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

import httpx

from shared.telemetry.decorators import add_span_event, trace_async
from shared.utils.sensitive_data_masker import mask_string

if TYPE_CHECKING:
    from openai import AsyncOpenAI, AsyncStream

logger = logging.getLogger(__name__)

_MAX_CONNECT_ATTEMPTS = 3
_TIMEOUT = httpx.Timeout(300.0, connect=5.0, write=30.0, pool=5.0)
# Retire idle connections before Chat Shell's default 5s server timeout.
_LIMITS = httpx.Limits(
    max_connections=1000, max_keepalive_connections=100, keepalive_expiry=2.0
)


def _build_client(base_url: str) -> AsyncOpenAI:
    # Keep the SDK lazy, as most dispatch modes do not need it.
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        base_url=base_url,
        api_key="dummy",
        timeout=_TIMEOUT,
        # SDK retries include ambiguous read/write failures and HTTP errors.
        # Our connect-only policy below must be the only retry layer.
        max_retries=0,
        http_client=httpx.AsyncClient(
            timeout=_TIMEOUT, limits=_LIMITS, trust_env=False
        ),
    )


class ChatShellClientPool:
    """Reuse clients on the application loop; isolate short-lived worker loops."""

    def __init__(self) -> None:
        self._owner_loop: asyncio.AbstractEventLoop | None = None
        self._owner_pid: int | None = None
        self._clients: dict[str, AsyncOpenAI] = {}

    @asynccontextmanager
    async def lifespan(self) -> AsyncIterator[None]:
        """Keep connections alive until all application dispatchers have drained."""
        if self._owner_loop is not None:
            raise RuntimeError("Chat Shell clients already have a lifespan owner")
        self._owner_loop = asyncio.get_running_loop()
        self._owner_pid = os.getpid()
        try:
            yield
        finally:
            clients = list(self._clients.values())
            self._clients.clear()
            self._owner_loop = None
            self._owner_pid = None
            results = await asyncio.gather(
                *(client.close() for client in clients), return_exceptions=True
            )
            for result in results:
                if isinstance(result, BaseException):
                    raise result

    @asynccontextmanager
    async def client(self, target_url: str) -> AsyncIterator[AsyncOpenAI]:
        """Borrow an owner client, or close a worker-owned client on every exit."""
        base_url = f"{target_url.rstrip('/')}/v1"
        if (
            self._owner_loop is asyncio.get_running_loop()
            and self._owner_pid == os.getpid()
        ):
            if base_url not in self._clients:
                self._clients[base_url] = _build_client(base_url)
            yield self._clients[base_url]
        else:
            # Celery and sync bridges use temporary event loops. Connections
            # cannot be shared across those loops or inherited after a fork.
            client = _build_client(base_url)
            try:
                yield client
            finally:
                await client.close()


def _exception_chain(error: BaseException | None) -> list[dict[str, str]]:
    """Retain SDK/httpx/OS causes without serializing requests or credentials."""
    chain: list[dict[str, str]] = []
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        chain.append(
            {
                "exception_type": type(error).__name__,
                "exception_repr": mask_string(repr(error))[:1000],
            }
        )
        error = error.__cause__ or (
            None if error.__suppress_context__ else error.__context__
        )
    return chain


def _safe_target_url(url: str) -> str:
    return str(httpx.URL(url).copy_with(username=None, password=None, query=None))


def _peer_address(stream: AsyncStream[Any]) -> Any:
    """Read the actual peer from the connection, rather than doing another DNS lookup."""
    response = getattr(stream, "response", None)
    network_stream = response.extensions.get("network_stream") if response else None
    return network_stream.get_extra_info("server_addr") if network_stream else None


def log_transport_event(
    event: str,
    *,
    task_id: int,
    subtask_id: int,
    request_id: str,
    target_url: str,
    level: int = logging.INFO,
    error: BaseException | None = None,
    **details: Any,
) -> None:
    fields = {
        "event": event,
        "error_hop": "backend_to_chat_shell",
        "task_id": task_id,
        "subtask_id": subtask_id,
        "request_id": request_id,
        "caller_pod": os.environ.get("HOSTNAME") or socket.gethostname(),
        "caller_pid": os.getpid(),
        "target_url": _safe_target_url(target_url),
        **details,
    }
    if error is not None:
        fields["exception_chain"] = _exception_chain(error)
    logger.log(level, "[ChatShellTransport] %s", json.dumps(fields))
    add_span_event(f"chat_shell.{event}", {"details": json.dumps(fields)})


@trace_async(span_name="chat_shell.open_stream", tracer_name="backend.execution")
async def open_chat_shell_stream(
    client: AsyncOpenAI,
    *,
    task_id: int,
    subtask_id: int,
    request_id: str,
    **request_args: Any,
) -> AsyncStream[Any]:
    """Retry connect errors only; never replay a POST that may have been received."""
    from openai import APIConnectionError

    context = {
        "task_id": task_id,
        "subtask_id": subtask_id,
        "request_id": request_id,
        "target_url": str(client.base_url) + "responses",
    }
    started = time.monotonic()
    attempt = 1
    while True:
        attempt_started = time.monotonic()
        log_transport_event("connect_attempt", **context, attempt=attempt)
        try:
            stream = await client.responses.create(**request_args)
        except asyncio.CancelledError:
            log_transport_event(
                "connect_cancelled",
                **context,
                attempt=attempt,
                elapsed_ms=(time.monotonic() - started) * 1000,
            )
            raise
        except Exception as error:
            # An absent SSE event does not prove the POST was not processed.
            # Only connection establishment failures are safe to replay.
            retry = (
                isinstance(error, APIConnectionError)
                and isinstance(
                    error.__cause__, (httpx.ConnectError, httpx.ConnectTimeout)
                )
                and attempt < _MAX_CONNECT_ATTEMPTS
            )
            delay = random.uniform(0.0, 0.5 * 2 ** (attempt - 1)) if retry else 0.0
            log_transport_event(
                "connect_failed",
                **context,
                level=logging.WARNING if retry else logging.ERROR,
                error=error,
                attempt=attempt,
                attempt_elapsed_ms=(time.monotonic() - attempt_started) * 1000,
                elapsed_ms=(time.monotonic() - started) * 1000,
                retry=retry,
                retry_delay_seconds=delay,
                peer_address=None,
            )
            if not retry:
                raise
            await asyncio.sleep(delay)
            attempt += 1
        else:
            log_transport_event(
                "stream_opened",
                **context,
                attempt=attempt,
                elapsed_ms=(time.monotonic() - started) * 1000,
                peer_address=_peer_address(stream),
            )
            return stream


chat_shell_clients = ChatShellClientPool()
