# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for PromptBuilder module."""

import pytest

from shared.utils.prompt_builder import PromptBuilder, build_prompt


class TestPromptBuilder:
    """Test cases for PromptBuilder class."""

    def test_base_with_default_level(self):
        """Test base prompt with default target level."""
        builder = PromptBuilder()
        result = builder.base("# Title\n## Subtitle").build()
        # Default level is 2, so # becomes ##, ## becomes ###
        assert "## Title" in result
        assert "### Subtitle" in result

    def test_base_with_custom_level(self):
        """Test base prompt with custom target level."""
        builder = PromptBuilder(default_target_level=3)
        result = builder.base("# Title").build()
        assert "### Title" in result

    def test_base_with_explicit_level(self):
        """Test base prompt with explicit target level."""
        builder = PromptBuilder()
        result = builder.base("# Title", target_level=1).build()
        assert "# Title" in result
        assert "## Title" not in result

    def test_append_section(self):
        """Test appending a section to the prompt."""
        builder = PromptBuilder()
        result = builder.base("# Base").append("# Section").build()
        assert "## Base" in result
        assert "## Section" in result

    def test_append_empty_section(self):
        """Test appending empty content is ignored."""
        builder = PromptBuilder()
        result = builder.base("# Base").append("").append("   ").build()
        # Empty sections should not affect the output
        assert result.strip() == "## Base"

    def test_append_if_true(self):
        """Test conditional append when condition is True."""
        builder = PromptBuilder()
        result = builder.base("# Base").append_if(True, "# Conditional Section").build()
        assert "## Base" in result
        assert "## Conditional Section" in result

    def test_append_if_false(self):
        """Test conditional append when condition is False."""
        builder = PromptBuilder()
        result = builder.base("# Base").append_if(False, "# Should Not Appear").build()
        assert "## Base" in result
        assert "Should Not Appear" not in result

    def test_append_with_header(self):
        """Test appending content with a custom header."""
        builder = PromptBuilder()
        result = (
            builder.base("# Base")
            .append_with_header(
                "### Skill: test_skill", "# Skill Content\nDetails here", 4
            )
            .build()
        )
        assert "## Base" in result
        assert "### Skill: test_skill" in result
        # Skill content heading level remapped to 4
        assert "#### Skill Content" in result

    def test_append_formatted(self):
        """Test appending a formatted template."""
        template = "# Section\n\nItems: {item_list}"
        builder = PromptBuilder()
        result = (
            builder.base("# Base")
            .append_formatted(template, item_list="- Item A\n- Item B")
            .build()
        )
        assert "## Base" in result
        assert "## Section" in result
        assert "- Item A" in result
        assert "- Item B" in result

    def test_chained_operations(self):
        """Test chaining multiple operations."""
        result = (
            PromptBuilder()
            .base("# Main")
            .append("# First")
            .append_if(True, "# Second")
            .append_if(False, "# Skip")
            .append("# Third")
            .build()
        )
        assert "## Main" in result
        assert "## First" in result
        assert "## Second" in result
        assert "Skip" not in result
        assert "## Third" in result

    def test_reset(self):
        """Test resetting the builder."""
        builder = PromptBuilder()
        builder.base("# First").append("# Section")
        builder.reset()
        result = builder.base("# New").build()
        assert "First" not in result
        assert "Section" not in result
        assert "## New" in result

    def test_no_headings_passthrough(self):
        """Test that text without headings passes through unchanged."""
        builder = PromptBuilder()
        result = builder.base("Plain text content").build()
        assert result == "Plain text content"

    def test_different_target_levels_per_section(self):
        """Test different target levels for different sections."""
        result = (
            PromptBuilder()
            .base("# Base", target_level=2)
            .append("# First", target_level=3)
            .append("# Second", target_level=4)
            .build()
        )
        assert "## Base" in result
        assert "### First" in result
        assert "#### Second" in result


class TestBuildPromptFunction:
    """Test cases for build_prompt convenience function."""

    def test_basic_build(self):
        """Test basic prompt building."""
        result = build_prompt("# Base", "# Section A")
        assert "## Base" in result
        assert "## Section A" in result

    def test_with_tuple_sections(self):
        """Test building with tuple sections for custom levels."""
        result = build_prompt("# Base", ("# Deep Section", 4))
        assert "## Base" in result
        assert "#### Deep Section" in result

    def test_mixed_sections(self):
        """Test building with mixed string and tuple sections."""
        result = build_prompt("# Base", "# Normal", ("# Deep", 3), default_level=2)
        assert "## Base" in result
        assert "## Normal" in result
        assert "### Deep" in result

    def test_custom_default_level(self):
        """Test custom default level for all sections."""
        result = build_prompt("# Base", "# Section", default_level=3)
        assert "### Base" in result
        assert "### Section" in result


class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_heading_level_clamping_max(self):
        """Test that heading levels are clamped to 6."""
        builder = PromptBuilder()
        # Original level 5, remapped to 6, +2 offset would be 7, clamped to 6
        result = builder.base("##### Deep heading", target_level=6).build()
        assert "###### Deep heading" in result

    def test_heading_level_clamping_min(self):
        """Test that heading levels are clamped to 1."""
        builder = PromptBuilder()
        result = builder.base("### Some heading", target_level=1).build()
        assert "# Some heading" in result

    def test_preserve_content_after_heading(self):
        """Test that content after headings is preserved."""
        content = "# Title\n\nParagraph text here.\n\n## Subtitle\n\nMore text."
        builder = PromptBuilder()
        result = builder.base(content).build()
        assert "Paragraph text here." in result
        assert "More text." in result

    def test_preserve_indented_headings(self):
        """Test handling of indented headings."""
        content = "  # Indented Title"
        builder = PromptBuilder()
        result = builder.base(content).build()
        # Indentation should be preserved
        assert "  ## Indented Title" in result

    def test_empty_base(self):
        """Test building with empty base."""
        result = PromptBuilder().append("# Section").build()
        assert "## Section" in result

    def test_only_append_operations(self):
        """Test building with only append operations (no base)."""
        result = PromptBuilder().append("# First").append("# Second").build()
        assert "## First" in result
        assert "## Second" in result
