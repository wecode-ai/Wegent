# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Structure recognizers for document analysis."""

from .patterns import (
    BLOCKQUOTE_PATTERNS,
    CODE_BLOCK_PATTERNS,
    DEFINITION_PATTERNS,
    FLOW_PATTERNS,
    HEADING_PATTERNS,
    LIST_PATTERNS,
    QA_PATTERNS,
    TABLE_PATTERNS,
)
from .structure_recognizer import StructureRecognizer

__all__ = [
    "BLOCKQUOTE_PATTERNS",
    "CODE_BLOCK_PATTERNS",
    "DEFINITION_PATTERNS",
    "FLOW_PATTERNS",
    "HEADING_PATTERNS",
    "LIST_PATTERNS",
    "QA_PATTERNS",
    "StructureRecognizer",
    "TABLE_PATTERNS",
]
