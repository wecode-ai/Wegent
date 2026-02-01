# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Skill dependency validation
"""
from typing import Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from app.services.skill_service import SkillDependencyValidator


class MockKind:
    """Mock Kind model for testing."""

    def __init__(self, name: str, dependencies: Optional[List[str]] = None):
        self.name = name
        self.json = {
            "spec": {
                "dependencies": dependencies,
            }
        }


def create_mock_find_skill(skills: Dict[str, Optional[List[str]]]):
    """
    Create a mock find_skill function.

    Args:
        skills: Dict mapping skill_name -> dependencies list (or None for no deps)

    Returns:
        Mock function that returns MockKind for existing skills, None for missing
    """

    def find_skill(name: str, db, user_id: int, namespace: str):
        if name in skills:
            return MockKind(name, skills[name])
        return None

    return find_skill


@pytest.mark.unit
class TestSkillDependencyValidator:
    """Test SkillDependencyValidator class"""

    def test_validate_no_dependencies(self):
        """Test validation passes when skill has no dependencies."""
        find_skill = create_mock_find_skill({"skill-a": None})

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=[],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is None

    def test_validate_all_dependencies_exist(self):
        """Test validation passes when all dependencies exist."""
        find_skill = create_mock_find_skill(
            {
                "skill-a": ["skill-b"],
                "skill-b": None,
                "skill-c": None,
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-b", "skill-c"],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is None

    def test_validate_missing_dependencies(self):
        """Test validation detects missing dependencies."""
        find_skill = create_mock_find_skill(
            {
                "skill-a": None,
                "skill-b": None,
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-b", "skill-c", "skill-d"],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert set(missing) == {"skill-c", "skill-d"}
        assert circular is None

    def test_validate_circular_dependency_direct(self):
        """Test detection of direct circular dependency (A -> B -> A)."""
        find_skill = create_mock_find_skill(
            {
                "skill-a": ["skill-b"],  # A depends on B
                "skill-b": ["skill-a"],  # B depends on A (circular!)
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-b"],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is not None
        # Circular chain should show the cycle
        assert "skill-a" in circular
        assert "skill-b" in circular

    def test_validate_circular_dependency_indirect(self):
        """Test detection of indirect circular dependency (A -> B -> C -> A)."""
        find_skill = create_mock_find_skill(
            {
                "skill-a": ["skill-b"],  # A depends on B
                "skill-b": ["skill-c"],  # B depends on C
                "skill-c": ["skill-a"],  # C depends on A (circular!)
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-b"],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is not None
        # All three skills should be in the cycle
        assert "skill-a" in circular
        assert "skill-b" in circular
        assert "skill-c" in circular

    def test_validate_self_dependency(self):
        """Test detection of self-referential dependency (A -> A)."""
        find_skill = create_mock_find_skill(
            {
                "skill-a": None,  # Will be overridden by the new dependencies
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-a"],  # Self-reference!
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is not None
        assert circular == ["skill-a", "skill-a"]

    def test_validate_deep_dependency_chain(self):
        """Test validation of deep dependency chain (no cycle)."""
        # A -> B -> C -> D (linear chain, no cycle)
        find_skill = create_mock_find_skill(
            {
                "skill-a": ["skill-b"],
                "skill-b": ["skill-c"],
                "skill-c": ["skill-d"],
                "skill-d": None,
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-b"],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is None

    def test_validate_diamond_dependency(self):
        """Test diamond dependency pattern (A -> B, A -> C, B -> D, C -> D)."""
        # This is valid (not circular):
        #       A
        #      / \
        #     B   C
        #      \ /
        #       D
        find_skill = create_mock_find_skill(
            {
                "skill-a": ["skill-b", "skill-c"],
                "skill-b": ["skill-d"],
                "skill-c": ["skill-d"],
                "skill-d": None,
            }
        )

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=["skill-b", "skill-c"],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is None

    def test_validate_none_dependencies_treated_as_empty(self):
        """Test that None dependencies is handled by the caller (not by validator)."""
        # Note: In actual usage, _validate_skill_dependencies in skill_kinds.py
        # checks `if not dependencies` before calling validate_dependencies.
        # This test verifies the behavior when empty list is passed.
        find_skill = create_mock_find_skill({"skill-a": None})

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=[],  # Empty list instead of None
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is None

    def test_validate_empty_dependencies_list(self):
        """Test validation with explicit empty dependencies list."""
        find_skill = create_mock_find_skill({"skill-a": []})

        missing, circular = SkillDependencyValidator.validate_dependencies(
            skill_name="skill-a",
            dependencies=[],
            find_skill_func=find_skill,
            db=MagicMock(),
            user_id=1,
            namespace="default",
        )

        assert missing == []
        assert circular is None
