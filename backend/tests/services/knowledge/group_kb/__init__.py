# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for group knowledge base permission system.

This package contains all tests for the group knowledge base permissions feature.
"""

from .test_group_kb_crud import (
    TestCreateDocument,
    TestCreateKnowledgeBase,
    TestDeleteDocument,
    TestDeleteKnowledgeBase,
    TestUpdateDocument,
    TestUpdateKnowledgeBase,
)
from .test_group_kb_inheritance import TestPermissionInheritance
from .test_group_kb_mapping import TestPermissionLevelMapping

# Export all test classes for pytest discovery
__all__ = [
    "TestPermissionLevelMapping",
    "TestCreateKnowledgeBase",
    "TestUpdateKnowledgeBase",
    "TestDeleteKnowledgeBase",
    "TestCreateDocument",
    "TestUpdateDocument",
    "TestDeleteDocument",
    "TestPermissionInheritance",
]
