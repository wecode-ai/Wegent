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

import pytest

# Skill directory used for file-based assertions
SKILL_DIR = Path(__file__).parent.parent.parent / "init_data" / "skills" / "sandbox"


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

    def test_tool_name_defined(self):
        """Test that tool name is correctly defined."""
        tool_file = SKILL_DIR / "upload_attachment_tool.py"
        content = tool_file.read_text()

        assert 'name: str = "sandbox_upload_attachment"' in content

    def test_tool_inherits_base_sandbox_tool(self):
        """Test that tool inherits from BaseSandboxTool."""
        tool_file = SKILL_DIR / "upload_attachment_tool.py"
        content = tool_file.read_text()

        assert "class SandboxUploadAttachmentTool(BaseSandboxTool):" in content


class TestDownloadAttachmentToolConstants:
    """Tests for download attachment tool constants."""

    def test_default_api_base_url_constant(self):
        """Test that DEFAULT_API_BASE_URL is defined."""
        tool_file = SKILL_DIR / "download_attachment_tool.py"
        content = tool_file.read_text()

        assert "DEFAULT_API_BASE_URL" in content
        assert "http://wegent-backend:8000" in content

    def test_tool_name_defined(self):
        """Test that tool name is correctly defined."""
        tool_file = SKILL_DIR / "download_attachment_tool.py"
        content = tool_file.read_text()

        assert 'name: str = "sandbox_download_attachment"' in content

    def test_tool_inherits_base_sandbox_tool(self):
        """Test that tool inherits from BaseSandboxTool."""
        tool_file = SKILL_DIR / "download_attachment_tool.py"
        content = tool_file.read_text()

        assert "class SandboxDownloadAttachmentTool(BaseSandboxTool):" in content


class TestProviderToolRegistration:
    """Tests for provider tool registration via file content analysis."""

    def test_provider_registers_upload_attachment_tool(self):
        """Test that provider registers upload attachment tool."""
        provider_file = SKILL_DIR / "provider.py"
        content = provider_file.read_text()

        # Check that the tool is in supported_tools list
        assert '"sandbox_upload_attachment"' in content
        # Check that the tool creation logic exists
        assert "SandboxUploadAttachmentTool" in content
        assert "from .upload_attachment_tool import SandboxUploadAttachmentTool" in content

    def test_provider_registers_download_attachment_tool(self):
        """Test that provider registers download attachment tool."""
        provider_file = SKILL_DIR / "provider.py"
        content = provider_file.read_text()

        # Check that the tool is in supported_tools list
        assert '"sandbox_download_attachment"' in content
        # Check that the tool creation logic exists
        assert "SandboxDownloadAttachmentTool" in content
        assert "from .download_attachment_tool import SandboxDownloadAttachmentTool" in content

    def test_provider_passes_auth_token_config(self):
        """Test that provider passes auth_token config to tools."""
        provider_file = SKILL_DIR / "provider.py"
        content = provider_file.read_text()

        # Check auth_token is passed for upload tool
        assert 'auth_token=config.get("auth_token"' in content
        # Check api_base_url is passed
        assert 'api_base_url=config.get("api_base_url"' in content


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

    def test_skill_md_includes_tool_selection_guide(self):
        """Test that SKILL.md includes attachment tools in selection guide."""
        skill_md = SKILL_DIR / "SKILL.md"
        content = skill_md.read_text()

        # Check tool selection guide includes attachment tools
        assert "Upload files for user download" in content
        assert "Download attachments" in content


class TestDocumentSkillIntegration:
    """Tests for document skill integration with attachment upload."""

    def test_document_skill_includes_upload_step(self):
        """Test that document skill includes step 5 for upload."""
        document_skill_dir = SKILL_DIR.parent / "document"
        document_tool_file = document_skill_dir / "document_tool.py"
        content = document_tool_file.read_text()

        # Check step 5 is defined
        assert "step_5_UPLOAD_AND_RETURN_URL" in content
        assert "sandbox_upload_attachment" in content
        assert "download_url" in content

    def test_document_skill_md_includes_upload_step(self):
        """Test that document skill SKILL.md includes upload step."""
        document_skill_dir = SKILL_DIR.parent / "document"
        skill_md = document_skill_dir / "SKILL.md"
        content = skill_md.read_text()

        # Check step 5 documentation
        assert "Upload and Return URL" in content
        assert "sandbox_upload_attachment" in content
        assert "NEVER SKIP" in content
