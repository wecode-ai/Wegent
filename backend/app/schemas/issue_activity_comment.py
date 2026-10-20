# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Comment views with the activity cursor used by Issue subscriptions."""

from app.schemas.delivery import LoopItemCommentResponse


class IssueActivityCommentResponse(LoopItemCommentResponse):
    sequence_number: int
