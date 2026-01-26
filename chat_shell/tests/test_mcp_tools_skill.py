# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP Tools skill components.

This module tests:
- LoadMCPToolsTool input schema
- InvokeMCPToolTool input schema
- PromptModifierTool integration
- Tool configuration validation
"""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add the skill directory to path for importing
SKILL_DIR = (
    Path(__file__).parent.parent.parent
    / "backend"
    / "init_data"
    / "skills"
    / "mcp-tools"
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
        assert "tools:" in content

        # Check tool definitions
        assert "load_mcp_tools" in content
        assert "invoke_mcp_tool" in content

    def test_skill_md_has_correct_provider_config(self):
        """Test that SKILL.md has correct provider configuration."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check provider configuration
        assert "module: provider" in content
        assert "class: MCPToolProvider" in content
        assert "provider: mcp-tools" in content

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
                assert "tools" in metadata

                # Verify tools are properly defined
                tools = metadata["tools"]
                assert len(tools) == 2

                tool_names = [t["name"] for t in tools]
                assert "load_mcp_tools" in tool_names
                assert "invoke_mcp_tool" in tool_names


class TestLoadMCPToolsInput:
    """Tests for LoadMCPToolsInput schema."""

    def test_input_with_no_arguments(self):
        """Test that input with no arguments is valid."""
        from load_mcp_tools import LoadMCPToolsInput

        input_obj = LoadMCPToolsInput()
        assert input_obj.server_names is None

    def test_input_with_server_names(self):
        """Test that input with server_names is valid."""
        from load_mcp_tools import LoadMCPToolsInput

        input_obj = LoadMCPToolsInput(server_names=["server1", "server2"])
        assert input_obj.server_names == ["server1", "server2"]

    def test_input_with_empty_server_names(self):
        """Test that input with empty server_names list is valid."""
        from load_mcp_tools import LoadMCPToolsInput

        input_obj = LoadMCPToolsInput(server_names=[])
        assert input_obj.server_names == []


class TestInvokeMCPToolInput:
    """Tests for InvokeMCPToolInput schema."""

    def test_input_with_required_tool_name(self):
        """Test that input with required tool_name is valid."""
        from load_mcp_tools import InvokeMCPToolInput

        input_obj = InvokeMCPToolInput(tool_name="web_search")
        assert input_obj.tool_name == "web_search"
        assert input_obj.arguments == {}

    def test_input_with_arguments(self):
        """Test that input with arguments is valid."""
        from load_mcp_tools import InvokeMCPToolInput

        input_obj = InvokeMCPToolInput(
            tool_name="search", arguments={"query": "test"}
        )
        assert input_obj.tool_name == "search"
        assert input_obj.arguments == {"query": "test"}


class TestLoadMCPToolsToolBasic:
    """Basic tests for LoadMCPToolsTool without MCP connection."""

    def test_tool_has_required_attributes(self):
        """Test that LoadMCPToolsTool has required attributes."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        assert tool.name == "load_mcp_tools"
        assert tool.task_id == 1
        assert tool.subtask_id == 1
        assert tool.user_id == 1
        assert tool.timeout == 60.0

    def test_tool_has_prompt_modification_method(self):
        """Test that LoadMCPToolsTool has get_prompt_modification method."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Verify the method exists and returns empty string when not loaded
        assert hasattr(tool, "get_prompt_modification")
        assert tool.get_prompt_modification() == ""

    def test_format_tool_list_empty(self):
        """Test _format_tool_list when no tools loaded."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = tool._format_tool_list()
        assert result == ""

    def test_format_tool_list_with_tools(self):
        """Test _format_tool_list with loaded tools."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Manually set tool descriptions
        tool._tool_descriptions["web_search"] = "Search the web for information"
        tool._tool_descriptions["database_query"] = "Query a database"

        result = tool._format_tool_list()

        assert "web_search" in result
        assert "database_query" in result
        assert "Search the web" in result
        assert "Query a database" in result


class TestInvokeMCPToolToolBasic:
    """Basic tests for InvokeMCPToolTool."""

    def test_tool_has_required_attributes(self):
        """Test that InvokeMCPToolTool has required attributes."""
        from load_mcp_tools import InvokeMCPToolTool, LoadMCPToolsTool

        load_tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        invoke_tool = InvokeMCPToolTool(load_mcp_tools_ref=load_tool)

        assert invoke_tool.name == "invoke_mcp_tool"
        assert invoke_tool.load_mcp_tools_ref == load_tool


class TestMCPToolProviderBasic:
    """Basic tests for MCPToolProvider."""

    def test_provider_name(self):
        """Test that provider_name returns correct value."""
        from provider import MCPToolProvider

        provider = MCPToolProvider()
        assert provider.provider_name == "mcp-tools"

    def test_supported_tools(self):
        """Test that supported_tools returns both tools."""
        from provider import MCPToolProvider

        provider = MCPToolProvider()
        assert "load_mcp_tools" in provider.supported_tools
        assert "invoke_mcp_tool" in provider.supported_tools

    def test_validate_config_accepts_valid_timeout(self):
        """Test that validate_config accepts valid timeout values."""
        from provider import MCPToolProvider

        provider = MCPToolProvider()

        # Test valid configs
        assert provider.validate_config({}) is True
        assert provider.validate_config(None) is True
        assert provider.validate_config({"timeout": 30}) is True
        assert provider.validate_config({"timeout": 60.0}) is True

    def test_validate_config_rejects_invalid_timeout(self):
        """Test that validate_config rejects invalid timeout values."""
        from provider import MCPToolProvider

        provider = MCPToolProvider()

        # Test invalid configs
        assert provider.validate_config({"timeout": "invalid"}) is False
        assert provider.validate_config({"timeout": -1}) is False
        assert provider.validate_config({"timeout": 0}) is False


class TestPromptModifierIntegration:
    """Tests for PromptModifierTool integration."""

    def test_prompt_modification_empty_when_not_loaded(self):
        """Test that get_prompt_modification returns empty string when no tools loaded."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = tool.get_prompt_modification()
        assert result == ""

    def test_prompt_modification_has_content_when_loaded(self):
        """Test that get_prompt_modification returns content when tools are loaded."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Simulate loaded tools
        tool._is_loaded = True
        tool._loaded_tools = {"web_search": MagicMock()}
        tool._tool_descriptions = {"web_search": "Search the web"}

        result = tool.get_prompt_modification()

        assert len(result) > 0
        assert "MCP Tools" in result
        assert "web_search" in result
        assert "invoke_mcp_tool" in result


class TestAsyncLoadMCPTools:
    """Tests for async loading functionality."""

    @pytest.mark.asyncio
    async def test_async_load_no_config(self):
        """Test that async load returns error when no config is set."""
        with patch("chat_shell.core.config.settings") as mock_settings:
            mock_settings.CHAT_MCP_SERVERS = ""

            from load_mcp_tools import LoadMCPToolsTool

            tool = LoadMCPToolsTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                timeout=60.0,
            )

            result = await tool._async_load()

            # Should return an error message about no servers
            assert "No MCP servers" in result or "not configured" in result

    @pytest.mark.asyncio
    async def test_async_load_invalid_json_config(self):
        """Test that async load handles invalid JSON config."""
        with patch("chat_shell.core.config.settings") as mock_settings:
            mock_settings.CHAT_MCP_SERVERS = "invalid json {"

            from load_mcp_tools import LoadMCPToolsTool

            tool = LoadMCPToolsTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                timeout=60.0,
            )

            result = await tool._async_load()

            # Should return an error about parsing or configuration
            assert "Error" in result or "No MCP servers" in result

    @pytest.mark.asyncio
    async def test_async_load_returns_cached_when_already_loaded(self):
        """Test that async load returns cached info when already loaded."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Simulate already loaded state
        tool._is_loaded = True
        tool._loaded_tools = {"test_tool": MagicMock()}
        tool._tool_descriptions = {"test_tool": "A test tool"}

        result = await tool._async_load()

        assert "already loaded" in result
        assert "test_tool" in result


class TestInvokeTool:
    """Tests for tool invocation functionality."""

    @pytest.mark.asyncio
    async def test_invoke_tool_not_loaded_error(self):
        """Test that invoke_tool returns error when not loaded."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = await tool.invoke_tool("web_search", {"query": "test"})

        assert "MCP tools not loaded" in result

    @pytest.mark.asyncio
    async def test_invoke_tool_not_found_error(self):
        """Test that invoke_tool returns error when tool not found."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Simulate loaded state with different tools
        tool._is_loaded = True
        tool._loaded_tools = {"other_tool": MagicMock()}

        result = await tool.invoke_tool("web_search", {"query": "test"})

        assert "not found" in result
        assert "other_tool" in result

    @pytest.mark.asyncio
    async def test_invoke_tool_success(self):
        """Test successful tool invocation."""
        from load_mcp_tools import LoadMCPToolsTool

        tool = LoadMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Create mock MCP tool
        mock_mcp_tool = MagicMock()
        mock_mcp_tool._arun = AsyncMock(return_value="Search results")

        # Simulate loaded state
        tool._is_loaded = True
        tool._loaded_tools = {"web_search": mock_mcp_tool}

        result = await tool.invoke_tool("web_search", {"query": "test"})

        assert result == "Search results"
        mock_mcp_tool._arun.assert_called_once_with(query="test")
