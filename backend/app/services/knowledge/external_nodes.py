# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Node listing helpers for external knowledge MCP integrations."""

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import func

from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.schemas.knowledge_external import (
    ExternalKnowledgeNode,
    ExternalKnowledgeNodeType,
)
from app.services.knowledge.external_document_access import (
    build_document_capabilities,
    load_attachment_map,
)

MAX_RECURSIVE_NODES = 5000
MAX_RECURSIVE_DEPTH = 100


class ExternalKnowledgeInputError(ValueError):
    """Input validation error surfaced as an external MCP tool error."""

    def __init__(self, message: str, code: str = "bad_request") -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class DirectNodeList:
    """Paginated direct child nodes for a folder."""

    items: list[ExternalKnowledgeNode]
    total_available: int
    has_more: bool


def get_document_counts(db, knowledge_base_ids: list[int]) -> dict[int, int]:
    """Return total document counts for knowledge bases, including inactive docs."""
    if not knowledge_base_ids:
        return {}

    rows = (
        db.query(KnowledgeDocument.kind_id, func.count(KnowledgeDocument.id))
        .filter(KnowledgeDocument.kind_id.in_(knowledge_base_ids))
        .group_by(KnowledgeDocument.kind_id)
        .all()
    )
    return {knowledge_base_id: count for knowledge_base_id, count in rows}


def list_direct_nodes(
    db,
    knowledge_base_id: int,
    folder_id: int,
    include_inactive: bool,
    limit: int,
    offset: int,
) -> DirectNodeList:
    """List direct child folders and documents for a folder with pagination."""
    folder_count = (
        db.query(func.count(KnowledgeFolder.id))
        .filter(
            KnowledgeFolder.kind_id == knowledge_base_id,
            KnowledgeFolder.parent_id == folder_id,
        )
        .scalar()
        or 0
    )
    document_count = (
        db.query(func.count(KnowledgeDocument.id))
        .filter(*_document_filters(knowledge_base_id, include_inactive, folder_id))
        .scalar()
        or 0
    )
    total_available = folder_count + document_count

    folder_offset = min(offset, folder_count)
    folder_limit = max(min(limit, folder_count - folder_offset), 0)
    child_folders = (
        db.query(KnowledgeFolder)
        .filter(
            KnowledgeFolder.kind_id == knowledge_base_id,
            KnowledgeFolder.parent_id == folder_id,
        )
        .order_by(KnowledgeFolder.created_at.desc(), KnowledgeFolder.id.desc())
        .offset(folder_offset)
        .limit(folder_limit)
        .all()
    )

    remaining_limit = limit - len(child_folders)
    document_offset = max(offset - folder_count, 0)
    child_documents = (
        db.query(KnowledgeDocument)
        .filter(*_document_filters(knowledge_base_id, include_inactive, folder_id))
        .order_by(KnowledgeDocument.created_at.desc(), KnowledgeDocument.id.desc())
        .offset(document_offset)
        .limit(remaining_limit)
        .all()
    )

    child_counts = _get_children_counts(
        db,
        knowledge_base_id=knowledge_base_id,
        folder_ids=[folder.id for folder in child_folders],
        include_inactive=include_inactive,
    )
    attachment_map = load_attachment_map(db, child_documents)
    nodes = [
        _build_folder_node(folder, has_children=child_counts.get(folder.id, 0) > 0)
        for folder in child_folders
    ]
    nodes.extend(
        _build_document_node(
            document,
            attachment=attachment_map.get(document.attachment_id),
        )
        for document in child_documents
    )
    sorted_nodes = _sort_nodes(nodes)
    return DirectNodeList(
        items=sorted_nodes,
        total_available=total_available,
        has_more=offset + len(sorted_nodes) < total_available,
    )


def list_recursive_nodes(
    db,
    knowledge_base_id: int,
    folder_id: int,
    include_inactive: bool,
) -> tuple[list[ExternalKnowledgeNode], list[str]]:
    """List nodes recursively from root or a specific folder."""
    if folder_id != 0:
        return _list_recursive_subtree_nodes(
            db,
            knowledge_base_id=knowledge_base_id,
            folder_id=folder_id,
            include_inactive=include_inactive,
        )

    warnings: list[str] = []
    visited_folder_ids: set[int] = set()
    _raise_if_recursive_result_too_large(
        _count_recursive_candidates(
            db,
            knowledge_base_id=knowledge_base_id,
            include_inactive=include_inactive,
        )
    )

    folders = (
        db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == knowledge_base_id)
        .all()
    )
    documents = (
        db.query(KnowledgeDocument)
        .filter(*_document_filters(knowledge_base_id, include_inactive))
        .all()
    )
    attachment_map = load_attachment_map(db, documents)

    folder_by_id = {folder.id: folder for folder in folders}
    folders_by_parent: dict[int, list[KnowledgeFolder]] = {}
    documents_by_folder: dict[int, list[KnowledgeDocument]] = {}

    for folder in folders:
        folders_by_parent.setdefault(folder.parent_id or 0, []).append(folder)
    for document in documents:
        documents_by_folder.setdefault(document.folder_id or 0, []).append(document)

    def build_children(parent_id: int, path: set[int]) -> list[ExternalKnowledgeNode]:
        if len(path) > MAX_RECURSIVE_DEPTH:
            warnings.append(
                f"Max folder depth {MAX_RECURSIVE_DEPTH} exceeded at folder {parent_id}; subtree skipped"
            )
            return []

        nodes: list[ExternalKnowledgeNode] = []
        for folder in folders_by_parent.get(parent_id, []):
            if folder.id in path:
                warnings.append(
                    f"Cycle detected at folder {folder.id}; subtree skipped"
                )
                continue

            visited_folder_ids.add(folder.id)
            children = build_children(folder.id, path | {folder.id})
            nodes.append(
                _build_folder_node(
                    folder,
                    has_children=bool(children),
                    children=children,
                )
            )

        nodes.extend(
            _build_document_node(
                document,
                attachment=attachment_map.get(document.attachment_id),
            )
            for document in documents_by_folder.get(parent_id, [])
        )
        return _sort_nodes(nodes)

    root_nodes = build_children(folder_id, set())
    orphan_nodes: list[ExternalKnowledgeNode] = []
    orphan_folder_ids: set[int] = set()

    for folder in folders:
        parent_id = folder.parent_id or 0
        if parent_id and parent_id not in folder_by_id:
            warnings.append(f"Folder {folder.id} references missing parent {parent_id}")
            visited_folder_ids.add(folder.id)
            orphan_folder_ids.add(folder.id)
            children = build_children(folder.id, {folder.id})
            orphan_nodes.append(
                _build_folder_node(
                    folder,
                    has_children=bool(children),
                    children=children,
                    orphan=True,
                )
            )

    for folder in folders:
        if folder.id in visited_folder_ids or folder.id in orphan_folder_ids:
            continue
        warnings.append(
            f"Folder {folder.id} is not reachable from root; attached as orphan"
        )
        visited_folder_ids.add(folder.id)
        orphan_folder_ids.add(folder.id)
        children = build_children(folder.id, {folder.id})
        orphan_nodes.append(
            _build_folder_node(
                folder,
                has_children=bool(children),
                children=children,
                orphan=True,
            )
        )

    for document in documents:
        parent_id = document.folder_id or 0
        if parent_id and parent_id not in folder_by_id:
            warnings.append(
                f"Document {document.id} references missing folder {parent_id}"
            )
            orphan_nodes.append(
                _build_document_node(
                    document,
                    attachment=attachment_map.get(document.attachment_id),
                    orphan=True,
                )
            )

    return _sort_nodes(root_nodes + orphan_nodes), warnings


def count_nodes(nodes: list[ExternalKnowledgeNode]) -> int:
    """Count every node in a returned tree, including nested children."""
    return sum(1 + count_nodes(node.children) for node in nodes)


def _list_recursive_subtree_nodes(
    db,
    knowledge_base_id: int,
    folder_id: int,
    include_inactive: bool,
) -> tuple[list[ExternalKnowledgeNode], list[str]]:
    warnings: list[str] = []
    visited_folder_ids = {folder_id}
    folders_by_parent: dict[int, list[KnowledgeFolder]] = {}
    documents_by_folder: dict[int, list[KnowledgeDocument]] = {}
    current_folder_ids = [folder_id]
    returned_count = 0
    depth = 0

    while current_folder_ids:
        depth += 1
        if depth > MAX_RECURSIVE_DEPTH:
            warnings.append(
                f"Max folder depth {MAX_RECURSIVE_DEPTH} exceeded at folders {current_folder_ids}; subtree skipped"
            )
            break

        child_folders = (
            db.query(KnowledgeFolder)
            .filter(
                KnowledgeFolder.kind_id == knowledge_base_id,
                KnowledgeFolder.parent_id.in_(current_folder_ids),
            )
            .all()
        )
        child_documents = (
            db.query(KnowledgeDocument)
            .filter(
                *_document_filters(knowledge_base_id, include_inactive),
                KnowledgeDocument.folder_id.in_(current_folder_ids),
            )
            .all()
        )

        next_folder_ids: list[int] = []
        for folder in child_folders:
            parent_id = folder.parent_id or 0
            if folder.id in visited_folder_ids:
                warnings.append(f"Cycle detected at folder {folder.id}; edge skipped")
                continue
            visited_folder_ids.add(folder.id)
            folders_by_parent.setdefault(parent_id, []).append(folder)
            next_folder_ids.append(folder.id)

        for document in child_documents:
            documents_by_folder.setdefault(document.folder_id or 0, []).append(document)

        returned_count += len(next_folder_ids) + len(child_documents)
        _raise_if_recursive_result_too_large(returned_count)
        current_folder_ids = next_folder_ids

    all_documents = [
        document for documents in documents_by_folder.values() for document in documents
    ]
    attachment_map = load_attachment_map(db, all_documents)

    def build_children(parent_id: int) -> list[ExternalKnowledgeNode]:
        nodes: list[ExternalKnowledgeNode] = []
        for folder in folders_by_parent.get(parent_id, []):
            children = build_children(folder.id)
            nodes.append(
                _build_folder_node(
                    folder,
                    has_children=bool(children),
                    children=children,
                )
            )
        nodes.extend(
            _build_document_node(
                document,
                attachment=attachment_map.get(document.attachment_id),
            )
            for document in documents_by_folder.get(parent_id, [])
        )
        return _sort_nodes(nodes)

    return build_children(folder_id), warnings


def _document_index_status(document: KnowledgeDocument) -> Optional[str]:
    if document.index_status is None:
        return None
    return (
        document.index_status.value
        if hasattr(document.index_status, "value")
        else str(document.index_status)
    )


def _build_folder_node(
    folder: KnowledgeFolder,
    has_children: bool,
    children: Optional[list[ExternalKnowledgeNode]] = None,
    orphan: bool = False,
) -> ExternalKnowledgeNode:
    return ExternalKnowledgeNode(
        node_id=f"folder:{folder.id}",
        raw_id=folder.id,
        name=folder.name,
        node_type=ExternalKnowledgeNodeType.FOLDER,
        parent_id=folder.parent_id or 0,
        has_children=has_children,
        children=children or [],
        created_at=folder.created_at,
        updated_at=folder.updated_at,
        orphan=orphan,
    )


def _build_document_node(
    document: KnowledgeDocument,
    attachment=None,
    orphan: bool = False,
) -> ExternalKnowledgeNode:
    capabilities = build_document_capabilities(document, attachment)
    return ExternalKnowledgeNode(
        node_id=f"document:{document.id}",
        raw_id=document.id,
        name=document.name,
        node_type=ExternalKnowledgeNodeType.DOCUMENT,
        parent_id=document.folder_id or 0,
        source_type=document.source_type,
        index_status=_document_index_status(document),
        file_extension=capabilities.file_extension,
        content_readable=capabilities.content_readable,
        downloadable=capabilities.downloadable,
        previewable=capabilities.previewable,
        mime_type=capabilities.mime_type,
        file_size=capabilities.file_size,
        created_at=document.created_at,
        updated_at=document.updated_at,
        orphan=orphan,
    )


def _sort_nodes(nodes: list[ExternalKnowledgeNode]) -> list[ExternalKnowledgeNode]:
    sorted_by_time = sorted(
        nodes,
        key=lambda node: (node.created_at, node.raw_id),
        reverse=True,
    )
    return sorted(
        sorted_by_time,
        key=lambda node: 0 if node.node_type == ExternalKnowledgeNodeType.FOLDER else 1,
    )


def _get_children_counts(
    db,
    knowledge_base_id: int,
    folder_ids: list[int],
    include_inactive: bool,
) -> dict[int, int]:
    if not folder_ids:
        return {}

    result = {folder_id: 0 for folder_id in folder_ids}
    folder_counts = (
        db.query(KnowledgeFolder.parent_id, func.count(KnowledgeFolder.id))
        .filter(
            KnowledgeFolder.kind_id == knowledge_base_id,
            KnowledgeFolder.parent_id.in_(folder_ids),
        )
        .group_by(KnowledgeFolder.parent_id)
        .all()
    )
    for parent_id, count in folder_counts:
        result[parent_id] = result.get(parent_id, 0) + count

    doc_filters = [
        KnowledgeDocument.kind_id == knowledge_base_id,
        KnowledgeDocument.folder_id.in_(folder_ids),
    ]
    if not include_inactive:
        doc_filters.append(KnowledgeDocument.is_active == True)

    doc_counts = (
        db.query(KnowledgeDocument.folder_id, func.count(KnowledgeDocument.id))
        .filter(*doc_filters)
        .group_by(KnowledgeDocument.folder_id)
        .all()
    )
    for folder_id, count in doc_counts:
        result[folder_id] = result.get(folder_id, 0) + count

    return result


def _document_filters(
    knowledge_base_id: int,
    include_inactive: bool,
    folder_id: Optional[int] = None,
) -> list:
    filters = [KnowledgeDocument.kind_id == knowledge_base_id]
    if folder_id is not None:
        filters.append(KnowledgeDocument.folder_id == folder_id)
    if not include_inactive:
        filters.append(KnowledgeDocument.is_active == True)
    return filters


def _raise_if_recursive_result_too_large(total_nodes: int) -> None:
    if total_nodes > MAX_RECURSIVE_NODES:
        raise ExternalKnowledgeInputError(
            (
                f"Recursive result has {total_nodes} nodes, "
                f"which exceeds the limit of {MAX_RECURSIVE_NODES}"
            ),
            "result_too_large",
        )


def _count_recursive_candidates(
    db,
    knowledge_base_id: int,
    include_inactive: bool,
) -> int:
    folder_count = (
        db.query(func.count(KnowledgeFolder.id))
        .filter(KnowledgeFolder.kind_id == knowledge_base_id)
        .scalar()
        or 0
    )
    document_count = (
        db.query(func.count(KnowledgeDocument.id))
        .filter(*_document_filters(knowledge_base_id, include_inactive))
        .scalar()
        or 0
    )
    return folder_count + document_count
