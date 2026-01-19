# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for memory utility functions."""

import re

import pytest

from app.services.memory.schemas import MemorySearchResult
from app.services.memory.utils import inject_memories_to_prompt


def test_inject_memories_to_prompt_with_dates():
    """Test injecting memories with timestamps in local timezone."""
    memories = [
        MemorySearchResult(
            id="mem-1",
            memory="User prefers Python over JavaScript",
            metadata={},
            created_at="2025-01-15T10:30:00Z",
        ),
        MemorySearchResult(
            id="mem-2",
            memory="Project uses FastAPI framework",
            metadata={},
            created_at="2025-01-14T15:20:00Z",
        ),
    ]

    base_prompt = "You are a helpful coding assistant."
    result = inject_memories_to_prompt(base_prompt, memories)

    # Check structure
    assert result.startswith("<memory>")
    assert "relevant memories from previous conversations" in result
    assert "</memory>" in result
    assert base_prompt in result

    # Check content with local timezone format (includes date and timezone suffix)
    # Pattern: [YYYY-MM-DD HH:MM:SS TZ] where TZ can be CST, UTC, PST, etc.
    datetime_pattern = r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{3,4}\]"
    matches = re.findall(datetime_pattern, result)
    assert len(matches) == 2, f"Expected 2 timestamps, found {len(matches)}: {matches}"

    # Check memory content is present
    assert "User prefers Python over JavaScript" in result
    assert "Project uses FastAPI framework" in result

    # Check ordering
    assert result.index("1.") < result.index("2.")
    assert result.index("</memory>") < result.index(base_prompt)


def test_inject_memories_to_prompt_without_dates():
    """Test injecting memories without timestamps."""
    memories = [
        MemorySearchResult(id="mem-1", memory="User likes clean code", metadata={}),
        MemorySearchResult(
            id="mem-2", memory="Prefers type hints", metadata={}, created_at=None
        ),
    ]

    base_prompt = "You are an assistant."
    result = inject_memories_to_prompt(base_prompt, memories)

    # Check that memories are included without dates
    assert "User likes clean code" in result
    assert "Prefers type hints" in result

    # Should not have datetime-bracket patterns like [YYYY-MM-DD HH:MM:SS TZ]
    datetime_pattern = r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( [A-Z]{3,4})?\]"
    assert not re.search(
        datetime_pattern, result
    ), "Should not contain datetime brackets when created_at is missing"

    # Verify <memory> tags are present
    assert result.count("<memory>") == 1
    assert result.count("</memory>") == 1


def test_inject_memories_to_prompt_empty():
    """Test injecting empty memory list."""
    memories = []
    base_prompt = "You are a helpful assistant."

    result = inject_memories_to_prompt(base_prompt, memories)

    # Should return unchanged prompt
    assert result == base_prompt
    assert "<memory>" not in result


def test_inject_memories_to_prompt_invalid_date():
    """Test handling of invalid date format."""
    memories = [
        MemorySearchResult(
            id="mem-1",
            memory="Test memory",
            metadata={},
            created_at="invalid-date-format",
        )
    ]

    base_prompt = "You are an assistant."
    result = inject_memories_to_prompt(base_prompt, memories)

    # Should still include the memory, just without formatted date
    assert "Test memory" in result
    assert "<memory>" in result
