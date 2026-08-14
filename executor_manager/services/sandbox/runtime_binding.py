# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bind a prepared sandbox runtime to its manager heartbeat identity."""

import asyncio
import os
from typing import Optional

import httpx

from shared.logger import setup_logger
from shared.utils.http_client import traced_async_client

logger = setup_logger(__name__)

RUNTIME_BIND_TIMEOUT = float(os.getenv("SANDBOX_RUNTIME_BIND_TIMEOUT", "3"))
RUNTIME_BIND_RETRIES = int(os.getenv("SANDBOX_RUNTIME_BIND_RETRIES", "2"))
RUNTIME_BIND_RETRY_INTERVAL = float(
    os.getenv("SANDBOX_RUNTIME_BIND_RETRY_INTERVAL", "0.5")
)


class SandboxRuntimeBindingError(RuntimeError):
    """Raised when a sandbox runtime cannot activate its heartbeat."""


class SandboxRuntimeBinder:
    """Activate the optional heartbeat of a newly prepared runtime."""

    async def bind(self, base_url: str, sandbox_id: str) -> None:
        """Ask a runtime to start its optional sandbox heartbeat."""
        endpoint = f"{base_url.rstrip('/')}/v1/runtime/bind"
        await self._request_bind(endpoint, sandbox_id)

    async def _request_bind(self, endpoint: str, sandbox_id: str) -> None:
        last_error = "runtime bind request failed"
        for attempt in range(1, RUNTIME_BIND_RETRIES + 1):
            try:
                async with traced_async_client(timeout=RUNTIME_BIND_TIMEOUT) as client:
                    response = await client.post(
                        endpoint,
                        json={
                            "heartbeat_id": sandbox_id,
                            "heartbeat_type": "sandbox",
                        },
                    )
                if response.status_code == 200:
                    logger.info(
                        "[SandboxRuntimeBinder] Runtime heartbeat activated "
                        "sandbox_id=%s",
                        sandbox_id,
                    )
                    return
                last_error = f"HTTP {response.status_code}; body={response.text[:300]}"
                if response.status_code < 500:
                    break
            except httpx.HTTPError as exc:
                last_error = str(exc)

            if attempt < RUNTIME_BIND_RETRIES:
                await asyncio.sleep(RUNTIME_BIND_RETRY_INTERVAL)

        raise SandboxRuntimeBindingError(
            f"Failed to bind sandbox runtime heartbeat: {last_error}"
        )


_runtime_binder: Optional[SandboxRuntimeBinder] = None


def get_sandbox_runtime_binder() -> SandboxRuntimeBinder:
    """Return the process-wide runtime binder."""
    global _runtime_binder
    if _runtime_binder is None:
        _runtime_binder = SandboxRuntimeBinder()
    return _runtime_binder
