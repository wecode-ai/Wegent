# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""A Runtime deadline remains an internal failure, never an external SDK verdict."""

import asyncio
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")
CLEANUP_TIMEOUT_SECONDS = 25.0


def cleanup_deadline(operation: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
    @wraps(operation)
    async def bounded(*args: P.args, **kwargs: P.kwargs) -> T:
        return await asyncio.wait_for(
            operation(*args, **kwargs), timeout=CLEANUP_TIMEOUT_SECONDS
        )

    return bounded
