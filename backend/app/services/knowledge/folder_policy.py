# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared folder-depth policy helpers for knowledge base document trees."""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import CustomHTTPException
from app.models.knowledge import KnowledgeFolder

# Knowledge base counts as level 1, so users can create at most 4 nested
# folder levels below it: KB -> folder1 -> folder2 -> folder3 -> folder4.
MAX_FOLDER_DEPTH = 4

FOLDER_DEPTH_EXCEEDED_MESSAGE = (
    "Folder hierarchy exceeds the maximum depth of 4 levels under a knowledge base"
)
DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE = "Documents can only be placed within the 4th folder level under a knowledge base or above"
FOLDER_DEPTH_EXCEEDED_ERROR_CODE = "KNOWLEDGE_FOLDER_DEPTH_EXCEEDED"
DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE = (
    "KNOWLEDGE_DOCUMENT_TARGET_FOLDER_DEPTH_EXCEEDED"
)


def get_folder_depth(
    db: Session,
    kind_id: int,
    folder_id: int,
    *,
    folder_map: Optional[Dict[int, KnowledgeFolder]] = None,
) -> int:
    """Return folder depth counting the first folder under KB as depth 1."""
    if folder_id <= 0:
        return 0

    depth = 0
    current_id = folder_id
    visited_ids: set[int] = set()

    while current_id > 0:
        if current_id in visited_ids:
            raise ValueError(
                f"Folder {current_id} has a parent cycle and cannot be traversed safely"
            )
        visited_ids.add(current_id)
        current_folder = folder_map.get(current_id) if folder_map is not None else None
        if current_folder is None:
            current_folder = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.kind_id == kind_id,
                    KnowledgeFolder.id == current_id,
                )
                .first()
            )
        if current_folder is None:
            raise ValueError(f"Folder {current_id} not found in this knowledge base")
        depth += 1
        current_id = current_folder.parent_id

    return depth


def validate_new_folder_depth(
    db: Session,
    kind_id: int,
    parent_id: int,
    *,
    folder_map: Optional[Dict[int, KnowledgeFolder]] = None,
) -> None:
    """Validate folder depth for a new folder under the given parent.

    Args:
        db: Active database session.
        kind_id: Knowledge base identifier that owns the folder tree.
        parent_id: Parent folder identifier, or 0 for the knowledge base root.
        folder_map: Optional in-memory folder lookup used to avoid extra queries.

    Returns:
        None.

    Raises:
        ValueError: Raised with FOLDER_DEPTH_EXCEEDED_MESSAGE when the new folder
            would exceed the maximum allowed folder depth.
    """
    parent_depth = get_folder_depth(db, kind_id, parent_id, folder_map=folder_map)
    new_depth = parent_depth + 1
    if new_depth > MAX_FOLDER_DEPTH:
        raise CustomHTTPException(
            status_code=400,
            detail=FOLDER_DEPTH_EXCEEDED_MESSAGE,
            error_code=FOLDER_DEPTH_EXCEEDED_ERROR_CODE,
        )


def validate_document_target_folder_depth(
    db: Session,
    kind_id: int,
    folder_id: int,
    *,
    folder_map: Optional[Dict[int, KnowledgeFolder]] = None,
) -> None:
    """Validate folder depth for a document target folder.

    Args:
        db: Active database session.
        kind_id: Knowledge base identifier that owns the folder tree.
        folder_id: Target folder identifier, or 0 for the knowledge base root.
        folder_map: Optional in-memory folder lookup used to avoid extra queries.

    Returns:
        None.

    Raises:
        ValueError: Raised with DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE when the
            target folder exceeds the maximum allowed folder depth.
    """
    target_depth = get_folder_depth(db, kind_id, folder_id, folder_map=folder_map)
    if target_depth > MAX_FOLDER_DEPTH:
        raise CustomHTTPException(
            status_code=400,
            detail=DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE,
            error_code=DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE,
        )


def assert_document_can_be_placed_in_folder(
    db: Session,
    kind_id: int,
    folder_id: int,
) -> Optional[KnowledgeFolder]:
    """Validate that a document can be placed in the target folder.

    Returns the folder row when folder_id > 0 so callers can reuse it if needed.
    Only folder_id == 0 is treated as the knowledge base root and returns None.
    Negative folder IDs are invalid and also return None for callers that treat
    them as a rejected target.
    """
    if folder_id < 0:
        return None

    if folder_id == 0:
        return None

    folder = (
        db.query(KnowledgeFolder)
        .filter(
            KnowledgeFolder.id == folder_id,
            KnowledgeFolder.kind_id == kind_id,
        )
        .first()
    )
    if folder is None:
        raise ValueError(f"Folder {folder_id} not found in this knowledge base")

    validate_document_target_folder_depth(db, kind_id, folder.id)
    return folder


def get_subtree_max_relative_depth(
    folder_map: Dict[int, KnowledgeFolder], root_folder_id: int
) -> int:
    """Return max depth inside a subtree counting root folder as depth 1."""
    children_map: Dict[int, List[int]] = defaultdict(list)
    for folder in folder_map.values():
        children_map[folder.parent_id].append(folder.id)

    max_depth = 1
    queue = deque([(root_folder_id, 1)])
    visited_ids: set[int] = set()
    while queue:
        current_id, depth = queue.popleft()
        if current_id in visited_ids:
            raise ValueError(
                f"Folder {current_id} has a parent cycle and cannot be traversed safely"
            )
        visited_ids.add(current_id)
        max_depth = max(max_depth, depth)
        for child_id in children_map.get(current_id, []):
            queue.append((child_id, depth + 1))
    return max_depth
