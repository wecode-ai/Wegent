# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for OpenAPI helpers - knowledge base related functions.
"""

import pytest
from fastapi import HTTPException

from app.schemas.openapi_response import WegentTool
from app.services.openapi.helpers import parse_knowledge_base_name, parse_wegent_tools


class TestParseKnowledgeBaseName:
    """Test cases for parse_knowledge_base_name function."""

    def test_parse_with_namespace_and_name(self):
        """Test parsing 'namespace#name' format."""
        # Act
        result = parse_knowledge_base_name("default#my_kb")

        # Assert
        assert result["namespace"] == "default"
        assert result["name"] == "my_kb"

    def test_parse_with_org_namespace(self):
        """Test parsing with organization namespace."""
        # Act
        result = parse_knowledge_base_name("org#team_kb")

        # Assert
        assert result["namespace"] == "org"
        assert result["name"] == "team_kb"

    def test_parse_name_only_defaults_to_default_namespace(self):
        """Test parsing name only defaults to 'default' namespace."""
        # Act
        result = parse_knowledge_base_name("my_kb")

        # Assert
        assert result["namespace"] == "default"
        assert result["name"] == "my_kb"

    def test_parse_empty_name_raises_error(self):
        """Test parsing empty name raises HTTPException."""
        # Act & Assert
        with pytest.raises(HTTPException) as exc_info:
            parse_knowledge_base_name("")

        assert exc_info.value.status_code == 400
        assert "cannot be empty" in exc_info.value.detail.lower()

    def test_parse_multiple_hashes_raises_error(self):
        """Test parsing with multiple hashes raises HTTPException."""
        # Act & Assert
        with pytest.raises(HTTPException) as exc_info:
            parse_knowledge_base_name("default#my#kb")

        assert exc_info.value.status_code == 400
        assert "invalid" in exc_info.value.detail.lower()

    def test_parse_special_characters_in_name(self):
        """Test parsing names with special characters."""
        # Act
        result = parse_knowledge_base_name("default#my-kb_123")

        # Assert
        assert result["namespace"] == "default"
        assert result["name"] == "my-kb_123"


class TestParseWegentToolsWithKnowledgeBase:
    """Test cases for parse_wegent_tools with knowledge_base type."""

    def test_parse_knowledge_base_tool(self):
        """Test parsing knowledge_base tool type."""
        # Arrange
        tools = [
            WegentTool(
                type="knowledge_base",
                knowledge_base_names=["default#kb1", "org#kb2"],
            )
        ]

        # Act
        result = parse_wegent_tools(tools)

        # Assert
        assert len(result["knowledge_base_names"]) == 2
        assert result["knowledge_base_names"][0] == {
            "namespace": "default",
            "name": "kb1",
        }
        assert result["knowledge_base_names"][1] == {"namespace": "org", "name": "kb2"}

    def test_parse_knowledge_base_without_names(self):
        """Test parsing knowledge_base tool without knowledge_base_names."""
        # Arrange
        tools = [WegentTool(type="knowledge_base")]

        # Act
        result = parse_wegent_tools(tools)

        # Assert
        assert result["knowledge_base_names"] == []

    def test_parse_knowledge_base_with_default_namespace(self):
        """Test parsing knowledge_base tool with names without explicit namespace."""
        # Arrange
        tools = [WegentTool(type="knowledge_base", knowledge_base_names=["kb1"])]

        # Act
        result = parse_wegent_tools(tools)

        # Assert
        assert len(result["knowledge_base_names"]) == 1
        assert result["knowledge_base_names"][0] == {
            "namespace": "default",
            "name": "kb1",
        }

    def test_parse_mixed_tools(self):
        """Test parsing mixed tool types including knowledge_base."""
        # Arrange
        tools = [
            WegentTool(type="wegent_chat_bot"),
            WegentTool(type="knowledge_base", knowledge_base_names=["default#kb1"]),
            WegentTool(type="skill", preload_skills=["skill1"]),
        ]

        # Act
        result = parse_wegent_tools(tools)

        # Assert
        assert result["enable_chat_bot"] is True
        assert len(result["knowledge_base_names"]) == 1
        assert result["knowledge_base_names"][0]["name"] == "kb1"
        assert result["preload_skills"] == ["skill1"]

    def test_parse_empty_tools(self):
        """Test parsing empty tools list."""
        # Act
        result = parse_wegent_tools([])

        # Assert
        assert result["knowledge_base_names"] == []
        assert result["enable_chat_bot"] is False

    def test_parse_none_tools(self):
        """Test parsing None tools."""
        # Act
        result = parse_wegent_tools(None)

        # Assert
        assert result["knowledge_base_names"] == []
        assert result["enable_chat_bot"] is False

    def test_parse_invalid_kb_name_format(self):
        """Test parsing with invalid KB name format raises error."""
        # Arrange
        tools = [
            WegentTool(
                type="knowledge_base",
                knowledge_base_names=["invalid#format#name"],
            )
        ]

        # Act & Assert
        with pytest.raises(HTTPException) as exc_info:
            parse_wegent_tools(tools)

        assert exc_info.value.status_code == 400
