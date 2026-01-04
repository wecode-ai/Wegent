# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OCR Package

Provides OCR and vision services for image text extraction and description.
"""

from app.services.document_parser.ocr.base import BaseOCRService
from app.services.document_parser.ocr.mock_ocr import MockOCRService

__all__ = [
    "BaseOCRService",
    "MockOCRService",
]
