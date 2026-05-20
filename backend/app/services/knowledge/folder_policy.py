# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared folder-depth policy helpers for knowledge base document trees."""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeFolder

# Knowledge base counts as level 1, so users can create at most 4 nested
# folder levels below it: KB -> folder1 -> folder2 -> folder3 -> folder4.
MAX_FOLDER_DEPTH = 4

FOLDER_DEPTH_EXCEEDED_MESSAGE = (
    "Folder hierarchy exceeds the maximum depth of 4 levels under a knowledge base"
)
DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE = "Documents can only be placed within the 4th folder level under a knowledge base or above"


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

    while current_id > 0:
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
    parent_depth = get_folder_depth(db, kind_id, parent_id, folder_map=folder_map)
    new_depth = parent_depth + 1
    if new_depth > MAX_FOLDER_DEPTH:
        raise ValueError(FOLDER_DEPTH_EXCEEDED_MESSAGE)


def validate_document_target_folder_depth(
    db: Session,
    kind_id: int,
    folder_id: int,
    *,
    folder_map: Optional[Dict[int, KnowledgeFolder]] = None,
) -> None:
    target_depth = get_folder_depth(db, kind_id, folder_id, folder_map=folder_map)
    if target_depth > MAX_FOLDER_DEPTH:
        raise ValueError(DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE)


def assert_document_can_be_placed_in_folder(
    db: Session,
    kind_id: int,
    folder_id: int,
) -> Optional[KnowledgeFolder]:
    """Validate that a document can be placed in the target folder.

    Returns the folder row when folder_id > 0 so callers can reuse it if needed.
    Root placement (folder_id == 0) is always allowed and returns None.
    """
    if folder_id <= 0:
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
    while queue:
        current_id, depth = queue.popleft()
        max_depth = max(max_depth, depth)
        for child_id in children_map.get(current_id, []):
            queue.append((child_id, depth + 1))
    return max_depth
