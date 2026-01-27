# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Weibo Tools skill with MCP server configuration.

This module tests:
- SKILL.md file format and MCP server configuration
- WeiboToolProvider - Minimal provider for MCP-based skill
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add the skill directory to path for importing
SKILL_DIR = (
    Path(__file__).parent.parent.parent
    / "backend"
    / "init_data"
    / "skills"
    / "weibo-tools"
)
sys.path.insert(0, str(SKILL_DIR))


class TestSKILLMDFormat:
    """Tests for SKILL.md file format and content."""

    def test_skill_md_exists(self):
        """Test that SKILL.md file exists."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        assert skill_md_path.exists(), f"SKILL.md not found at {skill_md_path}"

    def test_skill_md_has_required_fields(self):
        """Test that SKILL.md contains all required metadata fields."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check required metadata fields
        assert "description:" in content
        assert "displayName:" in content
        assert "version:" in content
        assert "provider:" in content

    def test_skill_md_has_mcp_servers(self):
        """Test that SKILL.md has mcpServers configuration."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check mcpServers configuration
        assert "mcpServers:" in content
        assert "statusServer:" in content
        assert "userServer:" in content
        assert "commentsServer:" in content
        assert "searchServer:" in content
        assert "fetchServer:" in content

    def test_skill_md_has_correct_provider_config(self):
        """Test that SKILL.md has correct provider configuration."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check provider configuration
        assert "module: provider" in content
        assert "class: WeiboToolProvider" in content

    def test_skill_md_binds_to_chat_shell(self):
        """Test that SKILL.md is bound to Chat shell type."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check shell binding
        assert "bindShells:" in content
        assert "Chat" in content

    def test_skill_md_yaml_is_valid(self):
        """Test that SKILL.md YAML frontmatter is valid."""
        import yaml

        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Parse YAML frontmatter
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                yaml_content = parts[1]
                metadata = yaml.safe_load(yaml_content)

                # Verify essential fields exist
                assert "description" in metadata
                assert "displayName" in metadata
                assert "provider" in metadata

                # Verify mcpServers configuration
                assert "mcpServers" in metadata
                mcp_servers = metadata["mcpServers"]
                assert isinstance(mcp_servers, dict)
                assert len(mcp_servers) >= 5

    def test_skill_md_has_weibo_description(self):
        """Test that SKILL.md has Weibo-specific description."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check for Weibo-specific content
        assert "微博" in content

    def test_skill_md_mcp_servers_have_required_fields(self):
        """Test that each MCP server has required configuration fields."""
        import yaml

        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                yaml_content = parts[1]
                metadata = yaml.safe_load(yaml_content)

                mcp_servers = metadata.get("mcpServers", {})
                for server_name, server_config in mcp_servers.items():
                    # Each server should have type, transport, url, and headers
                    assert (
                        "type" in server_config
                    ), f"{server_name} missing 'type' field"
                    assert (
                        "transport" in server_config
                    ), f"{server_name} missing 'transport' field"
                    assert "url" in server_config, f"{server_name} missing 'url' field"
                    assert (
                        "headers" in server_config
                    ), f"{server_name} missing 'headers' field"

    def test_skill_md_supports_variable_substitution(self):
        """Test that MCP server configs use variable substitution."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check for variable substitution syntax
        assert "${{user.name}}" in content


class TestWeiboToolProvider:
    """Tests for WeiboToolProvider."""

    def test_provider_name(self):
        """Test that provider_name returns correct value."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()
        assert provider.provider_name == "weibo-tools"

    def test_supported_tools_is_empty(self):
        """Test that supported_tools returns empty list (MCP-based)."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()
        supported = provider.supported_tools

        # Should be empty since tools come from MCP servers
        assert supported == []

    def test_validate_config_accepts_any_config(self):
        """Test that validate_config accepts any configuration."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()

        assert provider.validate_config({}) is True
        assert provider.validate_config(None) is True
        assert provider.validate_config({"timeout": 30}) is True
        assert provider.validate_config({"any_key": "any_value"}) is True

    def test_create_tool_raises_error(self):
        """Test that create_tool raises ValueError for any tool name."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()

        # Create a mock context
        mock_context = MagicMock()
        mock_context.task_id = 1
        mock_context.subtask_id = 1
        mock_context.user_id = 1

        # Any tool name should raise ValueError
        with pytest.raises(ValueError) as exc_info:
            provider.create_tool("any_tool_name", mock_context)

        assert "Unknown tool" in str(exc_info.value)
        assert "MCP servers" in str(exc_info.value)


class TestProviderFileExists:
    """Tests for provider.py file existence and structure."""

    def test_provider_file_exists(self):
        """Test that provider.py file exists."""
        provider_path = SKILL_DIR / "provider.py"
        assert provider_path.exists(), f"provider.py not found at {provider_path}"

    def test_no_load_weibo_tools_file(self):
        """Test that load_weibo_tools.py has been removed."""
        load_tools_path = SKILL_DIR / "load_weibo_tools.py"
        assert (
            not load_tools_path.exists()
        ), "load_weibo_tools.py should have been removed"
