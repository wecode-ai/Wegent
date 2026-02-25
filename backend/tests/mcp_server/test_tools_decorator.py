# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the MCP tools decorator."""

from typing import Any, Dict, Optional

import pytest

from app.mcp_server.tools.decorator import (
    _extract_first_docstring_line,
    _extract_parameters_from_signature,
    _python_type_to_json_schema,
    _to_snake_case,
    build_mcp_tools_dict,
    clear_tools_registry,
    get_registered_mcp_tools,
    mcp_tool,
)


class TestToSnakeCase:
    """Tests for _to_snake_case function."""

    def test_camel_case(self):
        """Test CamelCase conversion."""
        assert _to_snake_case("CamelCase") == "camel_case"
        assert _to_snake_case("CamelCaseWord") == "camel_case_word"

    def test_already_snake_case(self):
        """Test already snake_case strings."""
        assert _to_snake_case("snake_case") == "snake_case"
        assert _to_snake_case("already_snake") == "already_snake"

    def test_mixed_case(self):
        """Test mixed case strings."""
        assert _to_snake_case("listKnowledgeBases") == "list_knowledge_bases"
        assert _to_snake_case("getHTTPResponse") == "get_http_response"


class TestExtractFirstDocstringLine:
    """Tests for _extract_first_docstring_line function."""

    def test_single_line_docstring(self):
        """Test single line docstring."""
        doc = "This is a description."
        assert _extract_first_docstring_line(doc) == "This is a description."

    def test_multiline_docstring(self):
        """Test multiline docstring."""
        doc = """First line description.

        More details here.
        """
        assert _extract_first_docstring_line(doc) == "First line description."

    def test_empty_docstring(self):
        """Test empty docstring."""
        assert _extract_first_docstring_line("") == ""
        assert _extract_first_docstring_line(None) == ""

    def test_docstring_with_args_section(self):
        """Test docstring with Args section."""
        doc = """Do something useful.

        Args:
            param1: Description of param1
        """
        assert _extract_first_docstring_line(doc) == "Do something useful."


class TestPythonTypeToJsonSchema:
    """Tests for _python_type_to_json_schema function."""

    def test_basic_types(self):
        """Test basic Python types."""
        assert _python_type_to_json_schema(str)["type"] == "string"
        assert _python_type_to_json_schema(int)["type"] == "integer"
        assert _python_type_to_json_schema(float)["type"] == "number"
        assert _python_type_to_json_schema(bool)["type"] == "boolean"
        assert _python_type_to_json_schema(list)["type"] == "array"
        assert _python_type_to_json_schema(dict)["type"] == "object"

    def test_optional_types(self):
        """Test Optional types."""
        schema = _python_type_to_json_schema(Optional[str])
        assert schema["type"] == "string"

        schema = _python_type_to_json_schema(Optional[int])
        assert schema["type"] == "integer"

    def test_none_type(self):
        """Test None type."""
        assert _python_type_to_json_schema(None)["type"] == "null"


class TestExtractParametersFromSignature:
    """Tests for _extract_parameters_from_signature function."""

    def test_simple_function(self):
        """Test parameter extraction from simple function."""

        def func(name: str, count: int = 10):
            pass

        params = _extract_parameters_from_signature(
            func=func,
            exclude_params=[],
            param_descriptions={},
            param_renames={},
        )

        assert len(params) == 2
        assert params[0]["name"] == "name"
        assert params[0]["type"] == "string"
        assert params[0]["required"] is True

        assert params[1]["name"] == "count"
        assert params[1]["type"] == "integer"
        assert params[1]["required"] is False
        assert params[1]["default"] == 10

    def test_exclude_params(self):
        """Test parameter exclusion."""

        def func(token_info: str, name: str, db: str):
            pass

        params = _extract_parameters_from_signature(
            func=func,
            exclude_params=["token_info", "db"],
            param_descriptions={},
            param_renames={},
        )

        assert len(params) == 1
        assert params[0]["name"] == "name"

    def test_param_descriptions(self):
        """Test custom parameter descriptions."""

        def func(name: str):
            pass

        params = _extract_parameters_from_signature(
            func=func,
            exclude_params=[],
            param_descriptions={"name": "The name of the item"},
            param_renames={},
        )

        assert params[0]["description"] == "The name of the item"

    def test_param_renames(self):
        """Test parameter renaming."""

        def func(knowledge_base_id: int):
            pass

        params = _extract_parameters_from_signature(
            func=func,
            exclude_params=[],
            param_descriptions={},
            param_renames={"knowledge_base_id": "kb_id"},
        )

        assert params[0]["name"] == "kb_id"


class TestMcpToolDecorator:
    """Tests for @mcp_tool decorator."""

    def setup_method(self):
        """Clear registry before each test."""
        clear_tools_registry()

    def test_basic_registration(self):
        """Test basic tool registration."""

        @mcp_tool(
            name="test_tool",
            description="A test tool",
            server="test",
        )
        def my_tool(token_info: str, param1: str) -> Dict[str, Any]:
            """Tool docstring."""
            return {"result": param1}

        tools = get_registered_mcp_tools(server="test")
        assert "test_tool" in tools
        assert tools["test_tool"]["name"] == "test_tool"
        assert tools["test_tool"]["description"] == "A test tool"
        assert tools["test_tool"]["server"] == "test"

    def test_auto_name_from_function(self):
        """Test automatic name generation from function name."""

        @mcp_tool(server="test")
        def list_knowledge_bases(token_info: str) -> Dict[str, Any]:
            """List all knowledge bases."""
            return {}

        tools = get_registered_mcp_tools(server="test")
        assert "list_knowledge_bases" in tools

    def test_auto_description_from_docstring(self):
        """Test automatic description from docstring."""

        @mcp_tool(name="test_tool", server="test")
        def my_tool(token_info: str) -> Dict[str, Any]:
            """This is the tool description."""
            return {}

        tools = get_registered_mcp_tools(server="test")
        assert tools["test_tool"]["description"] == "This is the tool description."

    def test_token_info_excluded_by_default(self):
        """Test that token_info is excluded from parameters by default."""

        @mcp_tool(name="test_tool", server="test")
        def my_tool(token_info: str, param1: str, param2: int = 5) -> Dict[str, Any]:
            return {}

        tools = get_registered_mcp_tools(server="test")
        params = tools["test_tool"]["parameters"]
        param_names = [p["name"] for p in params]

        assert "token_info" not in param_names
        assert "param1" in param_names
        assert "param2" in param_names

    def test_custom_param_descriptions(self):
        """Test custom parameter descriptions."""

        @mcp_tool(
            name="test_tool",
            server="test",
            param_descriptions={
                "name": "The name of the resource",
                "count": "Number of items to return",
            },
        )
        def my_tool(token_info: str, name: str, count: int = 10) -> Dict[str, Any]:
            return {}

        tools = get_registered_mcp_tools(server="test")
        params = tools["test_tool"]["parameters"]

        name_param = next(p for p in params if p["name"] == "name")
        count_param = next(p for p in params if p["name"] == "count")

        assert name_param["description"] == "The name of the resource"
        assert count_param["description"] == "Number of items to return"

    def test_filter_by_server(self):
        """Test filtering tools by server."""

        @mcp_tool(name="tool1", server="knowledge")
        def tool1(token_info: str) -> Dict[str, Any]:
            return {}

        @mcp_tool(name="tool2", server="system")
        def tool2(token_info: str) -> Dict[str, Any]:
            return {}

        knowledge_tools = get_registered_mcp_tools(server="knowledge")
        system_tools = get_registered_mcp_tools(server="system")
        all_tools = get_registered_mcp_tools()

        assert "tool1" in knowledge_tools
        assert "tool2" not in knowledge_tools

        assert "tool2" in system_tools
        assert "tool1" not in system_tools

        assert "tool1" in all_tools
        assert "tool2" in all_tools


class TestBuildMcpToolsDict:
    """Tests for build_mcp_tools_dict function."""

    def setup_method(self):
        """Clear registry before each test."""
        clear_tools_registry()

    def test_builds_compatible_dict(self):
        """Test that build_mcp_tools_dict returns compatible format."""

        @mcp_tool(
            name="list_knowledge_bases",
            description="List all KBs",
            server="knowledge",
        )
        def list_kbs(token_info: str, scope: str = "all") -> Dict[str, Any]:
            return {}

        result = build_mcp_tools_dict(server="knowledge")

        assert "list_knowledge_bases" in result
        # func is the original function stored in tool_info, not the wrapper
        assert callable(result["list_knowledge_bases"]["func"])
        assert result["list_knowledge_bases"]["name"] == "list_knowledge_bases"
        assert result["list_knowledge_bases"]["description"] == "List all KBs"
        assert result["list_knowledge_bases"]["server"] == "knowledge"

    def test_empty_for_nonexistent_server(self):
        """Test empty dict for non-existent server."""
        result = build_mcp_tools_dict(server="nonexistent")
        assert result == {}
