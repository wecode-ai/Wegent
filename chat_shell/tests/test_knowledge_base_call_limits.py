"""Test knowledge base tool call limits with injected configuration.

This test verifies that KB call limit configuration is properly injected
and used by KnowledgeBaseTool in both package mode and HTTP mode.
"""

import pytest

from chat_shell.tools.builtin import KnowledgeBaseTool


class TestKnowledgeBaseCallLimitsInjection:
    """Test KB call limit configuration injection."""

    def test_kb_configs_injected_and_used(self):
        """Test that injected kb_configs are used for call limits."""
        # Arrange: Create tool with injected kb_configs
        kb_configs = {
            1: {
                "maxCallsPerConversation": 15,
                "exemptCallsBeforeCheck": 7,
                "name": "Test KB 1",
            },
            2: {
                "maxCallsPerConversation": 20,
                "exemptCallsBeforeCheck": 10,
                "name": "Test KB 2",
            },
        }

        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1, 2],
            user_id=123,
            context_window=200000,
            kb_configs=kb_configs,
        )

        # Act: Get limits
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Uses first KB's config
        assert max_calls == 15
        assert exempt_calls == 7

    def test_kb_name_from_injected_config(self):
        """Test that KB name is extracted from injected config."""
        # Arrange
        kb_configs = {
            1: {
                "maxCallsPerConversation": 10,
                "exemptCallsBeforeCheck": 5,
                "name": "My Custom KB",
            }
        }

        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            kb_configs=kb_configs,
        )

        # Act
        kb_name = tool._get_kb_name()

        # Assert
        assert kb_name == "My Custom KB"

    def test_fallback_to_defaults_when_no_config(self):
        """Test fallback to default limits when kb_configs is None."""
        # Arrange: No kb_configs injected
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
            kb_configs=None,  # No config injected
        )

        # Act
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Uses defaults
        assert max_calls == 10  # DEFAULT_MAX_CALLS_PER_CONVERSATION
        assert exempt_calls == 5  # DEFAULT_EXEMPT_CALLS_BEFORE_CHECK

    def test_fallback_name_when_no_config(self):
        """Test fallback to KB-{id} name when no config."""
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[123],
            user_id=456,
            kb_configs=None,
        )

        # Act
        kb_name = tool._get_kb_name()

        # Assert
        assert kb_name == "KB-123"

    def test_invalid_config_validation(self):
        """Test that invalid config (exempt >= max) falls back to defaults."""
        # Arrange: Invalid config
        kb_configs = {
            1: {
                "maxCallsPerConversation": 10,
                "exemptCallsBeforeCheck": 15,  # Invalid: >= max
                "name": "Invalid KB",
            }
        }

        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            kb_configs=kb_configs,
        )

        # Act
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Falls back to defaults
        assert max_calls == 10
        assert exempt_calls == 5

    def test_multiple_kbs_uses_first_config(self):
        """Test that with multiple KBs, first KB's config is used."""
        # Arrange
        kb_configs = {
            1: {
                "maxCallsPerConversation": 15,
                "exemptCallsBeforeCheck": 7,
                "name": "First KB",
            },
            2: {
                "maxCallsPerConversation": 25,
                "exemptCallsBeforeCheck": 12,
                "name": "Second KB",
            },
        }

        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1, 2],
            user_id=123,
            kb_configs=kb_configs,
        )

        # Act
        max_calls, exempt_calls = tool._get_kb_limits()
        kb_name = tool._get_kb_name()

        # Assert: Uses first KB's config
        assert max_calls == 15
        assert exempt_calls == 7
        assert kb_name == "First KB"

    def test_partial_config_uses_defaults_for_missing_fields(self):
        """Test that missing fields in config use defaults."""
        # Arrange: Partial config (missing exemptCallsBeforeCheck)
        kb_configs = {
            1: {
                "maxCallsPerConversation": 20,
                # Missing exemptCallsBeforeCheck
                "name": "Partial KB",
            }
        }

        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            kb_configs=kb_configs,
        )

        # Act
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Uses provided max_calls, defaults for exempt
        assert max_calls == 20
        assert exempt_calls == 5  # Default

    def test_empty_knowledge_base_ids_returns_defaults(self):
        """Test that empty KB IDs returns default limits."""
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[],
            user_id=123,
            kb_configs={},
        )

        # Act
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert
        assert max_calls == 10
        assert exempt_calls == 5
