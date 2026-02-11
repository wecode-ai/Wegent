# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox file syncer service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.sandbox_file_syncer import (
    SandboxFileSyncer,
    _sanitize_filename,
    build_sandbox_attachment_path,
    get_sandbox_file_syncer,
    sync_attachment_to_sandbox_background,
)


class TestSanitizeFilename:
    """Tests for _sanitize_filename function."""

    def test_normal_filename(self):
        """Test normal filename is unchanged."""
        assert _sanitize_filename("document.pdf") == "document.pdf"

    def test_filename_with_path(self):
        """Test filename with path components is sanitized."""
        assert _sanitize_filename("/etc/passwd") == "passwd"
        assert _sanitize_filename("../../../etc/passwd") == "passwd"

    def test_filename_with_backslash(self):
        """Test filename with backslash is sanitized."""
        # On Linux, os.path.basename doesn't recognize Windows paths
        # So backslashes are replaced with underscores
        result = _sanitize_filename("C:\\Windows\\System32\\file.txt")
        # Result should not contain backslashes
        assert "\\" not in result
        assert "/" not in result

    def test_filename_with_control_chars(self):
        """Test filename with control characters is sanitized."""
        assert _sanitize_filename("file\nname.pdf") == "filename.pdf"
        assert _sanitize_filename("file\rname.pdf") == "filename.pdf"

    def test_empty_filename(self):
        """Test empty filename returns default."""
        assert _sanitize_filename("") == "attachment"
        assert _sanitize_filename(None) == "attachment"

    def test_only_path_separators(self):
        """Test filename with only path separators."""
        assert _sanitize_filename("///") == "attachment"


class TestBuildSandboxAttachmentPath:
    """Tests for build_sandbox_attachment_path function."""

    def test_normal_path(self):
        """Test normal path generation."""
        path = build_sandbox_attachment_path(123, 456, "document.pdf")
        assert path == "/home/user/123:executor:attachments/456/document.pdf"

    def test_path_with_unsafe_filename(self):
        """Test path generation with unsafe filename."""
        path = build_sandbox_attachment_path(123, 456, "../../../etc/passwd")
        assert path == "/home/user/123:executor:attachments/456/passwd"

    def test_path_with_special_chars(self):
        """Test path generation with special characters in filename."""
        path = build_sandbox_attachment_path(123, 456, "file\nwith\rnewlines.pdf")
        assert path == "/home/user/123:executor:attachments/456/filewithnewlines.pdf"


class TestSandboxFileSyncer:
    """Tests for SandboxFileSyncer class."""

    def test_init_default_values(self):
        """Test syncer initializes with default values."""
        syncer = SandboxFileSyncer()
        assert syncer.executor_manager_url == "http://localhost:8001"
        assert syncer.file_sync_timeout == 30.0
        assert syncer.status_check_timeout == 5.0

    def test_init_custom_values(self):
        """Test syncer initializes with custom values."""
        syncer = SandboxFileSyncer(
            executor_manager_url="http://custom:9000",
            file_sync_timeout=60.0,
            status_check_timeout=10.0,
        )
        assert syncer.executor_manager_url == "http://custom:9000"
        assert syncer.file_sync_timeout == 60.0
        assert syncer.status_check_timeout == 10.0

    @pytest.mark.asyncio
    async def test_is_sandbox_healthy_running(self):
        """Test sandbox health check returns True for running sandbox."""
        syncer = SandboxFileSyncer()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "status": "running",
            "base_url": "http://sandbox:8080",
        }

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=mock_client_instance
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)

            is_healthy, base_url = await syncer.is_sandbox_healthy(123)

            assert is_healthy is True
            assert base_url == "http://sandbox:8080"

    @pytest.mark.asyncio
    async def test_is_sandbox_healthy_not_found(self):
        """Test sandbox health check returns False when sandbox not found."""
        syncer = SandboxFileSyncer()

        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=mock_client_instance
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)

            is_healthy, base_url = await syncer.is_sandbox_healthy(123)

            assert is_healthy is False
            assert base_url is None

    @pytest.mark.asyncio
    async def test_is_sandbox_healthy_not_running(self):
        """Test sandbox health check returns False for non-running sandbox."""
        syncer = SandboxFileSyncer()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "status": "pending",
            "base_url": None,
        }

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=mock_client_instance
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)

            is_healthy, base_url = await syncer.is_sandbox_healthy(123)

            assert is_healthy is False
            assert base_url is None

    @pytest.mark.asyncio
    async def test_is_sandbox_healthy_timeout(self):
        """Test sandbox health check returns False on timeout."""
        import httpx

        syncer = SandboxFileSyncer()

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(
                side_effect=httpx.TimeoutException("timeout")
            )
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=mock_client_instance
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)

            is_healthy, base_url = await syncer.is_sandbox_healthy(123)

            assert is_healthy is False
            assert base_url is None

    @pytest.mark.asyncio
    async def test_upload_file_to_sandbox_success(self):
        """Test file upload to sandbox succeeds."""
        syncer = SandboxFileSyncer()

        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.post = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=mock_client_instance
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)

            success = await syncer.upload_file_to_sandbox(
                base_url="http://sandbox:8080",
                remote_path="/home/user/123:executor:attachments/456/doc.pdf",
                binary_data=b"test content",
                filename="doc.pdf",
            )

            assert success is True

    @pytest.mark.asyncio
    async def test_upload_file_to_sandbox_failure(self):
        """Test file upload to sandbox fails."""
        syncer = SandboxFileSyncer()

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal server error"

        with patch("httpx.AsyncClient") as mock_client:
            mock_client_instance = AsyncMock()
            mock_client_instance.post = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__ = AsyncMock(
                return_value=mock_client_instance
            )
            mock_client.return_value.__aexit__ = AsyncMock(return_value=None)

            success = await syncer.upload_file_to_sandbox(
                base_url="http://sandbox:8080",
                remote_path="/home/user/123:executor:attachments/456/doc.pdf",
                binary_data=b"test content",
                filename="doc.pdf",
            )

            assert success is False

    @pytest.mark.asyncio
    async def test_sync_attachment_to_sandbox_success(self):
        """Test full sync flow succeeds."""
        syncer = SandboxFileSyncer()

        with patch.object(syncer, "is_sandbox_healthy") as mock_healthy:
            mock_healthy.return_value = (True, "http://sandbox:8080")

            with patch.object(syncer, "upload_file_to_sandbox") as mock_upload:
                mock_upload.return_value = True

                success = await syncer.sync_attachment_to_sandbox(
                    task_id=123,
                    subtask_id=456,
                    filename="document.pdf",
                    binary_data=b"test content",
                )

                assert success is True
                mock_upload.assert_called_once()

    @pytest.mark.asyncio
    async def test_sync_attachment_to_sandbox_not_healthy(self):
        """Test sync skipped when sandbox not healthy."""
        syncer = SandboxFileSyncer()

        with patch.object(syncer, "is_sandbox_healthy") as mock_healthy:
            mock_healthy.return_value = (False, None)

            with patch.object(syncer, "upload_file_to_sandbox") as mock_upload:
                success = await syncer.sync_attachment_to_sandbox(
                    task_id=123,
                    subtask_id=456,
                    filename="document.pdf",
                    binary_data=b"test content",
                )

                assert success is False
                mock_upload.assert_not_called()


class TestGlobalSyncer:
    """Tests for global syncer instance."""

    def test_get_sandbox_file_syncer_singleton(self):
        """Test get_sandbox_file_syncer returns same instance."""
        # Reset global instance
        import app.services.sandbox_file_syncer as module

        module._sandbox_file_syncer = None

        syncer1 = get_sandbox_file_syncer()
        syncer2 = get_sandbox_file_syncer()

        assert syncer1 is syncer2

    @pytest.mark.asyncio
    async def test_sync_attachment_to_sandbox_background(self):
        """Test background sync function delegates to syncer instance."""
        with patch(
            "app.services.sandbox_file_syncer.get_sandbox_file_syncer"
        ) as mock_get:
            mock_syncer = AsyncMock()
            mock_syncer.sync_attachment_to_sandbox = AsyncMock(return_value=True)
            mock_get.return_value = mock_syncer

            await sync_attachment_to_sandbox_background(
                task_id=123,
                subtask_id=456,
                filename="doc.pdf",
                binary_data=b"content",
            )

            mock_syncer.sync_attachment_to_sandbox.assert_called_once_with(
                task_id=123,
                subtask_id=456,
                filename="doc.pdf",
                binary_data=b"content",
            )
