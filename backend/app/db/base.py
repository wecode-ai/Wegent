# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SQLAlchemy declarative base for Backend.

Re-exports the shared Base to ensure all models use the same registry.
This is critical for SQLAlchemy relationship resolution between models
defined in shared and backend packages.
"""

from shared.models.db import Base

__all__ = ["Base"]
