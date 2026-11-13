# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded, content-free quality facts from already completed knowledge work."""

from __future__ import annotations

from dataclasses import dataclass, field
from uuid import uuid4

from ...reporter import (
    get_event_observation_limit,
    is_event_reporting_enabled,
)
from ._common import loaded_scalar, observe

_RETRIEVAL_RESULT_EVENT = "knowledge.retrieval.result.observed"
_RETRIEVAL_CONTEXT_EVENT = "knowledge.retrieval.context.recorded"


def new_quality_execution_id(event_type: str) -> str | None:
    """Create correlation only when the optional event group is admissible."""
    try:
        return str(uuid4()) if is_event_reporting_enabled(event_type) else None
    except Exception:
        return None


@dataclass
class RetrievalResultObserver:
    """Capture bounded scalar identities during the existing result loop."""

    returned_count: int
    execution_id: str | None
    limit: int
    _details: list[tuple[int, object, object, object]] = field(default_factory=list)

    @classmethod
    def start(cls, returned_count: int) -> RetrievalResultObserver:
        limit = get_event_observation_limit(_RETRIEVAL_RESULT_EVENT)
        execution_id = (
            new_quality_execution_id(_RETRIEVAL_RESULT_EVENT) if limit > 0 else None
        )
        return cls(returned_count, execution_id, limit)

    def capture(self, record: object, rank: int) -> None:
        if self.execution_id is None or len(self._details) >= self.limit:
            return
        self._details.append(
            (
                rank,
                loaded_scalar(record, "knowledge_base_id"),
                loaded_scalar(record, "document_id"),
                loaded_scalar(record, "score"),
            )
        )

    def flush(self) -> None:
        """Emit only after the complete response has been built successfully."""
        if self.execution_id is None:
            return
        for rank, kb_id, document_id, score in self._details:
            observe(
                _RETRIEVAL_RESULT_EVENT,
                lambda rank=rank, kb_id=kb_id, document_id=document_id, score=score: {
                    "kb_id": kb_id,
                    "document_id": document_id,
                    "status": "success",
                    "fact_key_parts": (self.execution_id, rank),
                    "data": {
                        "execution_id": self.execution_id,
                        "rank": rank,
                        "score": score,
                        "returned_count": self.returned_count,
                        "stage": "final_result",
                    },
                },
            )


def report_retrieval_context(
    *,
    execution_id: str | None,
    context_id: int | str | None,
    subtask_id: int,
    kb_id: int,
    operation: str,
    injection_mode: str,
    chunk_count: int,
    restricted_mode: bool,
) -> None:
    """Report a context only after its create or update transaction committed."""
    if execution_id is None or context_id is None:
        return
    observe(
        _RETRIEVAL_CONTEXT_EVENT,
        lambda: {
            "kb_id": kb_id,
            "status": "success",
            "fact_key_parts": (execution_id, kb_id, context_id),
            "data": {
                "execution_id": execution_id,
                "context_id": context_id,
                "subtask_id": subtask_id,
                "operation": operation,
                "injection_mode": injection_mode,
                "chunk_count": chunk_count,
                "restricted_mode": restricted_mode,
                "stage": "persisted",
            },
        },
    )
