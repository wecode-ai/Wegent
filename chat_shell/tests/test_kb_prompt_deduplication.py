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
        from chat_shell.services.context import ChatContext
        from shared.models.execution import ExecutionRequest

        self.ChatContext = ChatContext
        self.ExecutionRequest = ExecutionRequest

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


class TestKnowledgeFactoryDynamicContext:
    """Tests for knowledge_factory dynamic kb_meta_prompt return."""

    @pytest.mark.asyncio
    async def test_prepare_kb_tools_returns_empty_kb_meta_prompt(self):
        """Should return empty kb_meta_prompt (Backend generates it separately)."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "Base"

        # Mock KnowledgeBaseTool and _check_any_kb_has_rag_enabled
        with (
            patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool_class,
            patch(
                "chat_shell.tools.knowledge_factory._check_any_kb_has_rag_enabled",
                return_value=True,
            ),
        ):
            mock_kb_tool_class.return_value = MagicMock()

            result = await prepare_knowledge_base_tools(
                knowledge_base_ids=[1],
                user_id=1,
                db=MagicMock(),
                base_system_prompt=base_prompt,
                task_id=1,
                model_id="claude-3-5-sonnet",
                skip_prompt_enhancement=False,
                is_user_selected=True,
            )

            # kb_meta_prompt is always empty in chat_shell (Backend generates it)
            assert result.kb_meta_prompt == ""
            assert result.enhanced_system_prompt.startswith(base_prompt)

    @pytest.mark.asyncio
    async def test_kb_prompt_does_not_contain_placeholder(self):
        """Enhanced system prompt should not contain legacy kb_meta_list placeholder."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool_class:
            mock_kb_tool_class.return_value = MagicMock()

            result = await prepare_knowledge_base_tools(
                knowledge_base_ids=[1],
                user_id=1,
                db=MagicMock(),
                base_system_prompt="Base",
                model_id="claude-3-5-sonnet",
                skip_prompt_enhancement=False,
                is_user_selected=True,
            )

            assert "{kb_meta_list}" not in result.enhanced_system_prompt

    @pytest.mark.asyncio
    async def test_skip_prompt_enhancement_returns_base_prompt(self):
        """When skip_prompt_enhancement=True, should return base_system_prompt unchanged."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "This is the base system prompt."
        kb_ids = [1, 2]

        # Mock the KnowledgeBaseTool import in knowledge_factory
        with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool_class:
            mock_kb_tool_class.return_value = MagicMock()

            result = await prepare_knowledge_base_tools(
                knowledge_base_ids=kb_ids,
                user_id=1,
                db=MagicMock(),
                base_system_prompt=base_prompt,
                model_id="claude-3-5-sonnet",
                skip_prompt_enhancement=True,
            )

            # Should return 3 KB tools (knowledge_base_search, kb_ls, kb_head)
            # but not modify prompt
            assert len(result.extra_tools) == 3
            assert result.enhanced_system_prompt == base_prompt
            # Should NOT contain KB prompt markers
            assert "## Knowledge Base Requirement" not in result.enhanced_system_prompt
            assert "## Knowledge Base Available" not in result.enhanced_system_prompt

    @pytest.mark.asyncio
    async def test_no_skip_prompt_enhancement_adds_kb_prompt(self):
        """When skip_prompt_enhancement=False, should add KB prompt."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "This is the base system prompt."
        kb_ids = [1, 2]

        # Mock the KnowledgeBaseTool import in knowledge_factory
        with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool_class:
            mock_kb_tool_class.return_value = MagicMock()

            result = await prepare_knowledge_base_tools(
                knowledge_base_ids=kb_ids,
                user_id=1,
                db=MagicMock(),
                base_system_prompt=base_prompt,
                model_id="claude-3-5-sonnet",
                skip_prompt_enhancement=False,
                is_user_selected=True,
            )

            # Should return 3 KB tools (knowledge_base_search, kb_ls, kb_head)
            # and add prompt
            assert len(result.extra_tools) == 3
            # Should contain KB prompt marker (strict mode because is_user_selected=True)
            assert "## Knowledge Base Requirement" in result.enhanced_system_prompt

    @pytest.mark.asyncio
    async def test_empty_kb_ids_returns_base_prompt_unchanged(self):
        """When no KB IDs, should return base_system_prompt unchanged."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_prompt = "This is the base system prompt."

        result = await prepare_knowledge_base_tools(
            knowledge_base_ids=None,
            user_id=1,
            db=MagicMock(),
            base_system_prompt=base_prompt,
            task_id=1,
            model_id="claude-3-5-sonnet",
            skip_prompt_enhancement=True,
        )

        # Should return base prompt unchanged when no KB IDs
        assert result.enhanced_system_prompt == base_prompt
        # Should return empty kb_meta_prompt
        assert result.kb_meta_prompt == ""
        # Should return empty extra_tools
        assert result.extra_tools == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
