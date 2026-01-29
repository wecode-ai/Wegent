# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KB prompt deduplication logic.

These tests verify that KB prompts are not duplicated when Backend already adds them
to the system prompt before calling chat_shell in HTTP mode.
"""

from unittest.mock import MagicMock, patch

import pytest


class TestKBPromptMarkerDetection:
    """Test KB prompt marker detection logic."""

    def setup_method(self):
        """Set up test fixtures."""
        # Import here to avoid import issues in non-package tests
        from chat_shell.interface import ChatRequest
        from chat_shell.services.context import ChatContext

        self.ChatContext = ChatContext
        self.ChatRequest = ChatRequest

    def _create_context(self, system_prompt: str = "") -> "ChatContext":
        """Create ChatContext with given system prompt."""
        request = MagicMock()
        request.system_prompt = system_prompt
        request.knowledge_base_ids = [1, 2]
        request.user_id = 1
        request.task_id = 1
        request.subtask_id = 1
        request.user_subtask_id = 1
        request.is_user_selected_kb = True
        request.document_ids = None
        request.model_config = None
        return self.ChatContext(request)

    @patch("chat_shell.services.context.settings")
    def test_skip_when_strict_marker_present_http_mode(self, mock_settings):
        """Should skip KB prompt enhancement when strict marker present in HTTP mode."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.STORAGE_TYPE = "remote"

        context = self._create_context(
            system_prompt="Base prompt\n## Knowledge Base Requirement\nKB instructions"
        )
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is True

    @patch("chat_shell.services.context.settings")
    def test_skip_when_relaxed_marker_present_http_mode(self, mock_settings):
        """Should skip KB prompt enhancement when relaxed marker present in HTTP mode."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.STORAGE_TYPE = "remote"

        context = self._create_context(
            system_prompt="Base prompt\n## Knowledge Base Available\nKB instructions"
        )
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is True

    @patch("chat_shell.services.context.settings")
    def test_skip_when_old_strict_marker_present_http_mode(self, mock_settings):
        """Should skip KB prompt enhancement when old strict marker present."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.STORAGE_TYPE = "remote"

        context = self._create_context(
            system_prompt="Base prompt\n# IMPORTANT: Knowledge Base Requirement\nKB instructions"
        )
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is True

    @patch("chat_shell.services.context.settings")
    def test_skip_when_old_relaxed_marker_present_http_mode(self, mock_settings):
        """Should skip KB prompt enhancement when old relaxed marker present."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.STORAGE_TYPE = "remote"

        context = self._create_context(
            system_prompt="Base prompt\n# Knowledge Base Available\nKB instructions"
        )
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is True

    @patch("chat_shell.services.context.settings")
    def test_no_skip_without_marker_http_mode(self, mock_settings):
        """Should not skip KB prompt enhancement when no marker present in HTTP mode."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.STORAGE_TYPE = "remote"

        context = self._create_context(system_prompt="Base prompt without KB marker")
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is False

    @patch("chat_shell.services.context.settings")
    def test_no_skip_in_package_mode(self, mock_settings):
        """Should not skip KB prompt enhancement in package mode (non-HTTP)."""
        mock_settings.CHAT_SHELL_MODE = "package"
        mock_settings.STORAGE_TYPE = "local"

        context = self._create_context(
            system_prompt="Base prompt\n## Knowledge Base Requirement\nKB instructions"
        )
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is False

    @patch("chat_shell.services.context.settings")
    def test_no_skip_with_http_mode_but_local_storage(self, mock_settings):
        """Should not skip when HTTP mode but local storage."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.STORAGE_TYPE = "local"

        context = self._create_context(
            system_prompt="Base prompt\n## Knowledge Base Requirement\nKB instructions"
        )
        result = context._should_skip_kb_prompt_enhancement(
            context._request.system_prompt
        )

        assert result is False


class TestKBPromptMarkdownLevel:
    """Test that KB prompts use correct Markdown heading level (##)."""

    def test_chat_shell_strict_prompt_uses_h2(self):
        """KB_PROMPT_STRICT should use ## for main heading."""
        from chat_shell.prompts import KB_PROMPT_STRICT

        # Should start with ## (H2) not # (H1)
        assert "## Knowledge Base Requirement" in KB_PROMPT_STRICT
        assert "# IMPORTANT:" not in KB_PROMPT_STRICT
        # Sub-sections should use ### (H3)
        assert "### Required Workflow:" in KB_PROMPT_STRICT
        assert "### Critical Rules:" in KB_PROMPT_STRICT

    def test_chat_shell_relaxed_prompt_uses_h2(self):
        """KB_PROMPT_RELAXED should use ## for main heading."""
        from chat_shell.prompts import KB_PROMPT_RELAXED

        # Should start with ## (H2) not # (H1)
        assert "## Knowledge Base Available" in KB_PROMPT_RELAXED
        # Sub-sections should use ### (H3)
        assert "### Recommended Workflow:" in KB_PROMPT_RELAXED
        assert "### Guidelines:" in KB_PROMPT_RELAXED


class TestKnowledgeFactorySkipPromptEnhancement:
    """Test skip_prompt_enhancement parameter in knowledge_factory."""

    @pytest.mark.asyncio
    async def test_skip_prompt_enhancement_returns_base_prompt(self):
        """When skip_prompt_enhancement=True, should return base_system_prompt unchanged."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "This is the base system prompt."
        kb_ids = [1, 2]

        # Mock the KnowledgeBaseTool import in knowledge_factory
        with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool_class:
            mock_kb_tool_class.return_value = MagicMock()

            tools, enhanced_prompt = await prepare_knowledge_base_tools(
                knowledge_base_ids=kb_ids,
                user_id=1,
                db=MagicMock(),
                base_system_prompt=base_prompt,
                skip_prompt_enhancement=True,
            )

            # Should return KB tool but not modify prompt
            assert len(tools) == 1
            assert enhanced_prompt == base_prompt
            # Should NOT contain KB prompt markers
            assert "## Knowledge Base Requirement" not in enhanced_prompt
            assert "## Knowledge Base Available" not in enhanced_prompt

    @pytest.mark.asyncio
    async def test_no_skip_prompt_enhancement_adds_kb_prompt(self):
        """When skip_prompt_enhancement=False, should add KB prompt."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "This is the base system prompt."
        kb_ids = [1, 2]

        # Mock the KnowledgeBaseTool import in knowledge_factory
        with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool_class:
            mock_kb_tool_class.return_value = MagicMock()

            tools, enhanced_prompt = await prepare_knowledge_base_tools(
                knowledge_base_ids=kb_ids,
                user_id=1,
                db=MagicMock(),
                base_system_prompt=base_prompt,
                skip_prompt_enhancement=False,
                is_user_selected=True,
            )

            # Should return KB tool and add prompt
            assert len(tools) == 1
            # Should contain KB prompt marker (strict mode because is_user_selected=True)
            assert "## Knowledge Base Requirement" in enhanced_prompt

    @pytest.mark.asyncio
    async def test_empty_kb_ids_with_skip_skips_historical_meta(self):
        """When no KB IDs and skip=True, should skip historical KB meta prompt."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "This is the base system prompt."

        with patch(
            "chat_shell.tools.knowledge_factory._build_historical_kb_meta_prompt"
        ) as mock_meta:
            mock_meta.return_value = "\nHistorical KB meta"

            _, enhanced_prompt = await prepare_knowledge_base_tools(
                knowledge_base_ids=None,
                user_id=1,
                db=MagicMock(),
                base_system_prompt=base_prompt,
                task_id=1,
                skip_prompt_enhancement=True,
            )

            # Should not call _build_historical_kb_meta_prompt
            mock_meta.assert_not_called()
            # Should return base prompt unchanged
            assert enhanced_prompt == base_prompt


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
