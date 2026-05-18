# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User database model.

Re-exported from shared package for backward compatibility.
The User model is extended here with Backend-specific relationships.
"""

from shared.models.db import User

__all__ = ["User"]
