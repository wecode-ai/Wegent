# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prevent the Web LLM proxy from regressing to an unbounded raw relay."""

from __future__ import annotations

import ast
from pathlib import Path

MODULE_PATH = Path(__file__).parents[2] / "app" / "services" / "llm_proxy_service.py"


def _function_source(name: str) -> str:
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"), filename=str(MODULE_PATH))
    function = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    )
    return ast.unparse(function)


def test_proxy_endpoint_delegates_raw_transport_to_bounded_relay() -> None:
    source = _function_source("proxy_llm_responses")

    assert "BoundedRawProxyRelay.open" in source
    assert "BoundedRawProxyResponse" in source
    assert "aiter_raw" not in source


def test_raw_relay_shares_global_web_stream_connection_and_byte_budgets() -> None:
    source = _function_source("open")

    assert "web_stream_rpc_admission" in source
    assert "web_stream_relay_byte_admission" in source
    assert "stream_admission.acquire()" in source
    assert "stream_admission.release()" in source


def test_raw_relay_reserves_fixed_bytes_before_read_and_holds_across_yield() -> None:
    source = _function_source("stream")

    acquire_index = source.index("_acquire_chunk_lease")
    read_index = source.index("_next_chunk")
    yield_index = source.index("yield chunk")
    release_index = source.index("await lease.release()", yield_index)
    assert acquire_index < read_index < yield_index < release_index
    assert "chunk_size=self._limits.max_chunk_bytes" in source
    assert "total_bytes > self._limits.max_response_bytes" in source


def test_raw_relay_has_first_byte_idle_and_absolute_duration_bounds() -> None:
    module_source = MODULE_PATH.read_text(encoding="utf-8")

    for required in (
        "LLM_PROXY_FIRST_BYTE_TIMEOUT_SECONDS",
        "LLM_PROXY_IDLE_TIMEOUT_SECONDS",
        "LLM_PROXY_MAX_DURATION_SECONDS",
        "llm_proxy_first_byte_timeout",
        "llm_proxy_idle_timeout",
        "llm_proxy_duration_exceeded",
    ):
        assert required in module_source

    response_source = _function_source("__call__")
    assert "asyncio.timeout(self._relay.remaining_duration_seconds)" in response_source
    assert "await close_iterator()" in response_source
    assert "await self._relay.aclose()" in response_source
