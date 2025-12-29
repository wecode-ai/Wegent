# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat preprocessing module.

This module handles message preprocessing before sending to AI:
- Attachment processing (documents, images)
- Message transformation
"""

from .attachments import process_attachments

__all__ = [
    "process_attachments",
]
