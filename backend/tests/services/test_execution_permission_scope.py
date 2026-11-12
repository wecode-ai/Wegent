# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution scopes cannot change concurrent discovery authorization."""

import asyncio

import pytest

from app.services.execution_permission_scope import (
    execution_resource_scope,
    is_execution_resource_scope,
)


@pytest.mark.asyncio
async def test_execution_scope_does_not_leak_into_concurrent_discovery():
    entered = asyncio.Event()
    discovered = asyncio.Event()

    async def execution():
        with execution_resource_scope():
            entered.set()
            await discovered.wait()
            assert is_execution_resource_scope()
        assert not is_execution_resource_scope()

    async def discovery():
        await entered.wait()
        assert not is_execution_resource_scope()
        discovered.set()

    await asyncio.gather(execution(), discovery())


def test_nested_execution_failures_restore_the_original_scope():
    @execution_resource_scope()
    def failing_execution():
        assert is_execution_resource_scope()
        raise ValueError("execution failed")

    with execution_resource_scope():
        with pytest.raises(ValueError, match="execution failed"):
            failing_execution()
        assert is_execution_resource_scope()
    assert not is_execution_resource_scope()
