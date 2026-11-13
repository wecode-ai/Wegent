# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bound native Milvus upserts after LlamaIndex has serialized complete rows."""

import logging
from typing import Any, Iterator

from pymilvus import MilvusClient
from pymilvus.exceptions import DataNotMatchException, MilvusException

DEFAULT_MAX_BATCH_BYTES = 1024 * 1024
DEFAULT_BATCH_HEADROOM_BYTES = 64 * 1024
logger = logging.getLogger(__name__)


def validate_batch_limits(max_bytes: int, headroom: int, max_rows: int) -> None:
    for name, value, minimum in (
        ("max_batch_bytes", max_bytes, 1),
        ("batch_headroom_bytes", headroom, 0),
        ("batch_size", max_rows, 1),
    ):
        if type(value) is not int or value < minimum:
            raise ValueError(f"Milvus {name} must be an integer >= {minimum}")
    if headroom >= max_bytes:
        raise ValueError(
            "Milvus batch_headroom_bytes must be less than max_batch_bytes"
        )


class MilvusRowTooLargeError(ValueError):
    """One complete row cannot fit; its original content is never truncated."""

    code = "milvus_row_too_large"
    retryable = False

    def __init__(
        self,
        row: dict,
        size: int,
        budget: int,
        *,
        broker_rejected: bool = False,
    ) -> None:
        reason = "broker message-size limit" if broker_rejected else "message budget"
        node_id = row.get("id", row.get("parent_node_id", "unknown"))
        self.details = {
            "node_id": node_id,
            "serialized_bytes": size,
            "effective_budget_bytes": budget,
            "broker_rejected": broker_rejected,
        }
        super().__init__(
            f"Milvus row exceeds {reason}: node_id={node_id} "
            f"serialized_bytes={size} effective_budget_bytes={budget}; "
            "content was not truncated"
        )


class MilvusWriteClient:
    """Bound native row writes while delegating reads and lifecycle operations."""

    def __init__(
        self,
        client: MilvusClient,
        *,
        max_batch_bytes: int,
        batch_headroom_bytes: int,
        max_rows: int,
    ) -> None:
        validate_batch_limits(max_batch_bytes, batch_headroom_bytes, max_rows)
        self._client = client
        self._budget = max_batch_bytes - batch_headroom_bytes
        self._max_rows = max_rows

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)

    def _size(
        self,
        collection: str,
        rows: list[dict],
        options: dict,
        operation: str,
    ) -> int:
        # This is the SDK's actual encoder, using its cached/live collection schema.
        # It performs schema reads only; no insert/upsert RPC is submitted here.
        connection = self._client._get_connection()
        prepare = getattr(connection, f"_prepare_row_{operation}_request")
        try:
            request = prepare(collection, rows, **options)
        except DataNotMatchException:
            # Match the native SDK's stale-schema refresh before encoding again.
            refresh_options = {
                k: v
                for k, v in options.items()
                if k not in {"timeout", "partition_name"}
            }
            connection.update_schema(
                collection, options.get("timeout"), **refresh_options
            )
            request = prepare(collection, rows, **options)
        return request.ByteSize()

    def _batches(
        self,
        collection: str,
        rows: list[dict],
        options: dict,
        operation: str,
    ) -> Iterator[tuple[list[dict], int]]:
        if len(rows) > self._max_rows:
            for start in range(0, len(rows), self._max_rows):
                yield from self._batches(
                    collection, rows[start : start + self._max_rows], options, operation
                )
            return
        size = self._size(collection, rows, options, operation)
        if size <= self._budget:
            yield rows, size
        elif len(rows) == 1:
            raise MilvusRowTooLargeError(rows[0], size, self._budget)
        else:
            logger.info(
                "Milvus %s split: collection=%s rows=%s serialized_bytes=%s budget_bytes=%s",
                operation,
                collection,
                len(rows),
                size,
                self._budget,
            )
            middle = len(rows) // 2
            yield from self._batches(collection, rows[:middle], options, operation)
            yield from self._batches(collection, rows[middle:], options, operation)

    def _write(
        self,
        collection: str,
        rows: list[dict],
        size: int,
        options: dict,
        operation: str,
    ) -> list[dict]:
        try:
            return [
                getattr(self._client, operation)(
                    collection_name=collection, data=rows, **options
                )
            ]
        except MilvusException as error:
            if "message size too large" not in error.message.lower():
                raise
            if len(rows) == 1:
                raise MilvusRowTooLargeError(
                    rows[0], size, self._budget, broker_rejected=True
                ) from error
            if operation == "insert":
                # Auto-generated primary keys cannot safely replay an ambiguous insert.
                # The caller's existing document replacement handles a later retry.
                raise
            logger.warning(
                "Milvus broker rejected batch: collection=%s rows=%s serialized_bytes=%s; splitting with unchanged IDs",
                collection,
                len(rows),
                size,
            )
            # The broker's actual limit can be lower than our configured budget.
            # Reuse exactly the same rows and primary keys when shrinking a batch.
            middle = len(rows) // 2
            results = []
            for part in (rows[:middle], rows[middle:]):
                size = self._size(collection, part, options, operation)
                results.extend(self._write(collection, part, size, options, operation))
            return results

    def upsert(
        self,
        collection_name: str,
        data: dict | list[dict],
        timeout: float | None = None,
        partition_name: str | None = "",
        **kwargs: Any,
    ) -> dict:
        options = {**kwargs, "timeout": timeout, "partition_name": partition_name}
        return self._mutate("upsert", collection_name, data, options)

    def insert(
        self,
        collection_name: str,
        data: dict | list[dict],
        timeout: float | None = None,
        partition_name: str | None = "",
        **kwargs: Any,
    ) -> dict:
        options = {**kwargs, "timeout": timeout, "partition_name": partition_name}
        return self._mutate("insert", collection_name, data, options)

    def validate_insert_rows(self, collection: str, rows: list[dict]) -> None:
        """Check replacement rows before the caller deletes the previous parent set."""
        if rows:
            list(self._batches(collection, rows, {}, "insert"))

    def _mutate(
        self,
        operation: str,
        collection_name: str,
        data: dict | list[dict],
        options: dict,
    ) -> dict:
        rows = [data] if isinstance(data, dict) else data
        if not rows:
            return {f"{operation}_count": 0, "ids": []}
        # Validate all rows in this SDK batch before sending any of its sub-batches.
        batches = list(self._batches(collection_name, rows, options, operation))
        results = [
            result
            for batch, size in batches
            for result in self._write(collection_name, batch, size, options, operation)
        ]
        result = {
            f"{operation}_count": sum(
                result.get(f"{operation}_count", 0) for result in results
            ),
            "ids": [key for result in results for key in result.get("ids", [])],
        }
        if any("cost" in item for item in results):
            result["cost"] = sum(item.get("cost", 0) for item in results)
        return result
