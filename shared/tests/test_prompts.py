# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for shared prompts module.

Tests that KB prompt constants are properly exported and accessible.
"""

import pytest


class TestKBPromptConstants:
    """Test KB prompt constant exports."""

    def test_kb_prompt_strict_importable(self):
        """Should be able to import KB_PROMPT_STRICT from shared.prompts."""
        from shared.prompts import KB_PROMPT_STRICT

        assert KB_PROMPT_STRICT is not None
        assert isinstance(KB_PROMPT_STRICT, str)
        assert len(KB_PROMPT_STRICT) > 0

    def test_kb_prompt_relaxed_importable(self):
        """Should be able to import KB_PROMPT_RELAXED from shared.prompts."""
        from shared.prompts import KB_PROMPT_RELAXED

        assert KB_PROMPT_RELAXED is not None
        assert isinstance(KB_PROMPT_RELAXED, str)
        assert len(KB_PROMPT_RELAXED) > 0

    def test_kb_prompt_strict_contains_required_content(self):
        """KB_PROMPT_STRICT should contain strict mode instructions."""
        from shared.prompts import KB_PROMPT_STRICT

        # Check for key phrases in strict mode
        assert "MUST use" in KB_PROMPT_STRICT
        assert "knowledge_base_search" in KB_PROMPT_STRICT
        assert "ONLY" in KB_PROMPT_STRICT or "only" in KB_PROMPT_STRICT

    def test_kb_prompt_relaxed_contains_required_content(self):
        """KB_PROMPT_RELAXED should contain relaxed mode instructions."""
        from shared.prompts import KB_PROMPT_RELAXED

        # Check for key phrases in relaxed mode
        assert "knowledge_base_search" in KB_PROMPT_RELAXED
        assert (
            "general knowledge" in KB_PROMPT_RELAXED or "fallback" in KB_PROMPT_RELAXED
        )

    def test_prompts_are_different(self):
        """Strict and relaxed prompts should be different."""
        from shared.prompts import KB_PROMPT_RELAXED, KB_PROMPT_STRICT

        assert KB_PROMPT_STRICT != KB_PROMPT_RELAXED

    def test_prompts_module_all_export(self):
        """shared.prompts module should export KB_PROMPT_STRICT and KB_PROMPT_RELAXED in __all__."""
        from shared import prompts

        assert hasattr(prompts, "__all__")
        assert "KB_PROMPT_STRICT" in prompts.__all__
        assert "KB_PROMPT_RELAXED" in prompts.__all__
