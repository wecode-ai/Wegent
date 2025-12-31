# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document Parser Module

This module provides document parsing functionality to convert uploaded documents
into structured Block format for preview, editing, and RAG/vectorization support.

Supported formats:
- Markdown (.md)
- PDF (.pdf)
- Word Documents (.docx)
- Images (.png, .jpg, .jpeg, .gif, .bmp, .webp)
"""

from app.services.document_parser.base import BaseParser
from app.services.document_parser.factory import ParserFactory

__all__ = [
    "BaseParser",
    "ParserFactory",
]
