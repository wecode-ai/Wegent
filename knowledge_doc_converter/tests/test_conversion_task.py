"""Tests for conversion_task module."""

import base64
from unittest.mock import MagicMock, patch

import pytest

from knowledge_doc_converter.config import ConverterSettings

# Common task kwargs used across all task tests
TASK_KWARGS = dict(
    document_id=1,
    attachment_id=42,
    file_extension="pdf",
    original_filename="test.pdf",
    knowledge_base_name="test-kb",
    index_generation=1,
    content_download_path="/api/internal/attachments/42/download",
    callback_status_path="/api/internal/conversion/callback/status",
    callback_completed_path="/api/internal/conversion/callback/completed",
    index_dispatch_payload={"knowledge_base_id": "kb-1"},
)


@pytest.fixture
def mock_settings():
    """Create test settings."""
    return ConverterSettings(
        BACKEND_BASE_URL="http://backend:8000",
        BACKEND_INTERNAL_TOKEN="test-token",
        CELERY_BROKER_URL="redis://localhost:6379/0",
        CELERY_RESULT_BACKEND="redis://localhost:6379/1",
        REDIS_URL="redis://localhost:6379/0",
        KNOWLEDGE_CONVERSION_LOCK_TIMEOUT_SECONDS=12000,
        KNOWLEDGE_CONVERSION_LOCK_EXTEND_INTERVAL_SECONDS=60,
        KNOWLEDGE_CONVERSION_LOCK_MAX_RETRIES=2,
        KNOWLEDGE_CONVERSION_LOCK_RETRY_DELAY_SECONDS=30,
        CONVERSION_TASK_SOFT_TIME_LIMIT=9000,
        CONVERSION_TASK_TIME_LIMIT=10000,
        MINERU_API_BASE_URL="http://mineru:8888",
        MINERU_BACKEND="pipeline",
        MINERU_PARSE_METHOD="ocr",
        MINERU_LANG_LIST="ch",
        MINERU_FORMULA_ENABLE=True,
        MINERU_TABLE_ENABLE=True,
        MINERU_POLL_INTERVAL_SECONDS=3,
        MINERU_MAX_WAIT_SECONDS=600,
        WORKER_CONVERSION_S3_ENABLED=False,
        WORKER_CONVERSION_S3_ENDPOINT="",
        WORKER_CONVERSION_S3_ACCESS_KEY="",
        WORKER_CONVERSION_S3_SECRET_KEY="",
        WORKER_CONVERSION_S3_BUCKET_NAME="",
        WORKER_CONVERSION_S3_REGION_NAME="us-east-1",
    )


def _make_mock_task():
    """Create a mock Celery task self object."""
    mock_self = MagicMock()
    mock_self.request.id = "test-task-id"
    mock_self.request.retries = 0
    mock_self.request.hostname = "test-worker"
    mock_self.max_retries = 2
    return mock_self


class TestBuildMineruConfig:
    """Tests for _build_mineru_config helper."""

    def test_builds_config_from_settings(self, mock_settings):
        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import (
                _build_mineru_config,
            )

            config = _build_mineru_config()
            assert config.api_base_url == "http://mineru:8888"
            assert config.backend == "pipeline"
            assert config.parse_method == "ocr"
            assert config.lang_list == "ch"
            assert config.formula_enable is True
            assert config.table_enable is True
            assert config.poll_interval_seconds == 3
            assert config.max_wait_seconds == 600


class TestBuildS3Config:
    """Tests for _build_s3_config helper."""

    def test_builds_config_from_settings(self, mock_settings):
        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import _build_s3_config

            config = _build_s3_config()
            assert config.enabled is False
            assert config.endpoint == ""
            assert config.access_key == ""
            assert config.bucket_name == ""
            assert config.region_name == "us-east-1"

    def test_builds_config_with_s3_enabled(self, mock_settings):
        mock_settings.WORKER_CONVERSION_S3_ENABLED = True
        mock_settings.WORKER_CONVERSION_S3_ENDPOINT = "http://minio:9000"
        mock_settings.WORKER_CONVERSION_S3_ACCESS_KEY = "minioadmin"
        mock_settings.WORKER_CONVERSION_S3_SECRET_KEY = "minioadmin"
        mock_settings.WORKER_CONVERSION_S3_BUCKET_NAME = "test-bucket"

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import _build_s3_config

            config = _build_s3_config()
            assert config.enabled is True
            assert config.endpoint == "http://minio:9000"
            assert config.access_key == "minioadmin"
            assert config.secret_key == "minioadmin"
            assert config.bucket_name == "test-bucket"


class TestConvertDocumentTask:
    """Tests for the convert_document_task Celery task.

    Uses .run() to call the bound task directly with a mock self object,
    bypassing Celery's dispatch mechanism.
    """

    @patch("knowledge_doc_converter.tasks.conversion_task.lock_service")
    @patch("knowledge_doc_converter.tasks.conversion_task.callback_client")
    def test_lock_retry_exhausted_notifies_backend(
        self, mock_callback, mock_lock, mock_settings
    ):
        """When lock retry is exhausted, converter should notify backend of failure."""
        mock_self = _make_mock_task()
        # Simulate lock not acquired
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=False)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_lock.acquire_watchdog_context.return_value = mock_ctx

        mock_callback.notify_failed.return_value = {
            "ok": True,
            "document_exists": True,
        }

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import (
                convert_document_task,
            )

            # Set retries to max to skip the retry path
            mock_self.request.retries = 2
            # Use __func__ to pass custom mock self
            result = convert_document_task._get_current_object().run.__func__(
                mock_self, **TASK_KWARGS
            )

        assert result["status"] == "skipped"
        assert result["reason"] == "lock_retry_exhausted"
        mock_callback.notify_failed.assert_called_once()

    @patch("knowledge_doc_converter.tasks.conversion_task.lock_service")
    @patch("knowledge_doc_converter.tasks.conversion_task.callback_client")
    def test_started_callback_document_deleted(
        self, mock_callback, mock_lock, mock_settings
    ):
        """When document doesn't exist, task should skip."""
        mock_self = _make_mock_task()

        # Simulate lock acquired
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=True)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_lock.acquire_watchdog_context.return_value = mock_ctx

        # Backend says document doesn't exist
        mock_callback.notify_started.return_value = {
            "ok": True,
            "document_exists": False,
        }

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import (
                convert_document_task,
            )

            result = convert_document_task._get_current_object().run.__func__(
                mock_self, **TASK_KWARGS
            )

        assert result["status"] == "skipped"
        assert result["reason"] == "not_exists_or_stale"

    @patch("knowledge_doc_converter.tasks.conversion_task.lock_service")
    @patch("knowledge_doc_converter.tasks.conversion_task.callback_client")
    @patch("knowledge_doc_converter.tasks.conversion_task.content_fetcher")
    def test_successful_conversion(
        self, mock_fetcher, mock_callback, mock_lock, mock_settings
    ):
        """Test happy path: lock acquired -> started -> fetch -> convert -> completed."""
        mock_self = _make_mock_task()

        # Lock acquired
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=True)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_lock.acquire_watchdog_context.return_value = mock_ctx

        # Started callback succeeds
        mock_callback.notify_started.return_value = {
            "ok": True,
            "document_exists": True,
        }

        # Fetcher returns binary data
        mock_fetcher.download.return_value = b"PDF content"

        # Mock conversion result
        mock_result = MagicMock()
        mock_result.markdown_bytes = b"# Markdown"
        mock_result.uploaded_images = [("image1.png", "http://s3/image1.png")]

        # Completed callback succeeds
        mock_callback.notify_completed.return_value = {
            "ok": True,
            "index_task_id": "index-task-123",
            "skipped": False,
        }

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            with patch(
                "knowledge_engine.conversion.convert_document",
                return_value=mock_result,
            ) as mock_convert:
                from knowledge_doc_converter.tasks.conversion_task import (
                    convert_document_task,
                )

                result = convert_document_task._get_current_object().run.__func__(
                    mock_self, **TASK_KWARGS
                )

        assert result["status"] == "converted"
        assert result["document_id"] == 1
        assert result["index_task_id"] == "index-task-123"

        # Verify conversion was called
        mock_convert.assert_called_once()
        mock_fetcher.download.assert_called_once_with(
            "/api/internal/attachments/42/download"
        )
        mock_callback.notify_started.assert_called_once()
        mock_callback.notify_completed.assert_called_once()
        call_kwargs = mock_callback.notify_completed.call_args[1]
        # TASK_KWARGS: original_filename="test.pdf", file_extension="pdf"
        # expected: filename_without_ext="test", md_filename="test.pdf.md"
        assert call_kwargs["converted_name"] == "test.pdf.md"
        assert call_kwargs["converted_extension"] == "md"

    @patch("knowledge_doc_converter.tasks.conversion_task.lock_service")
    @patch("knowledge_doc_converter.tasks.conversion_task.callback_client")
    @patch("knowledge_doc_converter.tasks.conversion_task.content_fetcher")
    def test_stale_conversion_skipped(
        self, mock_fetcher, mock_callback, mock_lock, mock_settings
    ):
        """When backend reports stale conversion, task should skip."""
        mock_self = _make_mock_task()

        # Lock acquired
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=True)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_lock.acquire_watchdog_context.return_value = mock_ctx

        mock_callback.notify_started.return_value = {
            "ok": True,
            "document_exists": True,
        }

        mock_fetcher.download.return_value = b"PDF content"

        mock_result = MagicMock()
        mock_result.markdown_bytes = b"# Markdown"
        mock_result.uploaded_images = []

        # Backend reports stale
        mock_callback.notify_completed.return_value = {
            "ok": True,
            "skipped": True,
            "skip_reason": "stale_conversion",
        }

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            with patch(
                "knowledge_engine.conversion.convert_document",
                return_value=mock_result,
            ):
                from knowledge_doc_converter.tasks.conversion_task import (
                    convert_document_task,
                )

                result = convert_document_task._get_current_object().run.__func__(
                    mock_self, **TASK_KWARGS
                )

        assert result["status"] == "skipped"
        assert result["reason"] == "stale_conversion"

    @patch("knowledge_doc_converter.tasks.conversion_task.lock_service")
    @patch("knowledge_doc_converter.tasks.conversion_task.callback_client")
    @patch("knowledge_doc_converter.tasks.conversion_task.content_fetcher")
    def test_conversion_error_notifies_backend(
        self, mock_fetcher, mock_callback, mock_lock, mock_settings
    ):
        """When conversion fails, converter should notify backend."""
        mock_self = _make_mock_task()

        # Lock acquired
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=True)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_lock.acquire_watchdog_context.return_value = mock_ctx

        mock_callback.notify_started.return_value = {
            "ok": True,
            "document_exists": True,
        }

        # Fetcher raises error
        mock_fetcher.download.side_effect = RuntimeError("Download failed")

        # Failed callback
        mock_callback.notify_failed.return_value = {
            "ok": True,
            "document_exists": True,
        }

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import (
                convert_document_task,
            )

            with pytest.raises(RuntimeError, match="Download failed"):
                convert_document_task._get_current_object().run.__func__(
                    mock_self, **TASK_KWARGS
                )

        mock_callback.notify_failed.assert_called_once()

    @patch("knowledge_doc_converter.tasks.conversion_task.lock_service")
    @patch("knowledge_doc_converter.tasks.conversion_task.callback_client")
    @patch("knowledge_doc_converter.tasks.conversion_task.content_fetcher")
    def test_conversion_error_document_deleted(
        self, mock_fetcher, mock_callback, mock_lock, mock_settings
    ):
        """When conversion fails and document was deleted, skip gracefully."""
        mock_self = _make_mock_task()

        # Lock acquired
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=True)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_lock.acquire_watchdog_context.return_value = mock_ctx

        mock_callback.notify_started.return_value = {
            "ok": True,
            "document_exists": True,
        }

        mock_fetcher.download.side_effect = RuntimeError("Download failed")

        # Backend says document was deleted
        mock_callback.notify_failed.return_value = {
            "ok": True,
            "document_exists": False,
        }

        with patch(
            "knowledge_doc_converter.tasks.conversion_task.settings", mock_settings
        ):
            from knowledge_doc_converter.tasks.conversion_task import (
                convert_document_task,
            )

            result = convert_document_task._get_current_object().run.__func__(
                mock_self, **TASK_KWARGS
            )

        assert result["status"] == "skipped"
        assert result["reason"] == "document_deleted"
