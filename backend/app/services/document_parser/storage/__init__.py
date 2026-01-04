# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage Package

Provides storage services for extracted images during document parsing.
"""

from app.services.document_parser.storage.base import BaseStorageService
from app.services.document_parser.storage.local_storage import LocalStorageService

__all__ = [
    "BaseStorageService",
    "LocalStorageService",
]
