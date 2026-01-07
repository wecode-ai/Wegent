# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User database model.

Re-exported from shared package for backward compatibility.
The User model is extended here with Backend-specific relationships.
"""

from shared.models.db import User
from sqlalchemy.orm import relationship

# Add Backend-specific relationships to User model
# Note: This modifies the shared User class to add relationships
# that only make sense in the Backend context
User.shared_tasks = relationship(
    "SharedTask", foreign_keys="[SharedTask.user_id]", back_populates="user"
)

__all__ = ["User"]
