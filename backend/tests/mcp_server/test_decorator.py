# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP tool decorator and schema extractor."""

from typing import List, Optional
from unittest.mock import MagicMock

import pytest
from fastapi import Depends, Query
from pydantic import BaseModel, Field

from app.mcp_server.decorator import (
    _to_snake_case,
    clear_registry,
    get_registered_tools,
    mcp_tool,
)
from app.mcp_server.schema_extractor import (
    _python_type_to_json_type,
    extract_response_schema,
    extract_tool_parameters,
    generate_tool_docstring,
)

# ============== Fixture Models (not starting with "Test" to avoid pytest warning) ==============


class ResponseFixture(BaseModel):
    """Response model for testing."""

    id: int = Field(description="Item ID")
    name: str = Field(description="Item name")
    count: Optional[int] = Field(default=None, description="Optional count")


class ListResponseFixture(BaseModel):
    """List response model for testing."""

    total: int = Field(description="Total count")
    items: List[ResponseFixture] = Field(description="List of items")


class CreateRequestFixture(BaseModel):
    """Create request model for testing."""

    name: str = Field(description="Name to create")
    description: Optional[str] = Field(default=None, description="Optional description")


# ============== Decorator Tests ==============


class TestMcpToolDecorator:
    """Tests for @mcp_tool decorator."""

    def setup_method(self):
        """Clear registry before each test."""
        clear_registry()

    def test_decorator_registers_tool(self):
        """Test that decorator registers tool in global registry."""

        @mcp_tool(name="test_tool", server="knowledge")
        def test_func():
            """Test function."""
            pass

        tools = get_registered_tools()
        assert len(tools) == 1
        assert tools[0]["name"] == "test_tool"
        assert tools[0]["server"] == "knowledge"

    def test_decorator_auto_name(self):
        """Test that decorator auto-generates name from function name."""

        @mcp_tool(server="knowledge")
        def myTestFunction():
            """Test function."""
            pass

        tools = get_registered_tools()
        assert tools[0]["name"] == "my_test_function"

    def test_decorator_extracts_description(self):
        """Test that decorator extracts description from docstring."""

        @mcp_tool(server="knowledge")
        def test_func():
            """This is the description.

            This is additional detail.
            """
            pass

        tools = get_registered_tools()
        assert tools[0]["description"] == "This is the description."

    def test_decorator_explicit_description(self):
        """Test that explicit description overrides docstring."""

        @mcp_tool(description="Explicit description", server="knowledge")
        def test_func():
            """Docstring description."""
            pass

        tools = get_registered_tools()
        assert tools[0]["description"] == "Explicit description"

    def test_decorator_stores_response_model(self):
        """Test that decorator stores response model."""

        @mcp_tool(server="knowledge", response_model=ResponseFixture)
        def test_func():
            pass

        tools = get_registered_tools()
        assert tools[0]["response_model"] == ResponseFixture

    def test_filter_by_server(self):
        """Test filtering tools by server name."""

        @mcp_tool(server="knowledge")
        def knowledge_tool():
            pass

        @mcp_tool(server="system")
        def system_tool():
            pass

        knowledge_tools = get_registered_tools(server="knowledge")
        system_tools = get_registered_tools(server="system")

        assert len(knowledge_tools) == 1
        assert knowledge_tools[0]["name"] == "knowledge_tool"
        assert len(system_tools) == 1
        assert system_tools[0]["name"] == "system_tool"

    def test_decorator_preserves_function_behavior(self):
        """Test that decorated function still works normally."""

        @mcp_tool(server="knowledge")
        def add_numbers(a: int, b: int) -> int:
            return a + b

        result = add_numbers(2, 3)
        assert result == 5


class TestToSnakeCase:
    """Tests for _to_snake_case helper."""

    def test_camel_case(self):
        assert _to_snake_case("CamelCase") == "camel_case"

    def test_mixed_case(self):
        assert _to_snake_case("getHTTPResponse") == "get_http_response"

    def test_already_snake(self):
        assert _to_snake_case("snake_case") == "snake_case"

    def test_single_word(self):
        assert _to_snake_case("word") == "word"


# ============== Schema Extractor Tests ==============


class TestExtractToolParameters:
    """Tests for extract_tool_parameters function."""

    def test_extract_query_params(self):
        """Test extraction of Query parameters."""

        def endpoint(
            scope: str = Query(default="all", description="Scope filter"),
            limit: int = Query(default=10, description="Limit count"),
        ):
            pass

        params = extract_tool_parameters(endpoint)
        assert len(params) == 2

        scope_param = next(p for p in params if p["name"] == "scope")
        assert scope_param["type"] == "string"
        assert scope_param["description"] == "Scope filter"
        assert scope_param["default"] == "all"
        assert scope_param["required"] is False

        limit_param = next(p for p in params if p["name"] == "limit")
        assert limit_param["type"] == "integer"
        assert limit_param["default"] == 10

    def test_extract_optional_params(self):
        """Test extraction of Optional parameters."""

        def endpoint(name: Optional[str] = None):
            pass

        params = extract_tool_parameters(endpoint)
        assert len(params) == 1
        assert params[0]["name"] == "name"
        assert params[0]["required"] is False

    def test_filters_dependency_params(self):
        """Test that Depends() parameters are filtered out."""
        mock_db = MagicMock()

        def get_db():
            return mock_db

        def endpoint(
            name: str = Query(...),
            db=Depends(get_db),
        ):
            pass

        params = extract_tool_parameters(endpoint)
        assert len(params) == 1
        assert params[0]["name"] == "name"

    def test_filters_common_dependency_names(self):
        """Test that common dependency names are filtered."""

        def endpoint(
            name: str = Query(...),
            db=None,
            current_user=None,
        ):
            pass

        params = extract_tool_parameters(endpoint)
        # db and current_user should be filtered by name
        param_names = [p["name"] for p in params]
        assert "name" in param_names
        assert "db" not in param_names
        assert "current_user" not in param_names


class TestExtractResponseSchema:
    """Tests for extract_response_schema function."""

    def test_explicit_model(self):
        """Test extraction with explicit response model."""

        def endpoint():
            pass

        schema = extract_response_schema(endpoint, ResponseFixture)
        assert schema is not None
        assert schema["type"] == "object"
        assert "id" in schema["properties"]
        assert "name" in schema["properties"]

    def test_return_type_hint(self):
        """Test extraction from return type hint."""

        def endpoint() -> ResponseFixture:
            pass

        schema = extract_response_schema(endpoint)
        assert schema is not None
        assert "id" in schema["properties"]

    def test_no_schema(self):
        """Test when no schema can be extracted."""

        def endpoint() -> str:
            pass

        schema = extract_response_schema(endpoint)
        assert schema is None

    def test_nested_model(self):
        """Test extraction of nested models."""

        def endpoint() -> ListResponseFixture:
            pass

        schema = extract_response_schema(endpoint)
        assert schema is not None
        assert "items" in schema["properties"]
        items_schema = schema["properties"]["items"]
        assert items_schema["type"] == "array"
        assert "items" in items_schema  # nested schema


class TestPythonTypeToJsonType:
    """Tests for _python_type_to_json_type function."""

    def test_basic_types(self):
        assert _python_type_to_json_type(str) == "string"
        assert _python_type_to_json_type(int) == "integer"
        assert _python_type_to_json_type(float) == "number"
        assert _python_type_to_json_type(bool) == "boolean"
        assert _python_type_to_json_type(list) == "array"
        assert _python_type_to_json_type(dict) == "object"

    def test_optional_type(self):
        assert _python_type_to_json_type(Optional[str]) == "string"
        assert _python_type_to_json_type(Optional[int]) == "integer"

    def test_list_type(self):
        assert _python_type_to_json_type(List[str]) == "array"


class TestGenerateToolDocstring:
    """Tests for generate_tool_docstring function."""

    def test_generates_args_section(self):
        """Test that args section is generated."""
        params = [
            {
                "name": "scope",
                "type": "string",
                "required": False,
                "default": "all",
                "description": "Scope filter",
            },
            {
                "name": "limit",
                "type": "integer",
                "required": True,
                "description": "Max results",
            },
        ]
        response_schema = None

        docstring = generate_tool_docstring(
            name="test_tool",
            description="Test description",
            parameters=params,
            response_schema=response_schema,
        )

        assert "Test description" in docstring
        assert "Args:" in docstring
        assert "scope (string, optional)" in docstring
        assert "[default: all]" in docstring
        assert "limit (integer, required)" in docstring

    def test_generates_returns_section(self):
        """Test that returns section is generated."""
        response_schema = {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "Item ID"},
                "name": {"type": "string", "description": "Item name"},
            },
        }

        docstring = generate_tool_docstring(
            name="test_tool",
            description="Test description",
            parameters=[],
            response_schema=response_schema,
        )

        assert "Returns:" in docstring
        assert "- id (integer)" in docstring
        assert "- name (string)" in docstring

    def test_handles_no_response_schema(self):
        """Test handling when no response schema."""
        docstring = generate_tool_docstring(
            name="test_tool",
            description="Test description",
            parameters=[],
            response_schema=None,
        )

        assert '{"data": ...}' in docstring
