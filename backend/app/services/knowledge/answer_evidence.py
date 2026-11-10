"""Trusted answer-time snapshots, atomic binding, and dual-authorized reads."""

from collections.abc import Iterator
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, NoReturn

from fastapi import HTTPException
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.models.knowledge_citation import KnowledgeCitation
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.knowledge.knowledge_access_policy import (
    can_directly_access_knowledge_base,
)
from app.stores.tasks import subtask_store, task_access_store


@dataclass(frozen=True)
class TrustedEvidence:
    """Created only at the internal Chat Shell completion transport boundary."""

    units: list[dict]
    user_id: int


def fail(status: int, code: str) -> NoReturn:
    raise HTTPException(status_code=status, detail={"code": code})


def require_source(db: Session, user_id: int, kb_id: int, doc_id: int) -> None:
    kb = db.query(Kind).filter(Kind.id == kb_id, Kind.kind == "KnowledgeBase").first()
    if kb is None:
        fail(409, "CITATION_SOURCE_UNAVAILABLE")
    if not can_directly_access_knowledge_base(db, kb_id, user_id, kb=kb):
        fail(403, "CITATION_ACCESS_DENIED")
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc_id).first()
    )
    spec = (kb.json or {}).get("spec", {})
    if (
        not kb.is_active
        or spec.get("source")
        or document is None
        or document.kind_id != kb_id
        or not document.is_active
        or document.status != DocumentStatus.ENABLED
        or document.source_type not in ("file", "text")
        or document.index_status != DocumentIndexStatus.SUCCESS
    ):
        fail(409, "CITATION_SOURCE_UNAVAILABLE")


def public_result(value: Any) -> Any:
    """Strip private completion transport data even from nested result copies."""
    if isinstance(value, dict):
        return {
            key: public_result(item)
            for key, item in value.items()
            if key != "_answer_evidence"
        }
    if isinstance(value, list):
        return [public_result(item) for item in value]
    return deepcopy(value)


def _text_slots(result: dict) -> Iterator[tuple[dict, str]]:
    if isinstance(result.get("value"), str):
        yield result, "value"
    for block in result.get("blocks") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            if isinstance(block.get("content"), str):
                yield block, "content"


def _valid_unit(unit: dict) -> bool:
    return (
        isinstance(unit.get("evidence_id"), str)
        and isinstance(unit.get("content"), str)
        and 0 < len(unit["content"]) <= 5000
        and isinstance(unit.get("knowledge_base_id"), int)
        and isinstance(unit.get("document_id"), int)
        and isinstance(unit.get("source"), str)
        and len(unit["source"]) <= 1024
        and isinstance(unit.get("source_chunk_id", ""), str)
        and len(unit.get("source_chunk_id", "")) <= 255
        and unit.get("source_type") in (None, "", "internal")
        and not unit.get("source_id")
    )


def bind_answer_evidence(db: Session, answer: Any, original: dict) -> dict:
    """Insert one evidence batch without mutating the pending answer or caller."""
    from shared.utils.evidence_markers import rewrite_markers

    result = public_result(original)
    result.pop("answer_citations", None)
    result.pop("answer_generation_id", None)
    result.pop("answer_evidence_errors", None)
    trusted = original.get("_answer_evidence")
    units = trusted.units if isinstance(trusted, TrustedEvidence) else []
    actor_id = trusted.user_id if isinstance(trusted, TrustedEvidence) else None
    mentioned: set[str] = set()

    def remember(local_id: str) -> str:
        mentioned.add(local_id)
        return ""

    for node, key in _text_slots(result):
        rewrite_markers(node[key], remember)
    rows: dict[str, KnowledgeCitation] = {}
    if answer.answer_generation_id and actor_id is not None:
        for unit in units:
            if not isinstance(unit, dict) or not _valid_unit(unit):
                continue
            local_id = unit["evidence_id"]
            if local_id not in mentioned or local_id in rows:
                continue
            try:
                require_source(
                    db, actor_id, unit["knowledge_base_id"], unit["document_id"]
                )
            except HTTPException:
                continue
            rows[local_id] = KnowledgeCitation(
                knowledge_base_id=unit["knowledge_base_id"],
                document_id=unit["document_id"],
                title=unit["source"],
                content=unit["content"],
                user_id=actor_id,
                source_chunk_id=unit.get("source_chunk_id", ""),
                caller_context={
                    "answer_evidence": {
                        "answer_id": answer.id,
                        "generation_id": answer.answer_generation_id,
                        "local_id": local_id,
                    }
                },
            )
    if rows:
        savepoint = db.begin_nested()
        try:
            for row in rows.values():
                db.add(row)
            db.flush()
        except DBAPIError as exc:
            if exc.connection_invalidated:
                raise
            savepoint.rollback()
            rows = {}
            result["answer_evidence_errors"] = ["EVIDENCE_WRITE_FAILED"]
        else:
            savepoint.commit()
    for node, key in _text_slots(result):
        node[key] = rewrite_markers(
            node[key],
            lambda local_id: (
                f"[[citation:{rows[local_id].id}]]"
                if local_id in rows
                else "[[evidence-unavailable]]"
            ),
        )
    result["answer_generation_id"] = answer.answer_generation_id
    result["answer_citations"] = [
        {
            "citation_id": str(row.id),
            "title": row.title,
            "knowledge_base_id": row.knowledge_base_id,
            "document_id": row.document_id,
        }
        for row in rows.values()
    ]
    return result


def read_citation(
    db: Session, user_id: int, citation_id: int, answer_id: int, generation_id: str
) -> dict:
    row = db.get(KnowledgeCitation, citation_id)
    if row is None:
        fail(404, "CITATION_NOT_FOUND")
    context = row.caller_context
    binding = context.get("answer_evidence") if isinstance(context, dict) else None
    if (
        not isinstance(binding, dict)
        or binding.get("answer_id") != answer_id
        or binding.get("generation_id") != generation_id
        or not isinstance(binding.get("local_id"), str)
        or not binding["local_id"]
    ):
        fail(404, "CITATION_NOT_FOUND")
    answer = subtask_store.get_by_id(db, subtask_id=answer_id)
    if answer is None or not task_access_store.get_task(db, task_id=answer.task_id):
        fail(404, "CITATION_NOT_FOUND")
    if not task_access_store.is_member(db, task_id=answer.task_id, user_id=user_id):
        fail(403, "CITATION_ACCESS_DENIED")
    if (
        answer.answer_generation_id != generation_id
        or answer.status != SubtaskStatus.COMPLETED
        or answer.role != SubtaskRole.ASSISTANT
    ):
        fail(404, "CITATION_NOT_FOUND")
    require_source(db, user_id, row.knowledge_base_id, row.document_id)
    return {
        "citation_id": str(row.id),
        "answer_id": answer_id,
        "generation_id": generation_id,
        "title": row.title,
        "content": row.content,
        "knowledge_base_id": row.knowledge_base_id,
        "document_id": row.document_id,
        "source_chunk_id": row.source_chunk_id,
        "created_at": row.created_at,
    }
