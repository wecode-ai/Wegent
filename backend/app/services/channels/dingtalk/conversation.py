# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk conversation protocol values."""

from enum import Enum


class DingTalkConversationType(str, Enum):
    """Names for DingTalk's numeric conversationType callback values."""

    PRIVATE = "1"
    GROUP = "2"
