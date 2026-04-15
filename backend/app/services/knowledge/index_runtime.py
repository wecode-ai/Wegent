import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind

logger = logging.getLogger(__name__)


@dataclass
class KnowledgeBaseIndexInfo:
    """Container for knowledge base information needed for index runtime resolution."""

    index_owner_user_id: int
    summary_enabled: bool = False


def build_kb_index_info(
    db: Session,
    knowledge_base: Kind,
    current_user_id: int,
) -> KnowledgeBaseIndexInfo:
    """Build KB index runtime info from a loaded knowledge base.

    Index ownership is intentionally bound to the persisted knowledge-base owner,
    not to the current caller. This keeps storage resolution stable across
    personal, group, and organization namespaces: collaborators may trigger
    indexing or retrieval, but the runtime still resolves retriever / embedding /
    storage credentials under the knowledge base's owner scope.
    """
    del db
    del current_user_id
    spec = (knowledge_base.json or {}).get("spec", {})
    summary_enabled = spec.get("summaryEnabled", False)

    return KnowledgeBaseIndexInfo(
        index_owner_user_id=knowledge_base.user_id,
        summary_enabled=summary_enabled,
    )


def get_kb_index_info_by_record(
    db: Session,
    knowledge_base: Kind,
    current_user_id: int,
) -> KnowledgeBaseIndexInfo:
    """Return KB index runtime info for an already loaded knowledge base record."""
    return build_kb_index_info(
        db=db,
        knowledge_base=knowledge_base,
        current_user_id=current_user_id,
    )


def get_kb_index_info(
    db: Session, knowledge_base_id: str, current_user_id: int
) -> KnowledgeBaseIndexInfo:
    """Return KB index owner and summary flags needed by indexing/runtime code."""
    try:
        kb_id = int(knowledge_base_id)
    except ValueError:
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    kb = (
        db.query(Kind)
        .filter(
            Kind.id == kb_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active == True,
        )
        .first()
    )

    if not kb:
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    return build_kb_index_info(
        db=db,
        knowledge_base=kb,
        current_user_id=current_user_id,
    )


def resolve_kb_index_info(
    db: Session,
    knowledge_base_id: str,
    user_id: int,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
) -> KnowledgeBaseIndexInfo:
    """Use precomputed KB index info when available, otherwise fetch it."""
    if kb_index_info:
        logger.debug(
            f"[Indexing] Using pre-computed KB info: index_owner_user_id={kb_index_info.index_owner_user_id}, "
            f"summary_enabled={kb_index_info.summary_enabled}"
        )
        return kb_index_info

    kb_info = get_kb_index_info(
        db=db,
        knowledge_base_id=knowledge_base_id,
        current_user_id=user_id,
    )
    logger.debug(
        f"[Indexing] Fetched KB info from DB: index_owner_user_id={kb_info.index_owner_user_id}, "
        f"summary_enabled={kb_info.summary_enabled}"
    )
    return kb_info
