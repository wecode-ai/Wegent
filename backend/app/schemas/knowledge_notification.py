# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge notification schemas for webhook events.
"""

from enum import Enum


class KnowledgeNotificationType(str, Enum):
    """Knowledge base notification event types."""

    PERMISSION_GRANTED = "knowledge.permission.granted"
    PERMISSION_UPDATED = "knowledge.permission.updated"
    PERMISSION_REVOKED = "knowledge.permission.revoked"
    # Permission request events
    PERMISSION_REQUEST_SUBMITTED = "knowledge.permission_request.submitted"
    PERMISSION_REQUEST_APPROVED = "knowledge.permission_request.approved"
    PERMISSION_REQUEST_REJECTED = "knowledge.permission_request.rejected"
