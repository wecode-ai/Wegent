# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests to verify multi-worker issues are fixed.

These tests verify:
1. File upload uses chunked streaming (rag.py streams to disk, attachments.py validates early)
2. Database connection pool is configurable via environment variables
"""

import io
import os
import re
import tempfile
from pathlib import Path

import pytest
from fastapi import UploadFile
from starlette.datastructures import Headers


class TestFileUploadChunkedRead:
    """Verify file upload endpoints use chunked streaming."""

    def test_rag_upload_uses_chunked_read(self):
        """
        Verify that RAG upload endpoint uses chunked read and streams to disk.
        """
        rag_file = Path(__file__).parent.parent / "app" / "api" / "endpoints" / "rag.py"
        content = rag_file.read_text()

        # Should have chunked read pattern: await file.read(CHUNK_SIZE)
        chunked_pattern = r"while\s+chunk\s*:=\s*await\s+file\.read\(CHUNK_SIZE\)"
        match = re.search(chunked_pattern, content)

        assert match is not None, (
            "Expected to find chunked read pattern 'while chunk := await file.read(CHUNK_SIZE)' "
            "in rag.py upload_document function."
        )

        # Should NOT have full file read pattern
        full_read_pattern = r"content\s*=\s*await\s+file\.read\(\)"
        full_read_match = re.search(full_read_pattern, content)

        assert full_read_match is None, (
            "Found problematic pattern 'content = await file.read()' in rag.py. "
            "This should have been replaced with chunked streaming."
        )

    def test_attachment_upload_uses_chunked_read(self):
        """
        Verify that attachment upload endpoint uses chunked read for early validation.
        """
        attachments_file = (
            Path(__file__).parent.parent
            / "app"
            / "api"
            / "endpoints"
            / "adapter"
            / "attachments.py"
        )
        content = attachments_file.read_text()

        # Should have chunked read pattern
        chunked_pattern = r"while\s+chunk\s*:=\s*await\s+file\.read\(CHUNK_SIZE\)"
        match = re.search(chunked_pattern, content)

        assert match is not None, (
            "Expected to find chunked read pattern in attachments.py upload_attachment function."
        )

        # Should NOT have the old full file read pattern
        full_read_pattern = r"binary_data\s*=\s*await\s+file\.read\(\)"
        full_read_match = re.search(full_read_pattern, content)

        assert full_read_match is None, (
            "Found problematic pattern 'binary_data = await file.read()' in attachments.py. "
            "This should have been replaced with chunked streaming."
        )

        # Verify comment accurately describes memory accumulation behavior
        assert "Data is still accumulated in memory" in content, (
            "Comment should accurately describe that data is accumulated in memory."
        )


class TestDatabaseConnectionPoolConfig:
    """Test database connection pool configuration."""

    def test_config_has_pool_settings(self):
        """
        Verify that config.py has database pool configuration options.
        """
        from app.core.config import settings

        # Verify all pool settings exist
        assert hasattr(settings, "DB_POOL_SIZE"), "Config should have DB_POOL_SIZE"
        assert hasattr(settings, "DB_MAX_OVERFLOW"), "Config should have DB_MAX_OVERFLOW"
        assert hasattr(settings, "DB_POOL_RECYCLE"), "Config should have DB_POOL_RECYCLE"
        assert hasattr(settings, "DB_POOL_TIMEOUT"), "Config should have DB_POOL_TIMEOUT"

        # Verify default values
        assert settings.DB_POOL_SIZE == 5
        assert settings.DB_MAX_OVERFLOW == 10
        assert settings.DB_POOL_RECYCLE == 3600
        assert settings.DB_POOL_TIMEOUT == 30

    def test_engine_uses_config_settings(self):
        """
        Verify that the engine uses configuration settings.
        """
        from app.db.session import engine

        pool = engine.pool

        # Verify pool settings match config
        from app.core.config import settings

        assert pool.size() == settings.DB_POOL_SIZE
        assert pool._max_overflow == settings.DB_MAX_OVERFLOW
        assert pool._recycle == settings.DB_POOL_RECYCLE
        assert pool._timeout == settings.DB_POOL_TIMEOUT

    def test_session_file_uses_settings(self):
        """
        Verify that session.py uses settings for pool configuration.
        """
        session_file = Path(__file__).parent.parent / "app" / "db" / "session.py"
        content = session_file.read_text()

        # Should use settings for all pool parameters
        assert "settings.DB_POOL_SIZE" in content
        assert "settings.DB_MAX_OVERFLOW" in content
        assert "settings.DB_POOL_RECYCLE" in content
        assert "settings.DB_POOL_TIMEOUT" in content


class TestStreamingUploadBehavior:
    """Test that streaming upload approach works correctly."""

    @pytest.mark.asyncio
    async def test_chunked_read_processes_correctly(self):
        """
        Test that chunked read approach processes files correctly.
        """
        file_size = 5 * 1024 * 1024  # 5MB
        file_content = b"x" * file_size

        file_like = io.BytesIO(file_content)
        upload_file = UploadFile(
            file=file_like,
            filename="test_file.txt",
            headers=Headers({"content-type": "text/plain"}),
        )

        # Use streaming approach (same as fixed code)
        CHUNK_SIZE = 1024 * 1024  # 1MB chunks
        total_bytes = 0
        chunks_count = 0

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            while chunk := await upload_file.read(CHUNK_SIZE):
                tmp.write(chunk)
                total_bytes += len(chunk)
                chunks_count += 1
            tmp_path = tmp.name

        # Verify correct processing
        assert total_bytes == file_size
        assert chunks_count == 5  # 5MB / 1MB = 5 chunks

        # Verify temp file content
        with open(tmp_path, "rb") as f:
            saved_content = f.read()
        assert saved_content == file_content

        # Cleanup
        os.unlink(tmp_path)

    @pytest.mark.asyncio
    async def test_spooled_temp_file_behavior(self):
        """
        Test SpooledTemporaryFile behavior for memory-efficient uploads.
        """
        from tempfile import SpooledTemporaryFile

        max_size = 1024 * 1024  # 1MB threshold

        # Small file stays in memory
        small_content = b"x" * (max_size // 2)
        with SpooledTemporaryFile(max_size=max_size, mode="w+b") as f:
            f.write(small_content)
            assert not f._rolled, "Small file should stay in memory"

        # Large file spills to disk
        large_content = b"x" * (max_size * 2)
        with SpooledTemporaryFile(max_size=max_size, mode="w+b") as f:
            f.write(large_content)
            assert f._rolled, "Large file should spill to disk"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
