# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Table providers package.

Import all providers to ensure they are registered with TableProviderRegistry.
"""

# Import providers to trigger registration
from .dingtalk import DingTalkProvider  # noqa: F401

__all__ = ["DingTalkProvider"]
