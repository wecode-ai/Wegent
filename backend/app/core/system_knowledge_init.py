# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Initialize built-in system knowledge bases from init_data seeds."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeDocumentCreate
from app.schemas.namespace import GroupLevel
from app.services.context import context_service
from app.services.knowledge.knowledge_service import KnowledgeService
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

logger = logging.getLogger(__name__)

SYSTEM_KNOWLEDGE_DIR = "system_knowledge"
DEFAULT_SEED_ID = "wegent-help"
SYSTEM_SOURCE = "system_knowledge_seed"


@dataclass(frozen=True)
class SeedDocument:
    """A Markdown document copied into a system knowledge seed package.

    The source and seed paths identify the original docs location and the
    packaged file path. The content hash is used to decide whether an existing
    system knowledge document needs to be updated during startup.
    """

    source_path: str
    seed_path: str
    language: str
    title: str
    category: str
    content_sha256: str
    content: str


@dataclass(frozen=True)
class SystemKnowledgeSeed:
    """A complete system knowledge seed manifest loaded from init data.

    The seed describes the target knowledge base metadata and the Markdown
    documents that should be synchronized into that built-in knowledge base.
    """

    seed_id: str
    kb_name: str
    kb_display_name: str
    namespace: str
    description: str
    documents: list[SeedDocument]


def _safe_seed_file(seed_root: Path, seed_path: str) -> Path:
    candidate = (seed_root / seed_path).resolve()
    seed_root_resolved = seed_root.resolve()
    if candidate != seed_root_resolved and seed_root_resolved not in candidate.parents:
        raise ValueError(f"Unsafe seed path: {seed_path}")
    return candidate


def load_system_knowledge_seed(seed_root: Path) -> SystemKnowledgeSeed | None:
    """Load a system knowledge seed manifest and its packaged documents.

    Args:
        seed_root: Directory containing `manifest.json` and copied seed files.

    Returns:
        Parsed seed data, or None when the manifest is missing or malformed.
        Invalid document entries are skipped so one bad file does not abort
        startup initialization.
    """

    manifest_path = seed_root / "manifest.json"
    if not manifest_path.exists():
        logger.info("System knowledge manifest not found: %s", manifest_path)
        return None

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("Invalid system knowledge manifest at %s: %s", manifest_path, exc)
        return None

    if not isinstance(manifest, dict):
        logger.error("Invalid system knowledge manifest shape at %s", manifest_path)
        return None

    kb = manifest.get("knowledge_base") or {}
    if not isinstance(kb, dict):
        logger.warning("Invalid knowledge_base metadata in %s", manifest_path)
        kb = {}
    documents: list[SeedDocument] = []

    document_items = manifest.get("documents") or []
    if not isinstance(document_items, list):
        logger.warning("Invalid documents metadata in %s", manifest_path)
        document_items = []

    for item in document_items:
        try:
            seed_path = item["seed_path"]
            source_path = item["source_path"]
            content_sha256 = item["content_sha256"]
            content = _safe_seed_file(seed_root, seed_path).read_text(encoding="utf-8")
        except (KeyError, OSError, TypeError, ValueError) as exc:
            logger.warning("Skipping invalid seed document entry %r: %s", item, exc)
            continue
        documents.append(
            SeedDocument(
                source_path=source_path,
                seed_path=seed_path,
                language=item.get("language", ""),
                title=item.get("title") or Path(seed_path).stem,
                category=item.get("category", ""),
                content_sha256=content_sha256,
                content=content,
            )
        )

    return SystemKnowledgeSeed(
        seed_id=manifest.get("seed_id") or DEFAULT_SEED_ID,
        kb_name=kb.get("name") or "Wegent Help",
        kb_display_name=kb.get("display_name") or "Wegent 帮助文档",
        namespace=kb.get("namespace") or "system",
        description=kb.get("description") or "",
        documents=documents,
    )


def ensure_system_namespace(
    db: Session,
    *,
    name: str,
    owner_user_id: int,
) -> Namespace:
    """Create or normalize the namespace used by built-in system knowledge.

    Args:
        db: SQLAlchemy session used for reads and writes.
        name: Namespace name to create or update.
        owner_user_id: User id that owns newly created namespace records.

    Returns:
        Active organization-level namespace with internal visibility.
    """

    namespace = db.query(Namespace).filter(Namespace.name == name).first()
    if namespace:
        changed = False
        if namespace.level != GroupLevel.organization.value:
            namespace.level = GroupLevel.organization.value
            changed = True
        if namespace.visibility != "internal":
            namespace.visibility = "internal"
            changed = True
        if not namespace.is_active:
            namespace.is_active = True
            changed = True
        if changed:
            db.commit()
            db.refresh(namespace)
        return namespace

    namespace = Namespace(
        name=name,
        display_name="System",
        owner_user_id=owner_user_id,
        visibility="internal",
        description="Built-in system resources",
        level=GroupLevel.organization.value,
        is_active=True,
    )
    db.add(namespace)
    db.commit()
    db.refresh(namespace)
    return namespace


def _system_labels(seed: SystemKnowledgeSeed) -> dict[str, str]:
    return {"source": SYSTEM_SOURCE, "seed_id": seed.seed_id}


def _kind_labels(kind: Kind) -> dict[str, Any]:
    metadata = (kind.json or {}).get("metadata") or {}
    return metadata.get("labels") or {}


def ensure_system_help_knowledge_base(
    db: Session,
    *,
    seed: SystemKnowledgeSeed,
    admin_user: User,
) -> Kind:
    """Create or locate the built-in help knowledge base for a seed.

    Args:
        db: SQLAlchemy session used for reads and writes.
        seed: Parsed system knowledge seed metadata.
        admin_user: Admin user that owns the system knowledge base.

    Returns:
        KnowledgeBase Kind labeled with the seed source and seed id.
    """

    labels = _system_labels(seed)
    candidates = (
        db.query(Kind)
        .filter(
            Kind.kind == "KnowledgeBase",
            Kind.namespace == seed.namespace,
            Kind.is_active == True,
        )
        .all()
    )

    for kb in candidates:
        spec = (kb.json or {}).get("spec") or {}
        existing_labels = _kind_labels(kb)
        if (
            existing_labels.get("seed_id") == seed.seed_id
            or spec.get("name") == seed.kb_name
        ):
            kb_json = kb.json or {}
            metadata = kb_json.setdefault("metadata", {})
            metadata["labels"] = {**existing_labels, **labels}
            kb.json = kb_json
            flag_modified(kb, "json")
            db.commit()
            db.refresh(kb)
            return kb

    data = KnowledgeBaseCreate(
        name=seed.kb_name,
        description=seed.description,
        namespace=seed.namespace,
        kb_type="classic",
        rag_config_mode="auto",
        summary_enabled=False,
    )
    kb_id = KnowledgeService.create_knowledge_base(db, admin_user.id, data)
    kb = db.query(Kind).filter(Kind.id == kb_id).one()
    kb_json = kb.json or {}
    metadata = kb_json.setdefault("metadata", {})
    metadata["labels"] = {**(metadata.get("labels") or {}), **labels}
    kb.json = kb_json
    flag_modified(kb, "json")
    db.commit()
    db.refresh(kb)
    return kb


def _find_existing_system_docs(
    db: Session,
    knowledge_base_id: int,
) -> dict[str, KnowledgeDocument]:
    docs = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base_id)
        .all()
    )
    result: dict[str, KnowledgeDocument] = {}
    for doc in docs:
        source_config = doc.source_config or {}
        if source_config.get("source") == SYSTEM_SOURCE and source_config.get(
            "source_path"
        ):
            result[source_config["source_path"]] = doc
    return result


def _source_config(seed: SystemKnowledgeSeed, document: SeedDocument) -> dict[str, Any]:
    return {
        "source": SYSTEM_SOURCE,
        "seed_id": seed.seed_id,
        "source_path": document.source_path,
        "language": document.language,
        "category": document.category,
        "content_sha256": document.content_sha256,
    }


def _write_source_config(
    db: Session,
    *,
    doc: KnowledgeDocument,
    seed: SystemKnowledgeSeed,
    seed_document: SeedDocument,
) -> None:
    doc.source_config = _source_config(seed, seed_document)
    flag_modified(doc, "source_config")
    db.commit()
    db.refresh(doc)


def _has_retrieval_config(knowledge_base: Kind) -> bool:
    return bool(((knowledge_base.json or {}).get("spec") or {}).get("retrievalConfig"))


def schedule_document_indexing_if_possible(
    *,
    db: Session,
    knowledge_base: Kind,
    document: KnowledgeDocument,
    admin_user: User,
) -> dict[str, Any]:
    if not _has_retrieval_config(knowledge_base):
        return {"scheduled": False, "reason": "missing_retrieval_config"}

    from app.services.knowledge.orchestrator import knowledge_orchestrator

    return knowledge_orchestrator._schedule_indexing_celery(
        db=db,
        knowledge_base=knowledge_base,
        document=document,
        user=admin_user,
        trigger_summary=False,
        allow_if_success=True,
        replace_active=True,
    )


def _create_seed_document(
    db: Session,
    *,
    seed: SystemKnowledgeSeed,
    knowledge_base: Kind,
    seed_document: SeedDocument,
    admin_user: User,
) -> KnowledgeDocument:
    binary_content = seed_document.content.encode("utf-8")
    attachment, _ = context_service.upload_attachment(
        db=db,
        user_id=admin_user.id,
        filename=f"{seed_document.title}.md",
        binary_data=binary_content,
        subtask_id=0,
    )
    doc = KnowledgeService.create_document(
        db=db,
        knowledge_base_id=knowledge_base.id,
        user_id=admin_user.id,
        data=KnowledgeDocumentCreate(
            name=seed_document.title,
            source_type="text",
            attachment_id=attachment.id,
            file_extension="md",
            file_size=len(binary_content),
            folder_id=0,
        ),
    )
    _write_source_config(db, doc=doc, seed=seed, seed_document=seed_document)
    return doc


def _update_seed_document(
    db: Session,
    *,
    seed: SystemKnowledgeSeed,
    doc: KnowledgeDocument,
    seed_document: SeedDocument,
    admin_user: User,
) -> KnowledgeDocument:
    from app.services.knowledge.orchestrator import knowledge_orchestrator

    knowledge_orchestrator.update_document_content(
        db=db,
        user=admin_user,
        document_id=doc.id,
        content=seed_document.content,
        trigger_reindex=False,
    )
    doc = db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc.id).one()
    doc.name = seed_document.title
    _write_source_config(db, doc=doc, seed=seed, seed_document=seed_document)
    return doc


def sync_system_documents(
    db: Session,
    *,
    seed: SystemKnowledgeSeed,
    knowledge_base: Kind,
    admin_user: User,
) -> dict[str, int]:
    """Synchronize seed documents into the target knowledge base.

    Args:
        db: SQLAlchemy session used for reads and writes.
        seed: Parsed seed documents and metadata.
        knowledge_base: KnowledgeBase Kind that receives the documents.
        admin_user: Admin user used for document creation and indexing.

    Returns:
        Counts for created, updated, and skipped documents.
    """

    existing = _find_existing_system_docs(db, knowledge_base.id)
    stats = {"created": 0, "updated": 0, "skipped": 0}

    for seed_document in seed.documents:
        doc = existing.get(seed_document.source_path)
        if (
            doc
            and (doc.source_config or {}).get("content_sha256")
            == seed_document.content_sha256
        ):
            stats["skipped"] += 1
            continue

        if doc is None:
            doc = _create_seed_document(
                db,
                seed=seed,
                knowledge_base=knowledge_base,
                seed_document=seed_document,
                admin_user=admin_user,
            )
            stats["created"] += 1
        else:
            doc = _update_seed_document(
                db,
                seed=seed,
                doc=doc,
                seed_document=seed_document,
                admin_user=admin_user,
            )
            stats["updated"] += 1

        schedule_document_indexing_if_possible(
            db=db,
            knowledge_base=knowledge_base,
            document=doc,
            admin_user=admin_user,
        )

    return stats


@trace_sync("system_knowledge.initialization", "backend.system_knowledge")
def run_system_knowledge_initialization(
    db: Session,
    admin_user_id: int,
    init_data_dir: Path,
) -> dict[str, Any]:
    """Initialize built-in system knowledge from packaged init data.

    Args:
        db: SQLAlchemy session used for startup initialization.
        admin_user_id: Admin user id that owns created system resources.
        init_data_dir: Base init data directory containing system knowledge seeds.

    Returns:
        Summary dictionary with status, reason when skipped or errored, and
        document synchronization counts when initialization completes.
    """

    seed_root = init_data_dir / SYSTEM_KNOWLEDGE_DIR / DEFAULT_SEED_ID
    seed = load_system_knowledge_seed(seed_root)
    if seed is None:
        set_span_attribute("system_knowledge.status", "skipped")
        set_span_attribute("system_knowledge.reason", "missing_manifest")
        add_span_event(
            "system_knowledge.initialization.skipped",
            {"reason": "missing_manifest"},
        )
        return {"status": "skipped", "reason": "missing_manifest"}

    admin_user = db.query(User).filter(User.id == admin_user_id).first()
    if not admin_user:
        set_span_attribute("system_knowledge.status", "error")
        set_span_attribute("system_knowledge.reason", "admin_user_not_found")
        add_span_event(
            "system_knowledge.initialization.error",
            {"reason": "admin_user_not_found"},
        )
        return {"status": "error", "reason": "admin_user_not_found"}

    ensure_system_namespace(db, name=seed.namespace, owner_user_id=admin_user.id)
    knowledge_base = ensure_system_help_knowledge_base(
        db,
        seed=seed,
        admin_user=admin_user,
    )
    stats = sync_system_documents(
        db,
        seed=seed,
        knowledge_base=knowledge_base,
        admin_user=admin_user,
    )

    result = {
        "status": "completed",
        "knowledge_base_id": knowledge_base.id,
        "documents_created": stats["created"],
        "documents_updated": stats["updated"],
        "documents_skipped": stats["skipped"],
    }
    set_span_attribute("system_knowledge.status", result["status"])
    set_span_attribute("system_knowledge.knowledge_base_id", knowledge_base.id)
    set_span_attribute("system_knowledge.documents_created", stats["created"])
    set_span_attribute("system_knowledge.documents_updated", stats["updated"])
    set_span_attribute("system_knowledge.documents_skipped", stats["skipped"])
    add_span_event(
        "system_knowledge.initialization.completed",
        {
            "knowledge_base_id": knowledge_base.id,
            "documents_created": stats["created"],
            "documents_updated": stats["updated"],
            "documents_skipped": stats["skipped"],
        },
    )
    return result
