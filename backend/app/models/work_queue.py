# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Work Queue models for backend.

Re-exports models from shared/models/db for convenience.
"""

from shared.models.db.enums import (
    QueueMessagePriority,
    QueueMessageStatus,
    QueueVisibility,
    TriggerMode,
)
from shared.models.db.work_queue import QueueMessage, RecentContact

__all__ = [
    "QueueMessage",
    "RecentContact",
    "QueueVisibility",
    "QueueMessageStatus",
    "QueueMessagePriority",
    "TriggerMode",
]
