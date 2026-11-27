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

    def delete_knowledge(
        self, *, knowledge_id: str, **kwargs: Any
    ) -> dict[str, Any]: ...

    def drop_knowledge_index(
        self, *, knowledge_id: str, **kwargs: Any
    ) -> dict[str, Any]: ...

    def get_all_chunks(
        self, *, knowledge_id: str, **kwargs: Any
    ) -> list[dict[str, Any]]: ...

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
    deduplicate_by_document: bool = False,
) -> dict[str, Any]:
    """Query authorized spaces, then rank and limit their combined references.

    None is reserved for a caller-authorized whole space. An empty document
    list never enters any engine. Total counts candidates before deduplication
    and the result limit. Document diversity retains the highest-ranked chunk
    per known document within each space; unknown references remain separate.
    """
    if max_results is not None and max_results < 1:
        raise ValueError("max_results must be positive")
    if not isinstance(deduplicate_by_document, bool):
        raise TypeError("deduplicate_by_document must be a boolean")
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
            retrieval_config=(
                _document_candidate_config(target.retrieval_config, max_results)
                if deduplicate_by_document and max_results is not None
                else target.retrieval_config
            ),
            scope=scope,
            query_plan=target.query_plan,
            metadata_condition=metadata_condition,
            user_id=target.user_id,
        )
        records.extend(
            _query_records(
                result,
                target.knowledge_id,
                normalize_document_ids=deduplicate_by_document,
            )
        )
    records.sort(key=lambda record: record.get("score") or 0, reverse=True)
    total = len(records)
    if deduplicate_by_document:
        records = _distinct_document_records(records)
    limited = records if max_results is None else records[:max_results]
    return {
        "records": limited,
        "total": total,
        "total_estimated_tokens": sum(
            len(record.get("content", "")) // 4 for record in limited
        ),
    }


def _document_candidate_config(
    config: RuntimeRetrievalConfig | Mapping[str, Any], max_results: int
) -> RuntimeRetrievalConfig | Mapping[str, Any]:
    """Expand the candidate window without lowering an existing retrieval limit."""
    current_top_k = (
        config.top_k
        if isinstance(config, RuntimeRetrievalConfig)
        else config.get("top_k") or RuntimeRetrievalConfig().top_k
    )
    top_k = max(current_top_k, min(max_results * 4, 200))
    if isinstance(config, RuntimeRetrievalConfig):
        return config.model_copy(update={"top_k": top_k})
    return {**config, "top_k": top_k}


def _distinct_document_records(
    records: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep the first ranked reference for each known document in each space."""
    seen: set[tuple[str, int]] = set()
    distinct = []
    for record in records:
        document_id = record["document_id"]
        if document_id is not None:
            key = (record["knowledge_id"], document_id)
            if key in seen:
                continue
            seen.add(key)
        distinct.append(record)
    return distinct


def _query_records(
    result: Mapping[str, Any],
    knowledge_id: str,
    *,
    normalize_document_ids: bool = False,
) -> list[dict[str, Any]]:
    records = []
    for record in result.get("records", []):
        document_id = None
        if normalize_document_ids:
            document_id = _normalized_document_id(record)
        else:
            reference = (record.get("metadata") or {}).get("doc_ref")
            if isinstance(reference, str):
                try:
                    document_id = int(reference.removeprefix("doc_"))
                except ValueError:
                    pass
        records.append(
            {**record, "knowledge_id": knowledge_id, "document_id": document_id}
        )
    return records


def _normalized_document_id(record: Mapping[str, Any]) -> int | None:
    """Read positive document IDs from direct fields and storage references."""
    metadata = record.get("metadata")
    if not isinstance(metadata, Mapping):
        metadata = {}
    for value in (
        record.get("document_id"),
        metadata.get("document_id"),
        record.get("doc_ref"),
        metadata.get("doc_ref"),
    ):
        if type(value) is int and value > 0:
            return value
        if isinstance(value, str):
            normalized = value.removeprefix("doc_")
            if normalized.isdigit():
                try:
                    parsed = int(normalized)
                except ValueError:
                    continue
                if parsed > 0:
                    return parsed
    return None


async def manage_index(
    adapter: IndexManagementAdapter,
    *,
    operation: Literal["purge", "drop", "list_chunks"],
    knowledge_id: str,
    user_id: int | None = None,
    max_chunks: int = 10000,
    metadata_condition: dict[str, Any] | None = None,
    scope: RetrievalScope | None = None,
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
        scope=scope,
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
