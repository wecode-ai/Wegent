# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox attachment upload/download tools provider registration.

This module tests that the SandboxToolProvider properly registers
the attachment upload/download tools.

Note: Full integration tests for the tool functionality require the E2B sandbox
environment and are tested separately in integration tests.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add the skill directory to path for importing
SKILL_DIR = Path(__file__).parent.parent.parent / "init_data" / "skills" / "sandbox"
sys.path.insert(0, str(SKILL_DIR))


class TestSandboxToolProviderAttachmentSupport:
    """Tests for SandboxToolProvider attachment tool support."""

    @pytest.fixture
    def mock_dependencies(self):
        """Set up mock dependencies for provider import."""
        with patch.dict(
            "sys.modules",
            {
                "chat_shell.skills": MagicMock(),
                "langchain_core.tools": MagicMock(),
            },
        ):
            yield

    def test_supported_tools_includes_attachment_tools(self, mock_dependencies):
        """Test that provider supports attachment tools."""
        # Import provider with mocked dependencies
        from provider import SandboxToolProvider

        provider = SandboxToolProvider()
        supported = provider.supported_tools

        assert "sandbox_upload_attachment" in supported
        assert "sandbox_download_attachment" in supported
        # Also verify original tools are still there
        assert "sandbox_command" in supported
        assert "sandbox_claude" in supported
        assert "sandbox_list_files" in supported
        assert "sandbox_read_file" in supported
        assert "sandbox_write_file" in supported

    def test_supported_tools_count(self, mock_dependencies):
        """Test that provider has expected number of tools."""
        from provider import SandboxToolProvider

        provider = SandboxToolProvider()

        # Should have 7 tools: 5 original + 2 new attachment tools
        assert len(provider.supported_tools) == 7


class TestUploadAttachmentToolConstants:
    """Tests for upload attachment tool constants."""

    def test_max_upload_size_constant(self):
        """Test that MAX_UPLOAD_SIZE is defined correctly."""
        # The constant should be 100MB (100 * 1024 * 1024)
        expected_size = 100 * 1024 * 1024  # 100MB

        # Read the file and check the constant
        tool_file = SKILL_DIR / "upload_attachment_tool.py"
        content = tool_file.read_text()

        # Verify the constant is defined
        assert "MAX_UPLOAD_SIZE = 100 * 1024 * 1024" in content
        assert str(expected_size) in content or "MAX_UPLOAD_SIZE" in content

    def test_default_api_base_url_constant(self):
        """Test that DEFAULT_API_BASE_URL is defined."""
        tool_file = SKILL_DIR / "upload_attachment_tool.py"
        content = tool_file.read_text()

        assert "DEFAULT_API_BASE_URL" in content
        assert "http://wegent-backend:8000" in content


class TestDownloadAttachmentToolConstants:
    """Tests for download attachment tool constants."""

    def test_default_api_base_url_constant(self):
        """Test that DEFAULT_API_BASE_URL is defined."""
        tool_file = SKILL_DIR / "download_attachment_tool.py"
        content = tool_file.read_text()

        assert "DEFAULT_API_BASE_URL" in content
        assert "http://wegent-backend:8000" in content


class TestSkillMdToolConfiguration:
    """Tests for SKILL.md tool configuration."""

    def test_skill_md_includes_upload_tool(self):
        """Test that SKILL.md includes upload attachment tool config."""
        skill_md = SKILL_DIR / "SKILL.md"
        content = skill_md.read_text()

        assert "sandbox_upload_attachment" in content
        assert "max_file_size: 104857600" in content  # 100MB

    def test_skill_md_includes_download_tool(self):
        """Test that SKILL.md includes download attachment tool config."""
        skill_md = SKILL_DIR / "SKILL.md"
        content = skill_md.read_text()

        assert "sandbox_download_attachment" in content

    def test_skill_md_documents_attachment_operations(self):
        """Test that SKILL.md documents attachment operations."""
        skill_md = SKILL_DIR / "SKILL.md"
        content = skill_md.read_text()

        # Check for documentation sections
        assert "Attachment Operations" in content
        assert "Upload a file from sandbox to Wegent" in content
        assert "Download a file from Wegent" in content
        assert "download_url" in content
