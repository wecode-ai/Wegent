# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistence helpers for control-plane knowledge retrieval results."""

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.schemas.external_knowledge import (
    ExternalKnowledgeRef,
    external_ref_canonical_key,
)
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

    @staticmethod
    def _record_value(record: Any, key: str, default: Any = None) -> Any:
        """Read a retrieval record field from dict or Pydantic-like records."""
        if isinstance(record, dict):
            return record.get(key, default)
        return getattr(record, key, default)

    @staticmethod
    def _ref_to_dict(ref: ExternalKnowledgeRef | dict[str, Any]) -> dict[str, Any]:
        """Normalize external ref data for JSON persistence."""
        if isinstance(ref, ExternalKnowledgeRef):
            return ref.model_dump(exclude_none=True)
        return {key: value for key, value in ref.items() if value is not None}

    @staticmethod
    def _external_ref_key(ref: dict[str, Any]) -> tuple[Any, ...]:
        """Build a stable key for one external source selection.

        The shape matches external_ref_canonical_key so that refs with the same
        canonical key map to the same persistence slot. target_type defaults to
        'knowledge_base' to stay consistent with the canonical key formatter.
        """
        return (
            ref.get("provider"),
            ref.get("mode"),
            ref.get("id"),
            ref.get("target_type") or "knowledge_base",
            ref.get("workspace_id"),
            ref.get("node_id"),
            ref.get("document_id"),
        )

    def _find_ref_for_external_record(
        self,
        record: Any,
        refs: list[ExternalKnowledgeRef | dict[str, Any]],
    ) -> dict[str, Any]:
        """Return the selected ref that best matches an external record."""
        provider = self._record_value(record, "source_type")
        source_id = self._record_value(record, "source_id")
        document_id = self._record_value(record, "document_id")
        metadata = self._record_value(record, "metadata") or {}
        record_canonical_key = (
            metadata.get("canonical_ref_key") if isinstance(metadata, dict) else None
        )
        if document_id is None and isinstance(metadata, dict):
            document_id = metadata.get("document_id") or metadata.get("node_id")

        normalized_refs = [self._ref_to_dict(ref) for ref in refs]
        for ref in normalized_refs:
            if record_canonical_key:
                if external_ref_canonical_key(ref) == record_canonical_key:
                    return ref
                continue
            if (
                ref.get("provider") == provider
                and ref.get("id") == source_id
                and (
                    not ref.get("document_id")
                    or str(ref.get("document_id")) == str(document_id)
                )
            ):
                return ref

        source_name = self._record_value(record, "source_name") or source_id or provider
        fallback = {
            "provider": provider,
            "mode": "explicit",
            "id": source_id,
            "name": source_name,
        }
        return {key: value for key, value in fallback.items() if value is not None}

    def _prepare_external_persistence_payload(
        self,
        *,
        records: list[Any],
        refs: list[ExternalKnowledgeRef | dict[str, Any]],
    ) -> dict[tuple[Any, ...], dict[str, Any]]:
        """Build chunks and sources grouped by external source ref."""
        payload_by_ref: dict[tuple[Any, ...], dict[str, Any]] = {}
        seen_sources: dict[tuple[Any, ...], int] = {}
        source_index = 1

        for record in records:
            content = self._record_value(record, "content", "")
            if not content:
                continue

            external_ref = self._find_ref_for_external_record(record, refs)
            provider = external_ref.get("provider") or self._record_value(
                record, "source_type"
            )
            source_id = external_ref.get("id") or self._record_value(
                record, "source_id"
            )
            ref_key = self._external_ref_key(external_ref)
            title = self._record_value(record, "title", "Unknown")
            source_uri = self._record_value(record, "source_uri")
            document_id = self._record_value(record, "document_id")
            source_key = (ref_key, title, source_uri, document_id)

            if source_key not in seen_sources:
                seen_sources[source_key] = source_index
                payload_by_ref.setdefault(
                    ref_key,
                    {
                        "external_ref": external_ref,
                        "chunks": [],
                        "sources": [],
                        "provider": provider,
                        "source_id": source_id,
                        "source_name": self._record_value(record, "source_name")
                        or external_ref.get("name")
                        or external_ref.get("target_name")
                        or source_id
                        or provider,
                    },
                )["sources"].append(
                    {
                        "index": source_index,
                        "title": title,
                        "provider": provider,
                        "source_id": source_id,
                        "source_uri": source_uri,
                        "document_id": document_id,
                    }
                )
                source_index += 1

            payload_by_ref.setdefault(
                ref_key,
                {
                    "external_ref": external_ref,
                    "chunks": [],
                    "sources": [],
                    "provider": provider,
                    "source_id": source_id,
                    "source_name": self._record_value(record, "source_name")
                    or external_ref.get("name")
                    or external_ref.get("target_name")
                    or source_id
                    or provider,
                },
            )["chunks"].append(
                {
                    "content": content,
                    "source": title,
                    "score": self._record_value(record, "score"),
                    "provider": provider,
                    "source_id": source_id,
                    "source_uri": source_uri,
                    "document_id": document_id,
                    "source_index": seen_sources[source_key],
                    "metadata": self._record_value(record, "metadata") or {},
                }
            )

        return payload_by_ref

    @staticmethod
    def _external_extracted_text(
        *,
        chunks: list[dict[str, Any]],
        sources: list[dict[str, Any]],
    ) -> str:
        """Build persisted JSON for external RAG chunks."""
        payload = {
            "external_knowledge": True,
            "chunks": chunks,
            "sources": sources,
        }
        return json.dumps(payload, ensure_ascii=False)

    def _existing_external_contexts_by_ref(
        self,
        db: Session,
        *,
        user_subtask_id: int,
    ) -> dict[tuple[Any, ...], SubtaskContext]:
        """Load existing external contexts keyed by selected external ref."""
        contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == user_subtask_id,
                SubtaskContext.context_type == ContextType.EXTERNAL_KNOWLEDGE.value,
            )
            .all()
        )
        existing: dict[tuple[Any, ...], SubtaskContext] = {}
        for context in contexts:
            type_data = context.type_data if isinstance(context.type_data, dict) else {}
            external_ref = type_data.get("external_ref") or {}
            if isinstance(external_ref, dict):
                existing[self._external_ref_key(external_ref)] = context
        return existing

    @staticmethod
    def _source_summary_status(
        source_summaries: list[Any],
        *,
        provider: str | None,
        source_id: str | None,
        external_ref: dict[str, Any],
        chunks_count: int,
    ) -> dict[str, Any]:
        """Build UI-facing retrieval status from provider summaries."""
        status = {
            "searched": chunks_count > 0,
            "ignored": False,
            "warning_reason": None,
        }
        for summary in source_summaries:
            summary_provider = getattr(summary, "provider", None)
            if isinstance(summary, dict):
                summary_provider = summary.get("provider")
            if summary_provider != provider:
                continue

            source_statuses = getattr(summary, "source_statuses", None)
            if isinstance(summary, dict):
                source_statuses = summary.get("source_statuses")
            for source_status in source_statuses or []:
                status_source_id = getattr(source_status, "source_id", None)
                status_value = getattr(source_status, "status", None)
                status_canonical_key = getattr(source_status, "canonical_ref_key", None)
                status_reason = getattr(source_status, "reason", None)
                if isinstance(source_status, dict):
                    status_source_id = source_status.get("source_id")
                    status_value = source_status.get("status")
                    status_canonical_key = source_status.get("canonical_ref_key")
                    status_reason = source_status.get("reason")
                if status_canonical_key:
                    if status_canonical_key != external_ref_canonical_key(external_ref):
                        continue
                elif source_id and str(status_source_id) != str(source_id):
                    continue
                if status_value == "hit":
                    return {
                        "searched": True,
                        "ignored": False,
                        "warning_reason": None,
                    }
                if status_value == "ignored":
                    return {
                        "searched": False,
                        "ignored": True,
                        "warning_reason": "external_source_ignored",
                    }
                if status_value == "failed":
                    return {
                        "searched": False,
                        "ignored": False,
                        "warning_reason": status_reason or "provider_failed",
                    }
                if status_value == "no_hit":
                    return {
                        "searched": True,
                        "ignored": False,
                        "warning_reason": "no_hit",
                    }

            ignored_ids = getattr(summary, "ignored_source_ids", None)
            if isinstance(summary, dict):
                ignored_ids = summary.get("ignored_source_ids")
            if (
                source_id
                and ignored_ids
                and str(source_id) in {str(item) for item in ignored_ids}
            ):
                status["ignored"] = True
                status["warning_reason"] = "external_source_ignored"
                status["searched"] = False
                return status
            searched_ids = getattr(summary, "searched_source_ids", None)
            if isinstance(summary, dict):
                searched_ids = summary.get("searched_source_ids")
            if (
                source_id
                and searched_ids
                and str(source_id) in {str(item) for item in searched_ids}
            ):
                status["searched"] = True
                if chunks_count == 0:
                    status["warning_reason"] = "no_hit"
                return status
        if chunks_count == 0:
            status["searched"] = True
            status["warning_reason"] = "no_hit"
        return status

    def _upsert_external_context(
        self,
        db: Session,
        *,
        existing_contexts: dict[tuple[Any, ...], SubtaskContext],
        ref_key: tuple[Any, ...],
        payload: dict[str, Any],
        user_subtask_id: int,
        user_id: int,
        query: str,
        mode: str,
        source_summaries: list[Any],
    ) -> None:
        """Create or update one external knowledge retrieval context."""
        chunks = payload.get("chunks", [])
        sources = payload.get("sources", [])
        external_ref = payload.get("external_ref") or {}
        provider = payload.get("provider")
        source_id = payload.get("source_id")
        retrieval_status = self._source_summary_status(
            source_summaries,
            provider=provider,
            source_id=source_id,
            external_ref=external_ref,
            chunks_count=len(chunks),
        )
        extracted_text = (
            self._external_extracted_text(chunks=chunks, sources=sources)
            if mode == "rag_retrieval" and chunks
            else ""
        )
        context = existing_contexts.get(ref_key)
        previous_type_data = (
            context.type_data
            if context is not None and isinstance(context.type_data, dict)
            else {}
        )
        previous_rag_result = previous_type_data.get("rag_result") or {}
        retrieval_count = int(previous_rag_result.get("retrieval_count") or 0) + 1
        type_data = {
            "auto_created": previous_type_data.get("auto_created", context is None),
            "external_ref": external_ref,
            "provider": provider,
            "source_id": source_id,
            "source_name": payload.get("source_name"),
            "retrieval_status": retrieval_status,
            "rag_result": {
                "sources": sources,
                "injection_mode": mode,
                "query": query,
                "chunks_count": len(chunks),
                "retrieval_count": retrieval_count,
                "provider": provider,
                "knowledge_source_type": "external",
            },
        }

        if context is None:
            context = SubtaskContext(
                subtask_id=user_subtask_id,
                user_id=user_id,
                context_type=ContextType.EXTERNAL_KNOWLEDGE.value,
                name=payload.get("source_name") or source_id or provider or "External",
                status=ContextStatus.READY.value,
                extracted_text=extracted_text,
                text_length=len(extracted_text),
                type_data=type_data,
            )
            db.add(context)
            db.flush()
            existing_contexts[ref_key] = context
            return

        context.name = payload.get("source_name") or context.name
        context.status = ContextStatus.READY.value
        context.extracted_text = extracted_text
        context.text_length = len(extracted_text)
        context.type_data = type_data
        db.add(context)

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

    def persist_external_retrieval_result(
        self,
        db: Session,
        *,
        user_subtask_id: int | None,
        user_id: int | None,
        query: str,
        mode: str,
        records: list[Any],
        refs: list[ExternalKnowledgeRef | dict[str, Any]],
        source_summaries: list[Any] | None = None,
    ) -> None:
        """Persist provider-backed retrieval results as external knowledge contexts."""
        if not user_subtask_id or user_id is None or user_id < 0 or not refs:
            return
        payload_by_ref = self._prepare_external_persistence_payload(
            records=records,
            refs=refs,
        )
        for ref in refs:
            external_ref = self._ref_to_dict(ref)
            ref_key = self._external_ref_key(external_ref)
            payload_by_ref.setdefault(
                ref_key,
                {
                    "external_ref": external_ref,
                    "chunks": [],
                    "sources": [],
                    "provider": external_ref.get("provider"),
                    "source_id": external_ref.get("id"),
                    "source_name": external_ref.get("name")
                    or external_ref.get("target_name")
                    or external_ref.get("id")
                    or external_ref.get("provider"),
                },
            )
        existing_contexts = self._existing_external_contexts_by_ref(
            db=db,
            user_subtask_id=user_subtask_id,
        )
        for ref_key, payload in payload_by_ref.items():
            self._upsert_external_context(
                db=db,
                existing_contexts=existing_contexts,
                ref_key=ref_key,
                payload=payload,
                user_subtask_id=user_subtask_id,
                user_id=user_id,
                query=query,
                mode=mode,
                source_summaries=source_summaries or [],
            )


retrieval_persistence_service = RetrievalPersistenceService()
