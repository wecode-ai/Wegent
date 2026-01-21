# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Artifact Uploader service.

Tests the artifact upload functionality for sandbox-generated files.
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest


class TestArtifactUploader:
    """Test artifact uploader functionality"""

    def test_should_upload_artifact_pptx(self):
        """Test that PPTX files are identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert ArtifactUploader.should_upload_artifact("/home/user/output.pptx") is True
        assert ArtifactUploader.should_upload_artifact("presentation.PPTX") is True

    def test_should_upload_artifact_docx(self):
        """Test that DOCX files are identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert ArtifactUploader.should_upload_artifact("/home/user/report.docx") is True
        assert ArtifactUploader.should_upload_artifact("document.DOCX") is True

    def test_should_upload_artifact_xlsx(self):
        """Test that XLSX files are identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert (
            ArtifactUploader.should_upload_artifact("/home/user/spreadsheet.xlsx")
            is True
        )
        assert ArtifactUploader.should_upload_artifact("data.XLSX") is True

    def test_should_upload_artifact_pdf(self):
        """Test that PDF files are identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert ArtifactUploader.should_upload_artifact("/home/user/document.pdf") is True
        assert ArtifactUploader.should_upload_artifact("report.PDF") is True

    def test_should_upload_artifact_images(self):
        """Test that image files are identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert ArtifactUploader.should_upload_artifact("/home/user/image.png") is True
        assert ArtifactUploader.should_upload_artifact("photo.jpg") is True
        assert ArtifactUploader.should_upload_artifact("image.jpeg") is True
        assert ArtifactUploader.should_upload_artifact("graphic.gif") is True
        assert ArtifactUploader.should_upload_artifact("icon.svg") is True

    def test_should_not_upload_artifact_text(self):
        """Test that text files are not identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert (
            ArtifactUploader.should_upload_artifact("/home/user/readme.txt") is False
        )
        assert ArtifactUploader.should_upload_artifact("code.py") is False
        assert ArtifactUploader.should_upload_artifact("script.js") is False
        assert ArtifactUploader.should_upload_artifact("style.css") is False

    def test_should_upload_artifact_archives(self):
        """Test that archive files are identified for upload"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        assert ArtifactUploader.should_upload_artifact("/home/user/files.zip") is True
        assert ArtifactUploader.should_upload_artifact("backup.tar") is True
        assert ArtifactUploader.should_upload_artifact("compressed.gz") is True

    def test_artifact_uploader_initialization(self):
        """Test artifact uploader initialization"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploader

        uploader = ArtifactUploader(
            task_id=123,
            subtask_id=456,
            auth_token="test-token",
            sandbox_id="sandbox-abc",
        )

        assert uploader.task_id == 123
        assert uploader.subtask_id == 456
        assert uploader.auth_token == "test-token"
        assert uploader.sandbox_id == "sandbox-abc"

    def test_build_upload_url(self):
        """Test upload URL building"""
        import os
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")

        # Set environment variable for test
        with patch.dict(os.environ, {"TASK_API_DOMAIN": "http://localhost:8000"}):
            from artifact_uploader import ArtifactUploader

            uploader = ArtifactUploader(
                task_id=1, subtask_id=2, auth_token="token", sandbox_id="sandbox"
            )

            url = uploader._build_upload_url()
            assert url == "http://localhost:8000/api/artifacts/upload"


class TestArtifactUploadResult:
    """Test ArtifactUploadResult dataclass"""

    def test_success_result(self):
        """Test creating a successful upload result"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploadResult

        result = ArtifactUploadResult(
            success=True,
            artifact_id=100,
            filename="presentation.pptx",
            file_size=102400,
        )

        assert result.success is True
        assert result.artifact_id == 100
        assert result.filename == "presentation.pptx"
        assert result.file_size == 102400
        assert result.error is None

    def test_failure_result(self):
        """Test creating a failed upload result"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ArtifactUploadResult

        result = ArtifactUploadResult(
            success=False,
            error="Connection timeout",
        )

        assert result.success is False
        assert result.artifact_id is None
        assert result.filename is None
        assert result.file_size is None
        assert result.error == "Connection timeout"


class TestArtifactExtensions:
    """Test artifact file extension constants"""

    def test_artifact_extensions_includes_office_formats(self):
        """Test that ARTIFACT_EXTENSIONS includes Office formats"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ARTIFACT_EXTENSIONS

        assert ".pptx" in ARTIFACT_EXTENSIONS
        assert ".ppt" in ARTIFACT_EXTENSIONS
        assert ".docx" in ARTIFACT_EXTENSIONS
        assert ".doc" in ARTIFACT_EXTENSIONS
        assert ".xlsx" in ARTIFACT_EXTENSIONS
        assert ".xls" in ARTIFACT_EXTENSIONS

    def test_artifact_extensions_includes_pdf(self):
        """Test that ARTIFACT_EXTENSIONS includes PDF"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ARTIFACT_EXTENSIONS

        assert ".pdf" in ARTIFACT_EXTENSIONS

    def test_artifact_extensions_includes_images(self):
        """Test that ARTIFACT_EXTENSIONS includes image formats"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ARTIFACT_EXTENSIONS

        assert ".png" in ARTIFACT_EXTENSIONS
        assert ".jpg" in ARTIFACT_EXTENSIONS
        assert ".jpeg" in ARTIFACT_EXTENSIONS
        assert ".gif" in ARTIFACT_EXTENSIONS
        assert ".svg" in ARTIFACT_EXTENSIONS

    def test_artifact_extensions_includes_data_formats(self):
        """Test that ARTIFACT_EXTENSIONS includes data formats"""
        import sys

        sys.path.insert(0, "/workspace/136420/Wegent/backend/init_data/skills/sandbox")
        from artifact_uploader import ARTIFACT_EXTENSIONS

        assert ".html" in ARTIFACT_EXTENSIONS
        assert ".csv" in ARTIFACT_EXTENSIONS
        assert ".json" in ARTIFACT_EXTENSIONS
        assert ".xml" in ARTIFACT_EXTENSIONS
