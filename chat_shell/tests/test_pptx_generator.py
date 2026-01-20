# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for PPTX generator tool."""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from chat_shell.tools.builtin.pptx_generator import (
    PPTXGeneratorTool,
    PPTXGeneratorInput,
    SlideContent,
)


class TestPPTXGeneratorInput:
    """Tests for PPTXGeneratorInput schema validation."""

    def test_valid_input_minimal(self):
        """Test minimal valid input."""
        data = PPTXGeneratorInput(
            title="Test Presentation",
            slides=[{"title": "Slide 1", "content": "Content"}],
        )
        assert data.title == "Test Presentation"
        assert len(data.slides) == 1
        assert data.theme == "default"
        assert data.author is None

    def test_valid_input_full(self):
        """Test full input with all optional fields."""
        data = PPTXGeneratorInput(
            title="Full Presentation",
            slides=[
                {
                    "title": "Slide 1",
                    "content": "- Point 1\n- Point 2",
                    "notes": "Speaker notes",
                    "layout": "title_and_content",
                }
            ],
            author="Test Author",
            theme="professional",
        )
        assert data.title == "Full Presentation"
        assert data.author == "Test Author"
        assert data.theme == "professional"

    def test_multiple_slides(self):
        """Test input with multiple slides."""
        data = PPTXGeneratorInput(
            title="Multi-slide Presentation",
            slides=[
                {"title": "Intro", "content": "Introduction content"},
                {"title": "Main", "content": "Main content"},
                {"title": "Conclusion", "content": "Conclusion content"},
            ],
        )
        assert len(data.slides) == 3


class TestPPTXGeneratorTool:
    """Tests for PPTXGeneratorTool."""

    @pytest.fixture
    def tool(self):
        """Create a PPTXGeneratorTool instance for testing."""
        return PPTXGeneratorTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
        )

    def test_tool_properties(self, tool):
        """Test tool has correct properties."""
        assert tool.name == "generate_pptx"
        assert tool.display_name == "Generate PPTX"
        assert "PowerPoint" in tool.description
        assert tool.args_schema == PPTXGeneratorInput

    def test_tool_configuration(self, tool):
        """Test tool configuration parameters."""
        assert tool.task_id == 1
        assert tool.subtask_id == 1
        assert tool.user_id == 1

    @pytest.mark.asyncio
    async def test_arun_empty_title_error(self, tool):
        """Test error when title is empty."""
        result = await tool._arun(
            title="",
            slides=[{"title": "Slide", "content": "Content"}],
        )
        result_data = json.loads(result)
        assert "error" in result_data
        assert "title" in result_data["error"].lower()

    @pytest.mark.asyncio
    async def test_arun_empty_slides_error(self, tool):
        """Test error when slides list is empty."""
        result = await tool._arun(
            title="Test",
            slides=[],
        )
        result_data = json.loads(result)
        assert "error" in result_data
        assert "slide" in result_data["error"].lower()

    @pytest.mark.asyncio
    async def test_arun_generates_pptx(self, tool):
        """Test successful PPTX generation."""
        result = await tool._arun(
            title="Test Presentation",
            slides=[
                {"title": "Slide 1", "content": "- Point 1\n- Point 2"},
                {"title": "Slide 2", "content": "Content for slide 2"},
            ],
            author="Test Author",
            theme="professional",
        )
        result_data = json.loads(result)

        assert result_data["status"] == "success"
        assert "Test Presentation" in result_data["message"]
        assert result_data["slide_count"] == 3  # Title + 2 content slides
        assert result_data["filename"] == "Test_Presentation.pptx"
        assert result_data["file_size"] > 0

    @pytest.mark.asyncio
    async def test_arun_with_themes(self, tool):
        """Test PPTX generation with different themes."""
        themes = ["default", "professional", "creative", "minimal"]

        for theme in themes:
            result = await tool._arun(
                title=f"{theme.title()} Theme Test",
                slides=[{"title": "Test", "content": "Content"}],
                theme=theme,
            )
            result_data = json.loads(result)
            assert result_data["status"] == "success"

    @pytest.mark.asyncio
    async def test_arun_returns_base64_without_api(self, tool):
        """Test fallback to base64 when API is not configured."""
        result = await tool._arun(
            title="Base64 Test",
            slides=[{"title": "Test", "content": "Content"}],
        )
        result_data = json.loads(result)

        assert result_data["status"] == "success"
        # Without API, should return base64
        assert "pptx_base64" in result_data or "pptx_context_id" in result_data

    @pytest.mark.asyncio
    async def test_arun_with_bullet_points(self, tool):
        """Test PPTX generation with properly formatted bullet points."""
        result = await tool._arun(
            title="Bullet Points Test",
            slides=[
                {
                    "title": "Main Points",
                    "content": "- First point\n- Second point\n  - Sub point 1\n  - Sub point 2\n- Third point",
                }
            ],
        )
        result_data = json.loads(result)
        assert result_data["status"] == "success"

    @pytest.mark.asyncio
    async def test_arun_with_asterisk_bullets(self, tool):
        """Test PPTX generation with asterisk-style bullets."""
        result = await tool._arun(
            title="Asterisk Bullets Test",
            slides=[
                {
                    "title": "Points",
                    "content": "* Point one\n* Point two\n  * Nested point",
                }
            ],
        )
        result_data = json.loads(result)
        assert result_data["status"] == "success"


class TestPPTXGeneratorToolIntegration:
    """Integration tests for PPTX generator tool."""

    @pytest.mark.asyncio
    async def test_generate_pptx_binary_valid(self):
        """Test that generated PPTX binary is valid."""
        tool = PPTXGeneratorTool()

        # Use the internal method to generate PPTX
        pptx_binary, slide_count = await tool._generate_pptx(
            title="Valid PPTX Test",
            slides=[
                {"title": "Test Slide", "content": "Test content"},
            ],
            author="Test Author",
            theme="default",
        )

        # Verify the binary is a valid PPTX (ZIP format starts with PK)
        assert pptx_binary[:2] == b"PK"
        assert slide_count == 2  # Title slide + 1 content slide
        assert len(pptx_binary) > 1000  # Should be at least a few KB

    @pytest.mark.asyncio
    async def test_generate_pptx_with_unicode(self):
        """Test PPTX generation with unicode characters."""
        tool = PPTXGeneratorTool()

        pptx_binary, slide_count = await tool._generate_pptx(
            title="中文演示文稿",
            slides=[
                {"title": "第一页", "content": "- 要点一\n- 要点二"},
                {"title": "日本語スライド", "content": "- ポイント1\n- ポイント2"},
            ],
            author="测试作者",
            theme="default",
        )

        assert pptx_binary[:2] == b"PK"
        assert slide_count == 3

    @pytest.mark.asyncio
    async def test_store_with_mock_api(self):
        """Test storing PPTX via mocked API."""
        tool = PPTXGeneratorTool(
            task_id=1,
            subtask_id=1,
            user_id=1,
            api_base_url="http://test-api:8000",
            auth_token="test-token",
        )

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": 123}

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.post.return_value = mock_response
            mock_client_instance.__aenter__.return_value = mock_client_instance
            mock_client_instance.__aexit__.return_value = None
            mock_client.return_value = mock_client_instance

            result = await tool._store_generated_files(
                title="API Test",
                pptx_binary=b"PK test binary",
                preview_images=[],
                slide_count=2,
            )

            assert result["status"] == "success"
            assert result["pptx_context_id"] == 123
