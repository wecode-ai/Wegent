# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Public query and index management rules over caller-provided execution."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Protocol, Sequence

from shared.knowledge_contracts import RetrievalScope, RuntimeRetrievalConfig


class QueryAdapter(Protocol):
    """Supplies the query engine with its storage and embedding dependencies."""

    async def execute(self, **kwargs: Any) -> dict[str, Any]: ...


class IndexManagementAdapter(Protocol):
    """Supplies synchronous storage operations and chunk text extraction."""

    def delete_knowledge(self, **kwargs: Any) -> dict[str, Any]: ...

    def drop_knowledge_index(self, **kwargs: Any) -> dict[str, Any]: ...

    def get_all_chunks(self, **kwargs: Any) -> list[dict[str, Any]]: ...

    def extract_chunk_text(self, content: Any) -> str: ...


@dataclass(frozen=True)
class QueryTarget:
    """One authorized space and its caller-provided execution dependencies."""

    adapter: QueryAdapter
    knowledge_id: str
    retrieval_config: RuntimeRetrievalConfig | Mapping[str, Any]
    user_id: int | None = None
    document_ids: list[int] | None = None
    query_plan: dict[str, Any] | None = None


async def query_documents(
    targets: Sequence[QueryTarget],
    *,
    query: str,
    metadata_condition: dict[str, Any] | None = None,
    max_results: int | None = None,
) -> dict[str, Any]:
    """Query authorized spaces, then rank and limit their combined references.

    None is reserved for a caller-authorized whole space. An empty document
    list never enters any engine. Total counts matches before the result limit.
    """
    if max_results is not None and max_results < 1:
        raise ValueError("max_results must be positive")
    records: list[dict[str, Any]] = []
    for target in targets:
        if target.document_ids == []:
            continue
        scope = (
            RetrievalScope(document_ids=target.document_ids)
            if target.document_ids is not None
            else None
        )
        result = await target.adapter.execute(
            knowledge_id=target.knowledge_id,
            query=query,
            retrieval_config=target.retrieval_config,
            scope=scope,
            query_plan=target.query_plan,
            metadata_condition=metadata_condition,
            user_id=target.user_id,
        )
        records.extend(_query_records(result, target.knowledge_id))
    records.sort(key=lambda record: record.get("score") or 0, reverse=True)
    limited = records if max_results is None else records[:max_results]
    return {
        "records": limited,
        "total": len(records),
        "total_estimated_tokens": sum(
            len(record.get("content", "")) // 4 for record in limited
        ),
    }


def _query_records(
    result: Mapping[str, Any], knowledge_id: str
) -> list[dict[str, Any]]:
    records = []
    for record in result.get("records", []):
        reference = (record.get("metadata") or {}).get("doc_ref")
        document_id = None
        if isinstance(reference, str):
            try:
                document_id = int(reference.removeprefix("doc_"))
            except ValueError:
                pass
        records.append(
            {**record, "knowledge_id": knowledge_id, "document_id": document_id}
        )
    return records


async def manage_index(
    adapter: IndexManagementAdapter,
    *,
    operation: Literal["purge", "drop", "list_chunks"],
    knowledge_id: str,
    user_id: int | None = None,
    max_chunks: int = 10000,
    metadata_condition: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Manage one authorized index and normalize its public chunk records."""
    if operation == "purge":
        return await asyncio.to_thread(
            adapter.delete_knowledge, knowledge_id=knowledge_id, user_id=user_id
        )
    if operation == "drop":
        return await asyncio.to_thread(
            adapter.drop_knowledge_index, knowledge_id=knowledge_id, user_id=user_id
        )
    if operation != "list_chunks":
        raise ValueError(f"Unsupported index operation: {operation}")
    if not 1 <= max_chunks <= 10000:
        raise ValueError("max_chunks must be between 1 and 10000")
    chunks = await asyncio.to_thread(
        adapter.get_all_chunks,
        knowledge_id=knowledge_id,
        max_chunks=max_chunks,
        metadata_condition=metadata_condition,
        user_id=user_id,
    )
    records = [
        {
            "content": adapter.extract_chunk_text(chunk.get("content", "")),
            "title": chunk.get("title", ""),
            "chunk_id": chunk.get("chunk_id"),
            "doc_ref": chunk.get("doc_ref"),
            "metadata": chunk.get("metadata"),
        }
        for chunk in chunks
    ]
    return {"chunks": records, "total": len(records)}
