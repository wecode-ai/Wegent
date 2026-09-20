# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The LlamaIndex Milvus store the legacy adapter writes through.

It defers ``AsyncMilvusClient`` creation to first use, which the online main
branch shipped so synchronous Milvus calls keep working outside an event loop.
"""

from typing import Any, Dict

from llama_index.vector_stores.milvus import MilvusVectorStore
from pymilvus import AsyncMilvusClient


class LazyAsyncMilvusVectorStore(MilvusVectorStore):
    """
    MilvusVectorStore subclass with lazy AsyncMilvusClient initialization.

    The original MilvusVectorStore creates AsyncMilvusClient in __init__,
    which requires an event loop. This causes issues when running in
    thread pools (e.g., Celery tasks via asyncio.to_thread).

    This subclass defers AsyncMilvusClient creation to first access,
    allowing synchronous operations to work without an event loop.

    See: https://github.com/run-llama/llama_index/issues/20313
    See: https://github.com/run-llama/llama_index/pull/20695
    """

    # Store config for lazy async client creation
    _milvusclient_config: Dict[str, Any] = {}

    def __init__(self, **kwargs: Any) -> None:
        """
        Initialize without creating AsyncMilvusClient.

        Stores connection params for lazy initialization and patches
        the parent class to skip AsyncMilvusClient creation.
        """
        import llama_index.vector_stores.milvus.base as milvus_base

        # Store the original AsyncMilvusClient class
        original_async_client = milvus_base.AsyncMilvusClient

        # Replace AsyncMilvusClient with a dummy that does nothing
        # This prevents the parent __init__ from creating the async client
        milvus_base.AsyncMilvusClient = lambda **kw: None  # type: ignore

        try:
            # Call parent __init__ - it will use our dummy AsyncMilvusClient
            super().__init__(**kwargs)
        finally:
            # Restore the original AsyncMilvusClient
            milvus_base.AsyncMilvusClient = original_async_client

        # Store connection params for lazy async client creation
        # Following the pattern from PR #20695
        uri = kwargs.get("uri", "./milvus_llamaindex.db")
        token = kwargs.get("token", "")
        # Filter out 'alias' as pymilvus sets it internally
        filtered_kwargs = {k: v for k, v in kwargs.items() if k != "alias"}

        self._milvusclient_config = {
            "uri": uri,
            "token": token,
            "kwargs": filtered_kwargs,
        }

        # Set _async_milvusclient to None for lazy initialization
        self._async_milvusclient = None  # type: ignore

    @property
    def aclient(self) -> AsyncMilvusClient:
        """
        Get async client (lazily created on first access).

        This property creates the AsyncMilvusClient only when needed,
        allowing synchronous operations to work without an event loop.
        """
        if self._async_milvusclient is None:
            self._async_milvusclient = AsyncMilvusClient(
                uri=self._milvusclient_config["uri"],
                token=self._milvusclient_config["token"],
                **self._milvusclient_config["kwargs"],
            )
        return self._async_milvusclient
