# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Artifact API endpoints.

Tests the artifact upload, download, and retrieval functionality
for sandbox-generated files.
"""

from unittest.mock import MagicMock, Mock, patch

import pytest

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.schemas.subtask_context import ArtifactResponse


class TestArtifactUpload:
    """Test artifact upload functionality"""

    def test_artifact_response_from_context(self):
        """Test ArtifactResponse.from_context creates correct response"""
        # Arrange
        context = SubtaskContext(
            subtask_id=1,
            user_id=1,
            context_type=ContextType.ARTIFACT.value,
            name="presentation.pptx",
            status=ContextStatus.READY.value,
            binary_data=b"",
            type_data={
                "original_filename": "presentation.pptx",
                "file_extension": ".pptx",
                "file_size": 102400,
                "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "file_path": "/home/user/output/presentation.pptx",
                "sandbox_id": "sandbox-123",
                "storage_backend": "mysql",
                "storage_key": "artifacts/test_key",
            },
        )
        context.id = 100

        # Act
        response = ArtifactResponse.from_context(context)

        # Assert
        assert response.id == 100
        assert response.filename == "presentation.pptx"
        assert response.file_size == 102400
        assert (
            response.mime_type
            == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )
        assert response.status == "ready"
        assert response.file_extension == ".pptx"
        assert response.file_path == "/home/user/output/presentation.pptx"
        assert response.sandbox_id == "sandbox-123"

    def test_artifact_response_with_missing_type_data(self):
        """Test ArtifactResponse handles missing type_data gracefully"""
        # Arrange
        context = SubtaskContext(
            subtask_id=1,
            user_id=1,
            context_type=ContextType.ARTIFACT.value,
            name="test.pdf",
            status=ContextStatus.READY.value,
            binary_data=b"",
            type_data={},
        )
        context.id = 101

        # Act
        response = ArtifactResponse.from_context(context)

        # Assert
        assert response.id == 101
        assert response.filename == "test.pdf"  # Falls back to context.name
        assert response.file_size == 0
        assert response.mime_type == ""
        assert response.file_extension == ""
        assert response.file_path is None
        assert response.sandbox_id is None


class TestArtifactContextType:
    """Test ARTIFACT context type integration"""

    def test_artifact_context_type_exists(self):
        """Test that ARTIFACT type is defined in ContextType enum"""
        # Assert
        assert hasattr(ContextType, "ARTIFACT")
        assert ContextType.ARTIFACT.value == "artifact"

    def test_create_artifact_context(self):
        """Test creating a SubtaskContext with ARTIFACT type"""
        # Arrange & Act
        context = SubtaskContext(
            subtask_id=1,
            user_id=1,
            context_type=ContextType.ARTIFACT.value,
            name="report.docx",
            status=ContextStatus.READY.value,
            binary_data=b"",
            image_base64="",
            extracted_text="",
            text_length=0,
            error_message="",
            type_data={
                "original_filename": "report.docx",
                "file_extension": ".docx",
                "file_size": 51200,
                "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "file_path": "/home/user/report.docx",
                "sandbox_id": "sandbox-456",
                "storage_backend": "mysql",
                "storage_key": "artifacts/key123",
            },
        )

        # Assert
        assert context.context_type == "artifact"
        assert context.original_filename == "report.docx"
        assert context.file_extension == ".docx"
        assert context.file_size == 51200
        assert context.storage_key == "artifacts/key123"


class TestArtifactHelperFunctions:
    """Test artifact-related helper functions"""

    def test_get_mime_type_for_pptx(self):
        """Test MIME type detection for PPTX files"""
        from app.api.endpoints.adapter.artifacts import _get_mime_type

        mime_type = _get_mime_type("presentation.pptx")
        assert (
            mime_type
            == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )

    def test_get_mime_type_for_docx(self):
        """Test MIME type detection for DOCX files"""
        from app.api.endpoints.adapter.artifacts import _get_mime_type

        mime_type = _get_mime_type("document.docx")
        assert (
            mime_type
            == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )

    def test_get_mime_type_for_xlsx(self):
        """Test MIME type detection for XLSX files"""
        from app.api.endpoints.adapter.artifacts import _get_mime_type

        mime_type = _get_mime_type("spreadsheet.xlsx")
        assert (
            mime_type
            == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )

    def test_get_mime_type_for_pdf(self):
        """Test MIME type detection for PDF files"""
        from app.api.endpoints.adapter.artifacts import _get_mime_type

        mime_type = _get_mime_type("document.pdf")
        assert mime_type == "application/pdf"

    def test_get_mime_type_for_unknown(self):
        """Test MIME type detection for unknown files"""
        from app.api.endpoints.adapter.artifacts import _get_mime_type

        mime_type = _get_mime_type("unknown.xyz")
        assert mime_type == "application/octet-stream"

    def test_get_file_extension(self):
        """Test file extension extraction"""
        from app.api.endpoints.adapter.artifacts import _get_file_extension

        assert _get_file_extension("test.PPTX") == ".pptx"
        assert _get_file_extension("document.Docx") == ".docx"
        assert _get_file_extension("file.PDF") == ".pdf"
        assert _get_file_extension("noextension") == ""


class TestSubtaskContextBriefArtifact:
    """Test SubtaskContextBrief with artifact type"""

    def test_brief_from_artifact_context(self):
        """Test SubtaskContextBrief.from_model for artifact context"""
        from app.schemas.subtask_context import SubtaskContextBrief

        # Arrange
        context = SubtaskContext(
            subtask_id=1,
            user_id=1,
            context_type=ContextType.ARTIFACT.value,
            name="output.xlsx",
            status=ContextStatus.READY.value,
            binary_data=b"",
            type_data={
                "original_filename": "output.xlsx",
                "file_extension": ".xlsx",
                "file_size": 25600,
                "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "file_path": "/home/user/output.xlsx",
                "sandbox_id": "sandbox-789",
            },
        )
        context.id = 200

        # Act
        brief = SubtaskContextBrief.from_model(context)

        # Assert
        assert brief.id == 200
        assert brief.context_type == "artifact"
        assert brief.name == "output.xlsx"
        assert brief.status == "ready"
        assert brief.file_extension == ".xlsx"
        assert brief.file_size == 25600
        assert brief.file_path == "/home/user/output.xlsx"
        assert brief.sandbox_id == "sandbox-789"
