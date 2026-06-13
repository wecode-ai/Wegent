#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Fix a KB missing retriever_name and reindex all documents under it.

Usage (in Pod, run from /app directory):
    python scripts/fix_kb_retriever_and_reindex.py --kb-id 236099 --dry-run
    python scripts/fix_kb_retriever_and_reindex.py --kb-ids 236099,236100
    python scripts/fix_kb_retriever_and_reindex.py --kb-id 236099
    python scripts/fix_kb_retriever_and_reindex.py --kb-id 236099 --replace-active
"""

import argparse
import copy
import sys
from pathlib import Path
from typing import Any

from sqlalchemy.orm.attributes import flag_modified

app_root = Path(__file__).resolve().parent.parent
if str(app_root) not in sys.path:
    sys.path.insert(0, str(app_root))


DEFAULT_RETRIEVER_NAME = "elasticsearch"
DEFAULT_RETRIEVER_NAMESPACE = "default"


def log_step(message: str) -> None:
    """Print a high-level operation step."""
    print(f"[STEP] {message}")


def log_info(message: str) -> None:
    """Print an informational operation log."""
    print(f"[INFO] {message}")


def log_success(message: str) -> None:
    """Print a successful operation log."""
    print(f"[OK] {message}")


def log_warning(message: str) -> None:
    """Print a warning operation log."""
    print(f"[WARN] {message}")


def log_error(message: str) -> None:
    """Print an error operation log."""
    print(f"[ERROR] {message}")


def get_db_session():
    """Get database session."""
    from app.db.session import SessionLocal

    return SessionLocal()


def get_knowledge_base(db, kb_id: int):
    """Get an active knowledge base by ID."""
    from app.models.kind import Kind

    return (
        db.query(Kind)
        .filter(
            Kind.id == kb_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )


def get_documents(db, kb_id: int) -> list[Any]:
    """Get all documents under a knowledge base."""
    from app.models.knowledge import KnowledgeDocument

    return (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == kb_id)
        .order_by(KnowledgeDocument.id.asc())
        .all()
    )


def parse_kb_ids(kb_id: int | None, kb_ids: str | None) -> list[int]:
    """Parse knowledge base IDs from --kb-id and --kb-ids."""
    parsed_ids: list[int] = []

    if kb_id is not None:
        parsed_ids.append(kb_id)

    if kb_ids:
        for raw_id in kb_ids.split(","):
            stripped_id = raw_id.strip()
            if not stripped_id:
                continue
            parsed_ids.append(int(stripped_id))

    deduped_ids: list[int] = []
    seen_ids: set[int] = set()
    for parsed_id in parsed_ids:
        if parsed_id in seen_ids:
            continue
        deduped_ids.append(parsed_id)
        seen_ids.add(parsed_id)

    return deduped_ids


def ensure_retriever_config(
    db,
    kb,
    *,
    retriever_name: str,
    retriever_namespace: str,
    dry_run: bool,
) -> tuple[bool, dict[str, Any] | None]:
    """Set missing retriever_name and return the effective retrieval config."""
    spec = copy.deepcopy(kb.json or {})
    kb_spec = spec.get("spec") or {}
    retrieval_config = kb_spec.get("retrievalConfig")

    log_step("Checking knowledge base retrievalConfig")
    if not retrieval_config:
        log_error("Knowledge base has no retrievalConfig; cannot reindex")
        return False, None

    current_retriever_name = retrieval_config.get("retriever_name")
    current_retriever_namespace = (
        retrieval_config.get("retriever_namespace") or DEFAULT_RETRIEVER_NAMESPACE
    )
    embedding_config = retrieval_config.get("embedding_config") or {}
    embedding_model_name = embedding_config.get("model_name")

    log_info(f"KB id={kb.id}, name={kb.name}, namespace={kb.namespace}")
    log_info(
        "Current retriever=" f"{current_retriever_namespace}::{current_retriever_name}"
    )
    log_info(f"Embedding model={embedding_model_name or '<missing>'}")

    if not embedding_model_name:
        log_error("retrievalConfig.embedding_config.model_name is missing")
        return False, None

    if current_retriever_name:
        log_success("retriever_name already exists; no DB update needed")
        return False, retrieval_config

    log_warning(
        "retriever_name is missing; "
        f"will set to {retriever_namespace}::{retriever_name}"
    )

    retrieval_config["retriever_name"] = retriever_name
    retrieval_config["retriever_namespace"] = retriever_namespace
    kb_spec["retrievalConfig"] = retrieval_config
    spec["spec"] = kb_spec

    if dry_run:
        log_info("[DRY RUN] Would update knowledge base retrievalConfig")
        return True, retrieval_config

    kb.json = spec
    flag_modified(kb, "json")
    db.commit()
    log_success("Updated knowledge base retrievalConfig")
    return True, retrieval_config


def reindex_document(
    db,
    *,
    document,
    retrieval_config: dict[str, Any],
    trigger_summary: bool,
    replace_active: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Schedule one document for reindexing."""
    from app.models.user import User
    from app.services.knowledge.index_state_machine import (
        mark_document_index_enqueue_failed,
        prepare_document_index_enqueue,
    )
    from app.services.knowledge.indexing import get_rag_indexing_skip_reason
    from app.tasks.knowledge_tasks import index_document_task

    details: dict[str, Any] = {
        "document_id": document.id,
        "name": document.name,
        "attachment_id": document.attachment_id,
        "index_status": (
            document.index_status.value if document.index_status else None
        ),
        "index_generation": document.index_generation,
    }

    log_step(f"Checking document id={document.id}, name={document.name}")
    log_info(
        "Document state: "
        f"attachment_id={document.attachment_id}, "
        f"source_type={document.source_type}, "
        f"file_extension={document.file_extension}, "
        f"file_size={document.file_size}, "
        f"index_status={details['index_status']}, "
        f"generation={document.index_generation}"
    )

    skip_reason = get_rag_indexing_skip_reason(
        document.source_type,
        document.file_extension,
        document.file_size,
    )
    if skip_reason:
        log_warning(f"Skip document id={document.id}: {skip_reason}")
        return {"success": False, "skipped": True, "reason": skip_reason, **details}

    embedding_config = retrieval_config.get("embedding_config") or {}
    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = (
        retrieval_config.get("retriever_namespace") or DEFAULT_RETRIEVER_NAMESPACE
    )
    embedding_model_name = embedding_config.get("model_name")
    embedding_model_namespace = (
        embedding_config.get("model_namespace") or DEFAULT_RETRIEVER_NAMESPACE
    )

    if not retriever_name or not embedding_model_name:
        reason = "incomplete retrievalConfig after fix"
        log_error(f"Skip document id={document.id}: {reason}")
        return {"success": False, "skipped": True, "reason": reason, **details}

    user = db.query(User).filter_by(id=document.user_id).first()
    if not user:
        reason = f"document owner user_id={document.user_id} not found"
        log_error(f"Skip document id={document.id}: {reason}")
        return {"success": False, "skipped": True, "reason": reason, **details}

    log_info(
        "Index config: "
        f"retriever={retriever_namespace}::{retriever_name}, "
        f"embedding={embedding_model_namespace}::{embedding_model_name}, "
        f"user_id={user.id}, user_name={user.user_name}"
    )

    if dry_run:
        log_info(f"[DRY RUN] Would enqueue document id={document.id}")
        return {"success": True, "dry_run": True, **details}

    index_generation = None
    try:
        log_step(f"Preparing enqueue for document id={document.id}")
        prepare_result = prepare_document_index_enqueue(
            db=db,
            document_id=document.id,
            allow_if_success=True,
            replace_active=replace_active,
        )

        if not prepare_result.should_enqueue:
            log_warning(
                "Prepare enqueue skipped: "
                f"document id={document.id}, reason={prepare_result.reason}"
            )
            return {
                "success": False,
                "skipped": True,
                "reason": prepare_result.reason,
                **details,
            }

        index_generation = prepare_result.generation
        log_success(
            f"Prepared enqueue: document id={document.id}, "
            f"generation={index_generation}"
        )

        log_step(f"Sending Celery task for document id={document.id}")
        celery_task = index_document_task.delay(
            knowledge_base_id=str(document.kind_id),
            attachment_id=document.attachment_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            user_id=user.id,
            user_name=user.user_name,
            document_id=document.id,
            index_generation=index_generation,
            splitter_config_dict=document.splitter_config or {},
            trigger_summary=trigger_summary,
        )
        log_success(
            f"Celery task queued: document id={document.id}, task_id={celery_task.id}"
        )
        return {
            "success": True,
            "celery_task_id": celery_task.id,
            "index_generation": index_generation,
            **details,
        }
    except Exception as exc:
        log_error(f"Failed to enqueue document id={document.id}: {exc}")
        if index_generation is not None:
            try:
                mark_document_index_enqueue_failed(
                    db,
                    document.id,
                    index_generation,
                )
                log_warning(
                    f"Marked enqueue failed: document id={document.id}, "
                    f"generation={index_generation}"
                )
            except Exception as mark_exc:
                log_error(
                    "Failed to mark enqueue failed: "
                    f"document id={document.id}, error={mark_exc}"
                )
        return {"success": False, "error": str(exc), **details}


def process_knowledge_base(
    db,
    *,
    kb_id: int,
    retriever_name: str,
    retriever_namespace: str,
    trigger_summary: bool,
    replace_active: bool,
    dry_run: bool,
) -> dict[str, int]:
    """Fix and reindex one knowledge base."""
    summary = {
        "kb_total": 1,
        "kb_success": 0,
        "kb_failed": 0,
        "document_total": 0,
        "document_success": 0,
        "document_skipped": 0,
        "document_failed": 0,
    }

    log_step(f"Loading knowledge base id={kb_id}")
    kb = get_knowledge_base(db, kb_id)
    if not kb:
        log_error(f"Knowledge base id={kb_id} not found or inactive")
        summary["kb_failed"] = 1
        return summary

    _, retrieval_config = ensure_retriever_config(
        db=db,
        kb=kb,
        retriever_name=retriever_name,
        retriever_namespace=retriever_namespace,
        dry_run=dry_run,
    )
    if not retrieval_config:
        summary["kb_failed"] = 1
        return summary

    log_step("Loading documents under knowledge base")
    documents = get_documents(db, kb_id)
    summary["document_total"] = len(documents)
    log_info(f"Found {len(documents)} document(s)")

    if not documents:
        log_warning("No documents found; nothing to reindex")
        summary["kb_success"] = 1
        return summary

    for index, document in enumerate(documents, start=1):
        print("-" * 80)
        log_step(f"Processing document {index}/{len(documents)} (id={document.id})")
        result = reindex_document(
            db=db,
            document=document,
            retrieval_config=retrieval_config,
            trigger_summary=trigger_summary,
            replace_active=replace_active,
            dry_run=dry_run,
        )

        if result.get("success"):
            summary["document_success"] += 1
        elif result.get("skipped"):
            summary["document_skipped"] += 1
        else:
            summary["document_failed"] += 1

    if summary["document_failed"]:
        summary["kb_failed"] = 1
    else:
        summary["kb_success"] = 1

    log_step(f"Finished KB id={kb_id}")
    log_info(f"Documents: {summary['document_total']}")
    log_info(f"Queued or dry-run success: {summary['document_success']}")
    log_info(f"Skipped: {summary['document_skipped']}")
    log_info(f"Failed: {summary['document_failed']}")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Fix retriever_name for knowledge bases and reindex their documents"
        )
    )
    parser.add_argument("--kb-id", type=int, help="Single knowledge base ID")
    parser.add_argument(
        "--kb-ids",
        help="Comma-separated knowledge base IDs, for example: 236099,236100",
    )
    parser.add_argument(
        "--retriever-name",
        default=DEFAULT_RETRIEVER_NAME,
        help=f"Retriever name to set when missing (default: {DEFAULT_RETRIEVER_NAME})",
    )
    parser.add_argument(
        "--retriever-namespace",
        default=DEFAULT_RETRIEVER_NAMESPACE,
        help=(
            "Retriever namespace to set when missing "
            f"(default: {DEFAULT_RETRIEVER_NAMESPACE})"
        ),
    )
    parser.add_argument(
        "--trigger-summary",
        action="store_true",
        help="Trigger summary generation after indexing",
    )
    parser.add_argument(
        "--replace-active",
        action="store_true",
        help="Replace any in-flight indexing task",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print operations without updating DB or sending Celery tasks",
    )

    args = parser.parse_args()
    kb_ids = parse_kb_ids(args.kb_id, args.kb_ids)
    if not kb_ids:
        parser.error("No knowledge base IDs provided. Use --kb-id or --kb-ids")

    log_step("Starting KB retriever fix and reindex script")
    log_info(f"kb_ids={','.join(str(kb_id) for kb_id in kb_ids)}")
    log_info(f"dry_run={args.dry_run}")
    log_info(f"trigger_summary={args.trigger_summary}")
    log_info(f"replace_active={args.replace_active}")

    db = get_db_session()
    try:
        total_summary = {
            "kb_total": 0,
            "kb_success": 0,
            "kb_failed": 0,
            "document_total": 0,
            "document_success": 0,
            "document_skipped": 0,
            "document_failed": 0,
        }

        for kb_index, kb_id in enumerate(kb_ids, start=1):
            print("=" * 80)
            log_step(f"Processing KB {kb_index}/{len(kb_ids)} (id={kb_id})")
            kb_summary = process_knowledge_base(
                db=db,
                kb_id=kb_id,
                retriever_name=args.retriever_name,
                retriever_namespace=args.retriever_namespace,
                trigger_summary=args.trigger_summary,
                replace_active=args.replace_active,
                dry_run=args.dry_run,
            )
            for key, value in kb_summary.items():
                total_summary[key] += value

        print("=" * 80)
        log_step("Finished")
        log_info(f"Total KBs: {total_summary['kb_total']}")
        log_info(f"Successful KBs: {total_summary['kb_success']}")
        log_info(f"Failed KBs: {total_summary['kb_failed']}")
        log_info(f"Total documents: {total_summary['document_total']}")
        log_info(f"Queued or dry-run success: {total_summary['document_success']}")
        log_info(f"Skipped documents: {total_summary['document_skipped']}")
        log_info(f"Failed documents: {total_summary['document_failed']}")

        return 1 if total_summary["kb_failed"] else 0
    finally:
        db.close()
        log_info("Database session closed")


if __name__ == "__main__":
    raise SystemExit(main())
