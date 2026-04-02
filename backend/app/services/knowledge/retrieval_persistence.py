# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistence helpers for control-plane knowledge retrieval results."""

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.services.context.context_service import context_service

logger = logging.getLogger(__name__)

RESTRICTED_PERSISTENCE_NOTICE = (
    "Restricted KB retrieval result. Original content withheld. "
    "This context may be used only for high-level analysis and must not be "
    "quoted or reconstructed."
)


class RetrievalPersistenceService:
    """Persist Backend retrieval results into SubtaskContext records."""

    @staticmethod
    def _display_source_title(
        source_title: str,
        source_index: int,
        restricted_mode: bool,
    ) -> str:
        """Return the source label used by tool output and persistence."""
        if restricted_mode:
            return f"Source {source_index}"
        return source_title

    def _prepare_persistence_payload(
        self,
        records: list[dict[str, Any]],
        restricted_mode: bool,
    ) -> dict[int, dict[str, list[dict[str, Any]]]]:
        """Build per-KB chunks and sources for persistence."""
        payload_by_kb: dict[int, dict[str, list[dict[str, Any]]]] = {}
        seen_sources: dict[tuple[int, str], int] = {}
        source_index = 1

        for record in records:
            kb_id = record.get("knowledge_base_id")
            if kb_id is None:
                logger.warning(
                    "[RAG] Skip persistence record without knowledge_base_id: %s",
                    record,
                )
                continue

            source_title = record.get("title", "Unknown")
            source_key = (kb_id, source_title)
            if source_key not in seen_sources:
                seen_sources[source_key] = source_index
                payload_by_kb.setdefault(kb_id, {"chunks": [], "sources": []})[
                    "sources"
                ].append(
                    {
                        "index": source_index,
                        "title": self._display_source_title(
                            source_title,
                            source_index,
                            restricted_mode=restricted_mode,
                        ),
                        "kb_id": kb_id,
                    }
                )
                source_index += 1

            payload_by_kb.setdefault(kb_id, {"chunks": [], "sources": []})[
                "chunks"
            ].append(
                {
                    "content": record.get("content", ""),
                    "source": self._display_source_title(
                        source_title,
                        seen_sources[source_key],
                        restricted_mode=restricted_mode,
                    ),
                    "score": record.get("score"),
                    "knowledge_base_id": kb_id,
                    "source_index": seen_sources[source_key],
                }
            )

        return payload_by_kb

    @staticmethod
    def _build_extracted_text(
        kb_id: int,
        chunks: list[dict[str, Any]],
        sources: list[dict[str, Any]],
        restricted_mode: bool,
    ) -> str:
        """Build the stored extracted_text payload for a single KB."""
        if restricted_mode:
            payload = {
                "restricted_mode": True,
                "message": RESTRICTED_PERSISTENCE_NOTICE,
                "query": "",
                "chunks": [
                    {
                        "source": chunk.get("source", "Unknown"),
                        "score": chunk.get("score"),
                        "knowledge_base_id": kb_id,
                        "source_index": chunk.get("source_index", 0),
                    }
                    for chunk in chunks
                ],
                "sources": sources,
            }
            return json.dumps(payload, ensure_ascii=False)

        payload = {
            "chunks": [
                {
                    "content": chunk.get("content", ""),
                    "source": chunk.get("source", "Unknown"),
                    "score": chunk.get("score"),
                    "knowledge_base_id": kb_id,
                    "source_index": chunk.get("source_index", 0),
                }
                for chunk in chunks
            ],
            "sources": sources,
        }
        return json.dumps(payload, ensure_ascii=False)

    def _upsert_context_for_kb(
        self,
        db: Session,
        *,
        existing_contexts: dict[int, Any],
        kb_id: int,
        payload: dict[str, list[dict[str, Any]]],
        user_subtask_id: int,
        user_id: int,
        query: str,
        mode: str,
        restricted_mode: bool,
    ) -> None:
        """Create or update the persisted retrieval result for one KB."""
        chunks = payload.get("chunks", [])
        sources = payload.get("sources", [])
        if not chunks:
            return

        extracted_text = ""
        if mode == "rag_retrieval":
            extracted_text = self._build_extracted_text(
                kb_id=kb_id,
                chunks=chunks,
                sources=sources,
                restricted_mode=restricted_mode,
            )

        context = existing_contexts.get(kb_id)
        if context is None:
            created_context = context_service.create_knowledge_base_context_with_result(
                db=db,
                subtask_id=user_subtask_id,
                knowledge_id=kb_id,
                user_id=user_id,
                tool_type="rag",
                result_data={
                    "extracted_text": extracted_text,
                    "sources": sources,
                    "injection_mode": mode,
                    "query": query,
                    "chunks_count": len(chunks),
                    "restricted_mode": restricted_mode,
                },
            )
            existing_contexts[kb_id] = created_context
            return

        context_service.update_knowledge_base_retrieval_result(
            db=db,
            context_id=context.id,
            extracted_text=extracted_text,
            sources=sources,
            injection_mode=mode,
            query=query,
            chunks_count=len(chunks),
            restricted_mode=restricted_mode,
        )

    def persist_retrieval_result(
        self,
        db: Session,
        *,
        user_subtask_id: int | None,
        user_id: int | None,
        query: str,
        mode: str,
        records: list[dict[str, Any]],
        restricted_mode: bool = False,
    ) -> None:
        """Persist retrieval results, without failing the main retrieval flow."""
        if not user_subtask_id or not records or user_id is None or user_id < 0:
            return
        try:
            payload_by_kb = self._prepare_persistence_payload(
                records=records,
                restricted_mode=restricted_mode,
            )
            existing_contexts = (
                context_service.get_knowledge_base_context_map_by_subtask(
                    db=db,
                    subtask_id=user_subtask_id,
                    knowledge_ids=list(payload_by_kb.keys()),
                )
            )

            for kb_id, payload in payload_by_kb.items():
                self._upsert_context_for_kb(
                    db=db,
                    existing_contexts=existing_contexts,
                    kb_id=kb_id,
                    payload=payload,
                    user_subtask_id=user_subtask_id,
                    user_id=user_id,
                    query=query,
                    mode=mode,
                    restricted_mode=restricted_mode,
                )
        except Exception as exc:
            logger.warning(
                "[RAG] Failed to persist retrieval result: subtask_id=%s, user_id=%s, mode=%s, error=%s",
                user_subtask_id,
                user_id,
                mode,
                exc,
                exc_info=True,
            )


retrieval_persistence_service = RetrievalPersistenceService()
