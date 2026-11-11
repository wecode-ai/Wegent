# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Expose execution resource scopes to distribution-owned entity adapters."""

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

_execution_resources: ContextVar[bool] = ContextVar(
    "execution_resource_scope", default=False
)


def is_execution_resource_scope() -> bool:
    """Whether this operation resolves resources for execution."""
    return _execution_resources.get()


@contextmanager
def execution_resource_scope() -> Iterator[None]:
    """Mark execution resource reads without changing other resource operations."""
    token = _execution_resources.set(True)
    try:
        yield
    finally:
        _execution_resources.reset(token)
