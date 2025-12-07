# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment service module for file upload and document parsing.
"""

from app.services.attachment.attachment_service import attachment_service
from app.services.attachment.parser import DocumentParser

__all__ = ["DocumentParser", "attachment_service"]
