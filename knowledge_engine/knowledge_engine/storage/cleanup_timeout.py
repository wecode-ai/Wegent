# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bound the public Milvus RPCs used by index cleanup without closing shared aliases."""

from typing import Any


class CleanupTimeoutClient:
    """Supply a finite timeout even when an upstream wrapper passes None."""

    RPC_METHODS = frozenset(
        {
            "has_collection",
            "describe_collection",
            "list_collections",
            "query",
            "delete",
            "load_collection",
            "drop_collection",
        }
    )

    def __init__(self, client: Any, timeout: float) -> None:
        self._client = client
        self._timeout = timeout

    def __getattr__(self, name: str) -> Any:
        method = getattr(self._client, name)
        if name not in self.RPC_METHODS:
            return method

        def bounded(*args: Any, **kwargs: Any) -> Any:
            requested = kwargs.get("timeout")
            kwargs["timeout"] = (
                min(requested, self._timeout) if requested else self._timeout
            )
            return method(*args, **kwargs)

        return bounded
