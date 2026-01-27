# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Weibo Tools skill components.

This module tests:
- LoadWeiboToolsTool input schema
- InvokeWeiboToolTool input schema
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
        assert "tools:" in content

        # Check tool definitions
        assert "load_weibo_tools" in content
        assert "invoke_weibo_tool" in content

    def test_skill_md_has_correct_provider_config(self):
        """Test that SKILL.md has correct provider configuration."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check provider configuration
        assert "module: provider" in content
        assert "class: WeiboToolProvider" in content
        assert "provider: weibo-tools" in content

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
                assert "load_weibo_tools" in tool_names
                assert "invoke_weibo_tool" in tool_names

    def test_skill_md_has_weibo_description(self):
        """Test that SKILL.md has Weibo-specific description."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check for Weibo-specific content
        assert "微博" in content


class TestLoadWeiboToolsInput:
    """Tests for LoadWeiboToolsInput schema."""

    def test_input_with_no_arguments(self):
        """Test that input with no arguments is valid."""
        from load_weibo_tools import LoadWeiboToolsInput

        input_obj = LoadWeiboToolsInput()
        assert input_obj.server_names is None

    def test_input_with_server_names(self):
        """Test that input with server_names is valid."""
        from load_weibo_tools import LoadWeiboToolsInput

        input_obj = LoadWeiboToolsInput(server_names=["weibo-status", "weibo-user"])
        assert input_obj.server_names == ["weibo-status", "weibo-user"]

    def test_input_with_empty_server_names(self):
        """Test that input with empty server_names list is valid."""
        from load_weibo_tools import LoadWeiboToolsInput

        input_obj = LoadWeiboToolsInput(server_names=[])
        assert input_obj.server_names == []


class TestInvokeWeiboToolInput:
    """Tests for InvokeWeiboToolInput schema."""

    def test_input_with_required_tool_name(self):
        """Test that input with required tool_name is valid."""
        from load_weibo_tools import InvokeWeiboToolInput

        input_obj = InvokeWeiboToolInput(tool_name="get_weibo_status")
        assert input_obj.tool_name == "get_weibo_status"
        assert input_obj.arguments == {}

    def test_input_with_arguments(self):
        """Test that input with arguments is valid."""
        from load_weibo_tools import InvokeWeiboToolInput

        input_obj = InvokeWeiboToolInput(
            tool_name="get_weibo_status", arguments={"weibo_id": "12345"}
        )
        assert input_obj.tool_name == "get_weibo_status"
        assert input_obj.arguments == {"weibo_id": "12345"}


class TestLoadWeiboToolsToolBasic:
    """Basic tests for LoadWeiboToolsTool without MCP connection."""

    def test_tool_has_required_attributes(self):
        """Test that LoadWeiboToolsTool has required attributes."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        assert tool.name == "load_weibo_tools"
        assert tool.task_id == 1
        assert tool.subtask_id == 1
        assert tool.user_id == 1
        assert tool.timeout == 60.0

    def test_tool_has_prompt_modification_method(self):
        """Test that LoadWeiboToolsTool has get_prompt_modification method."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
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
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = tool._format_tool_list()
        assert result == ""

    def test_format_tool_list_with_tools(self):
        """Test _format_tool_list with loaded tools."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Manually set tool descriptions
        tool._tool_descriptions["get_weibo_status"] = "Query weibo content by ID"
        tool._tool_descriptions["get_weibo_user"] = "Get user profile information"

        result = tool._format_tool_list()

        assert "get_weibo_status" in result
        assert "get_weibo_user" in result
        assert "Query weibo content" in result
        assert "user profile" in result


class TestInvokeWeiboToolToolBasic:
    """Basic tests for InvokeWeiboToolTool."""

    def test_tool_has_required_attributes(self):
        """Test that InvokeWeiboToolTool has required attributes."""
        from load_weibo_tools import InvokeWeiboToolTool, LoadWeiboToolsTool

        load_tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        invoke_tool = InvokeWeiboToolTool(load_weibo_tools_ref=load_tool)

        assert invoke_tool.name == "invoke_weibo_tool"
        assert invoke_tool.load_weibo_tools_ref == load_tool


class TestWeiboToolProviderBasic:
    """Basic tests for WeiboToolProvider."""

    def test_provider_name(self):
        """Test that provider_name returns correct value."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()
        assert provider.provider_name == "weibo-tools"

    def test_supported_tools(self):
        """Test that supported_tools returns both tools."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()
        assert "load_weibo_tools" in provider.supported_tools
        assert "invoke_weibo_tool" in provider.supported_tools

    def test_validate_config_accepts_valid_timeout(self):
        """Test that validate_config accepts valid timeout values."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()

        # Test valid configs
        assert provider.validate_config({}) is True
        assert provider.validate_config(None) is True
        assert provider.validate_config({"timeout": 30}) is True
        assert provider.validate_config({"timeout": 60.0}) is True

    def test_validate_config_rejects_invalid_timeout(self):
        """Test that validate_config rejects invalid timeout values."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()

        # Test invalid configs
        assert provider.validate_config({"timeout": "invalid"}) is False
        assert provider.validate_config({"timeout": -1}) is False
        assert provider.validate_config({"timeout": 0}) is False


class TestPromptModifierIntegration:
    """Tests for PromptModifierTool integration."""

    def test_prompt_modification_empty_when_not_loaded(self):
        """Test that get_prompt_modification returns empty string when no tools loaded."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = tool.get_prompt_modification()
        assert result == ""

    def test_prompt_modification_has_content_when_loaded(self):
        """Test that get_prompt_modification returns content when tools are loaded."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Simulate loaded tools
        tool._is_loaded = True
        tool._loaded_tools = {"get_weibo_status": MagicMock()}
        tool._tool_descriptions = {"get_weibo_status": "Query weibo content"}

        result = tool.get_prompt_modification()

        assert len(result) > 0
        assert "微博工具" in result
        assert "get_weibo_status" in result
        assert "invoke_weibo_tool" in result


class TestAsyncLoadWeiboTools:
    """Tests for async loading functionality."""

    @pytest.mark.asyncio
    async def test_async_load_no_config(self):
        """Test that async load returns error when no config is set."""
        with patch("chat_shell.core.config.settings") as mock_settings:
            mock_settings.CHAT_MCP_SERVERS = ""

            from load_weibo_tools import LoadWeiboToolsTool

            tool = LoadWeiboToolsTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                timeout=60.0,
            )

            result = await tool._async_load()

            # Should return an error message about no servers (in Chinese)
            assert "未配置" in result or "MCP" in result

    @pytest.mark.asyncio
    async def test_async_load_invalid_json_config(self):
        """Test that async load handles invalid JSON config."""
        with patch("chat_shell.core.config.settings") as mock_settings:
            mock_settings.CHAT_MCP_SERVERS = "invalid json {"

            from load_weibo_tools import LoadWeiboToolsTool

            tool = LoadWeiboToolsTool(
                task_id=1,
                subtask_id=1,
                user_id=1,
                timeout=60.0,
            )

            result = await tool._async_load()

            # Should return an error about parsing or configuration (in Chinese)
            assert "出错" in result or "未配置" in result or "未找到" in result

    @pytest.mark.asyncio
    async def test_async_load_returns_cached_when_already_loaded(self):
        """Test that async load returns cached info when already loaded."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Simulate already loaded state
        tool._is_loaded = True
        tool._loaded_tools = {"get_weibo_status": MagicMock()}
        tool._tool_descriptions = {"get_weibo_status": "Query weibo content"}

        result = await tool._async_load()

        assert "已加载" in result
        assert "get_weibo_status" in result


class TestInvokeTool:
    """Tests for tool invocation functionality."""

    @pytest.mark.asyncio
    async def test_invoke_tool_not_loaded_error(self):
        """Test that invoke_tool returns error when not loaded."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = await tool.invoke_tool("get_weibo_status", {"weibo_id": "12345"})

        assert "未加载" in result

    @pytest.mark.asyncio
    async def test_invoke_tool_not_found_error(self):
        """Test that invoke_tool returns error when tool not found."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Simulate loaded state with different tools
        tool._is_loaded = True
        tool._loaded_tools = {"other_tool": MagicMock()}

        result = await tool.invoke_tool("get_weibo_status", {"weibo_id": "12345"})

        assert "未找到" in result
        assert "other_tool" in result

    @pytest.mark.asyncio
    async def test_invoke_tool_success(self):
        """Test successful tool invocation."""
        from load_weibo_tools import LoadWeiboToolsTool

        tool = LoadWeiboToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        # Create mock MCP tool
        mock_mcp_tool = MagicMock()
        mock_mcp_tool._arun = AsyncMock(return_value="Weibo content result")

        # Simulate loaded state
        tool._is_loaded = True
        tool._loaded_tools = {"get_weibo_status": mock_mcp_tool}

        result = await tool.invoke_tool("get_weibo_status", {"weibo_id": "12345"})

        assert result == "Weibo content result"
        mock_mcp_tool._arun.assert_called_once_with(weibo_id="12345")
