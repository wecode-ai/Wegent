# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared validators for knowledge scope fields."""

from typing import Optional


def validate_folder_ids(folder_ids: Optional[list[int]]) -> Optional[list[int]]:
    """Validate and deduplicate folder IDs while preserving order."""
    if folder_ids is None:
        return None
    if not folder_ids:
        raise ValueError("folder_ids must not be empty")
    if any(folder_id < 0 for folder_id in folder_ids):
        raise ValueError("folder_ids must contain non-negative integers")
    return list(dict.fromkeys(folder_ids))


def validate_document_ids(document_ids: Optional[list[int]]) -> Optional[list[int]]:
    """Validate and deduplicate document IDs while preserving order."""
    if document_ids is None:
        return None
    if not document_ids:
        raise ValueError("document_ids must not be empty")
    if any(document_id < 1 for document_id in document_ids):
        raise ValueError("document_ids must contain positive integers")
    return list(dict.fromkeys(document_ids))
