# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Capacity-bounded executors for synchronous non-database responsibilities."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any, TypeVar

from app.core.bounded_executor import BoundedExecutor

T = TypeVar("T")

_repository_io_executor = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-repository-io",
)
_knowledge_io_executor = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-knowledge-io",
)
_device_io_executor = BoundedExecutor(
    max_workers=2,
    max_in_flight=4,
    thread_name_prefix="wegent-device-io",
)
_mcp_tool_executor = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-mcp-tool",
)
_execution_io_executor = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-execution-io",
)
_rate_limit_io_executor = BoundedExecutor(
    max_workers=2,
    max_in_flight=8,
    thread_name_prefix="wegent-rate-limit-io",
)
_metadata_io_executor = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-metadata-io",
)


async def _run(
    executor: BoundedExecutor,
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    return await executor.run(partial(func, *args, **kwargs))


async def run_repository_io(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run synchronous Git-provider network I/O with bounded admission."""
    return await _run(_repository_io_executor, func, *args, **kwargs)


async def run_knowledge_io(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run synchronous knowledge storage or upstream validation work."""
    return await _run(_knowledge_io_executor, func, *args, **kwargs)


async def run_device_io(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run synchronous device-control network I/O with bounded admission."""
    return await _run(_device_io_executor, func, *args, **kwargs)


async def run_mcp_tool(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run a synchronous MCP tool without using asyncio's default executor."""
    return await _run(_mcp_tool_executor, func, *args, **kwargs)


async def run_execution_io(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run synchronous execution persistence and broker side effects."""
    return await _run(_execution_io_executor, func, *args, **kwargs)


async def run_rate_limit_io(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run synchronous rate-limit storage checks with isolated capacity."""
    return await _run(_rate_limit_io_executor, func, *args, **kwargs)


async def run_metadata_io(
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Run synchronous URL metadata DNS, cache, and parsing work."""
    return await _run(_metadata_io_executor, func, *args, **kwargs)
