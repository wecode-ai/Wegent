# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Weibo Tools skill with three-phase lazy loading.

This module tests:
- Phase 1: ListWeiboMCPsTool - List available MCP servers
- Phase 2: LoadWeiboMCPToolsTool - Load tools from specific server
- Phase 3: InvokeWeiboToolTool - Call specific tools
- WeiboToolsStateManager - Shared state management
- WeiboToolProvider - Tool creation and configuration
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

        # Check all three tools are defined
        assert "list_weibo_mcps" in content
        assert "load_weibo_mcp_tools" in content
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

                # Verify all three tools are defined
                tools = metadata["tools"]
                assert len(tools) == 3

                tool_names = [t["name"] for t in tools]
                assert "list_weibo_mcps" in tool_names
                assert "load_weibo_mcp_tools" in tool_names
                assert "invoke_weibo_tool" in tool_names

    def test_skill_md_has_weibo_description(self):
        """Test that SKILL.md has Weibo-specific description."""
        skill_md_path = SKILL_DIR / "SKILL.md"
        content = skill_md_path.read_text()

        # Check for Weibo-specific content
        assert "微博" in content


class TestWeiboMCPCatalog:
    """Tests for the static MCP catalog."""

    def test_catalog_has_all_services(self):
        """Test that WEIBO_MCP_CATALOG has all expected services."""
        from load_weibo_tools import WEIBO_MCP_CATALOG

        expected_services = [
            "weibo-status",
            "weibo-user",
            "weibo-comments",
            "weibo-search",
            "wegent-fetch",
        ]

        for service in expected_services:
            assert service in WEIBO_MCP_CATALOG
            assert "name" in WEIBO_MCP_CATALOG[service]
            assert "description" in WEIBO_MCP_CATALOG[service]
            assert "use_cases" in WEIBO_MCP_CATALOG[service]


class TestListWeiboMCPsTool:
    """Tests for Phase 1: ListWeiboMCPsTool."""

    def test_tool_has_required_attributes(self):
        """Test that ListWeiboMCPsTool has required attributes."""
        from load_weibo_tools import ListWeiboMCPsTool

        tool = ListWeiboMCPsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
        )

        assert tool.name == "list_weibo_mcps"
        assert "列出" in tool.display_name or "MCP" in tool.display_name

    def test_list_mcps_returns_catalog(self):
        """Test that _list_mcps returns service catalog."""
        from load_weibo_tools import ListWeiboMCPsTool

        tool = ListWeiboMCPsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
        )

        with patch("chat_shell.core.config.settings") as mock_settings:
            mock_settings.CHAT_MCP_SERVERS = ""
            result = tool._list_mcps()

        # Should contain catalog info
        assert "weibo-status" in result
        assert "weibo-user" in result
        assert "weibo-comments" in result
        assert "weibo-search" in result
        assert "wegent-fetch" in result

    def test_list_mcps_shows_configured_servers(self):
        """Test that configured servers are marked as available."""
        from load_weibo_tools import ListWeiboMCPsTool

        tool = ListWeiboMCPsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
        )

        mock_config = json.dumps(
            {
                "mcpServers": {
                    "weibo-status": {"command": "node"},
                    "weibo-user": {"command": "node"},
                }
            }
        )

        # Patch at the module level where settings is imported
        with patch("load_weibo_tools.settings") as mock_settings:
            mock_settings.CHAT_MCP_SERVERS = mock_config
            result = tool._list_mcps()

        # Configured services should be marked with checkmark
        assert "✓" in result
        # Unconfigured services should show warning
        assert "未配置" in result


class TestLoadWeiboMCPToolsInput:
    """Tests for LoadWeiboMCPToolsInput schema."""

    def test_input_requires_server_name(self):
        """Test that server_name is required."""
        from load_weibo_tools import LoadWeiboMCPToolsInput

        input_obj = LoadWeiboMCPToolsInput(server_name="weibo-status")
        assert input_obj.server_name == "weibo-status"


class TestLoadWeiboMCPToolsTool:
    """Tests for Phase 2: LoadWeiboMCPToolsTool."""

    def test_tool_has_required_attributes(self):
        """Test that LoadWeiboMCPToolsTool has required attributes."""
        from load_weibo_tools import LoadWeiboMCPToolsTool

        tool = LoadWeiboMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        assert tool.name == "load_weibo_mcp_tools"
        assert tool.task_id == 1
        assert tool.timeout == 60.0

    @pytest.mark.asyncio
    async def test_async_load_returns_error_without_state_manager(self):
        """Test that async load returns error without state manager."""
        from load_weibo_tools import LoadWeiboMCPToolsTool

        tool = LoadWeiboMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )

        result = await tool._async_load("weibo-status")

        assert "错误" in result
        assert "状态管理器" in result

    @pytest.mark.asyncio
    async def test_async_load_validates_server_name(self):
        """Test that unknown server names are rejected."""
        from load_weibo_tools import LoadWeiboMCPToolsTool, WeiboToolsStateManager

        tool = LoadWeiboMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )
        tool.set_state_manager(WeiboToolsStateManager())

        result = await tool._async_load("unknown-server")

        assert "错误" in result
        assert "未知" in result

    @pytest.mark.asyncio
    async def test_async_load_returns_cached_when_already_loaded(self):
        """Test that already loaded servers return cached info."""
        from load_weibo_tools import LoadWeiboMCPToolsTool, WeiboToolsStateManager

        tool = LoadWeiboMCPToolsTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            timeout=60.0,
        )
        state_manager = WeiboToolsStateManager()
        tool.set_state_manager(state_manager)

        # Pre-register a server
        state_manager.register_server(
            "weibo-status",
            MagicMock(),
            {"test_tool": {"tool": MagicMock(), "description": "Test tool"}},
        )

        result = await tool._async_load("weibo-status")

        assert "已加载" in result
        assert "test_tool" in result


class TestInvokeWeiboToolInput:
    """Tests for InvokeWeiboToolInput schema."""

    def test_input_requires_server_and_tool_name(self):
        """Test that server_name and tool_name are required."""
        from load_weibo_tools import InvokeWeiboToolInput

        input_obj = InvokeWeiboToolInput(
            server_name="weibo-status",
            tool_name="get_weibo_by_id",
            arguments={"weibo_id": "12345"},
        )
        assert input_obj.server_name == "weibo-status"
        assert input_obj.tool_name == "get_weibo_by_id"
        assert input_obj.arguments == {"weibo_id": "12345"}


class TestInvokeWeiboToolTool:
    """Tests for Phase 3: InvokeWeiboToolTool."""

    def test_tool_has_required_attributes(self):
        """Test that InvokeWeiboToolTool has required attributes."""
        from load_weibo_tools import InvokeWeiboToolTool

        tool = InvokeWeiboToolTool()

        assert tool.name == "invoke_weibo_tool"

    @pytest.mark.asyncio
    async def test_invoke_returns_error_without_state_manager(self):
        """Test that invoke returns error without state manager."""
        from load_weibo_tools import InvokeWeiboToolTool

        tool = InvokeWeiboToolTool()

        result = await tool._async_invoke("weibo-status", "test_tool", {})

        assert "错误" in result
        assert "状态管理器" in result

    @pytest.mark.asyncio
    async def test_invoke_returns_error_when_server_not_loaded(self):
        """Test that invoke returns error when server not loaded."""
        from load_weibo_tools import InvokeWeiboToolTool, WeiboToolsStateManager

        tool = InvokeWeiboToolTool()
        tool.set_state_manager(WeiboToolsStateManager())

        result = await tool._async_invoke("weibo-status", "test_tool", {})

        assert "错误" in result
        assert "未加载" in result

    @pytest.mark.asyncio
    async def test_invoke_returns_error_when_tool_not_found(self):
        """Test that invoke returns error when tool not found."""
        from load_weibo_tools import InvokeWeiboToolTool, WeiboToolsStateManager

        tool = InvokeWeiboToolTool()
        state_manager = WeiboToolsStateManager()
        tool.set_state_manager(state_manager)

        # Register server with different tool
        state_manager.register_server(
            "weibo-status",
            MagicMock(),
            {"other_tool": {"tool": MagicMock(), "description": "Other tool"}},
        )

        result = await tool._async_invoke("weibo-status", "nonexistent_tool", {})

        assert "错误" in result
        assert "未找到" in result
        assert "other_tool" in result

    @pytest.mark.asyncio
    async def test_invoke_success(self):
        """Test successful tool invocation."""
        from load_weibo_tools import InvokeWeiboToolTool, WeiboToolsStateManager

        tool = InvokeWeiboToolTool()
        state_manager = WeiboToolsStateManager()
        tool.set_state_manager(state_manager)

        # Create mock tool
        mock_mcp_tool = MagicMock()
        mock_mcp_tool._arun = AsyncMock(return_value="Weibo content result")

        # Register server with tool
        state_manager.register_server(
            "weibo-status",
            MagicMock(),
            {"get_weibo_by_id": {"tool": mock_mcp_tool, "description": "Get weibo"}},
        )

        result = await tool._async_invoke(
            "weibo-status", "get_weibo_by_id", {"weibo_id": "12345"}
        )

        assert result == "Weibo content result"
        mock_mcp_tool._arun.assert_called_once_with(weibo_id="12345")


class TestWeiboToolsStateManager:
    """Tests for WeiboToolsStateManager."""

    def test_initial_state_is_empty(self):
        """Test that initial state is empty."""
        from load_weibo_tools import WeiboToolsStateManager

        manager = WeiboToolsStateManager()

        assert manager.get_loaded_servers() == []
        assert not manager.is_server_loaded("weibo-status")

    def test_register_server(self):
        """Test registering a server."""
        from load_weibo_tools import WeiboToolsStateManager

        manager = WeiboToolsStateManager()

        mock_client = MagicMock()
        mock_tool = MagicMock()
        tools = {"test_tool": {"tool": mock_tool, "description": "Test"}}

        manager.register_server("weibo-status", mock_client, tools)

        assert manager.is_server_loaded("weibo-status")
        assert "weibo-status" in manager.get_loaded_servers()
        assert manager.get_tool("weibo-status", "test_tool") == mock_tool

    def test_get_server_tool_names(self):
        """Test getting tool names from a server."""
        from load_weibo_tools import WeiboToolsStateManager

        manager = WeiboToolsStateManager()

        tools = {
            "tool1": {"tool": MagicMock(), "description": "Tool 1"},
            "tool2": {"tool": MagicMock(), "description": "Tool 2"},
        }

        manager.register_server("weibo-status", MagicMock(), tools)

        tool_names = manager.get_server_tool_names("weibo-status")
        assert "tool1" in tool_names
        assert "tool2" in tool_names


class TestWeiboToolProvider:
    """Tests for WeiboToolProvider."""

    def test_provider_name(self):
        """Test that provider_name returns correct value."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()
        assert provider.provider_name == "weibo-tools"

    def test_supported_tools(self):
        """Test that supported_tools returns all three tools."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()
        supported = provider.supported_tools

        assert "list_weibo_mcps" in supported
        assert "load_weibo_mcp_tools" in supported
        assert "invoke_weibo_tool" in supported

    def test_validate_config_accepts_valid_timeout(self):
        """Test that validate_config accepts valid timeout values."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()

        assert provider.validate_config({}) is True
        assert provider.validate_config(None) is True
        assert provider.validate_config({"timeout": 30}) is True
        assert provider.validate_config({"timeout": 60.0}) is True

    def test_validate_config_rejects_invalid_timeout(self):
        """Test that validate_config rejects invalid timeout values."""
        from provider import WeiboToolProvider

        provider = WeiboToolProvider()

        assert provider.validate_config({"timeout": "invalid"}) is False
        assert provider.validate_config({"timeout": -1}) is False
        assert provider.validate_config({"timeout": 0}) is False


class TestBackwardCompatibility:
    """Tests for backward compatibility aliases."""

    def test_legacy_class_names_exist(self):
        """Test that legacy class names are available."""
        from load_weibo_tools import (
            LoadWeiboToolsInput,
            LoadWeiboToolsTool,
        )

        # These should be aliases
        assert LoadWeiboToolsInput is not None
        assert LoadWeiboToolsTool is not None
