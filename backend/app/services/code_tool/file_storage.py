# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""File storage service for Code Tool file uploads and downloads."""

import asyncio
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from app.core.config import settings

logger = logging.getLogger(__name__)


class FileStorageService:
    """Service for managing Code Tool file uploads and downloads."""

    def __init__(self):
        """Initialize file storage service."""
        self.temp_dir = Path(
            getattr(settings, "CODE_TOOL_TEMP_DIR", "/tmp/code-tool")
        )
        self.max_file_size = getattr(
            settings, "CODE_TOOL_MAX_FILE_SIZE", 100 * 1024 * 1024
        )  # 100MB
        self.link_expire_seconds = getattr(
            settings, "CODE_TOOL_DOWNLOAD_LINK_EXPIRE", 86400
        )  # 24 hours

        # Ensure temp directory exists
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"File storage initialized at {self.temp_dir}")

    def _get_session_dir(self, session_id: str, subdir: str = "") -> Path:
        """Get session-specific directory."""
        path = self.temp_dir / session_id
        if subdir:
            path = path / subdir
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def store_file(
        self,
        session_id: str,
        filename: str,
        content: bytes,
        subdir: str = "input",
    ) -> dict:
        """
        Store a file for a session.

        Args:
            session_id: Session identifier
            filename: Original filename
            content: File content as bytes
            subdir: Subdirectory (input/output)

        Returns:
            Dict with file_id, path, size
        """
        if len(content) > self.max_file_size:
            raise ValueError(
                f"File size exceeds maximum allowed size of {self.max_file_size} bytes"
            )

        file_id = str(uuid.uuid4())
        session_dir = self._get_session_dir(session_id, subdir)

        # Sanitize filename
        safe_filename = self._sanitize_filename(filename)
        file_path = session_dir / f"{file_id}_{safe_filename}"

        # Write file
        await asyncio.to_thread(self._write_file, file_path, content)

        logger.info(
            f"Stored file {filename} for session {session_id}: {file_path}"
        )

        return {
            "file_id": file_id,
            "filename": safe_filename,
            "path": str(file_path),
            "size": len(content),
            "created_at": datetime.now().isoformat(),
        }

    def _write_file(self, path: Path, content: bytes) -> None:
        """Synchronous file write."""
        with open(path, "wb") as f:
            f.write(content)

    def _sanitize_filename(self, filename: str) -> str:
        """Sanitize filename to prevent path traversal."""
        # Remove path separators and null bytes
        filename = os.path.basename(filename)
        filename = filename.replace("\x00", "")

        # Keep only safe characters
        safe_chars = set(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
        )
        sanitized = "".join(c if c in safe_chars else "_" for c in filename)

        # Ensure filename is not empty
        if not sanitized:
            sanitized = "file"

        return sanitized

    async def get_file(self, session_id: str, file_id: str) -> Optional[dict]:
        """
        Get file info by ID.

        Args:
            session_id: Session identifier
            file_id: File identifier

        Returns:
            File info dict or None if not found
        """
        session_dir = self._get_session_dir(session_id)

        # Search in input and output directories
        for subdir in ["input", "output"]:
            subdir_path = session_dir / subdir
            if not subdir_path.exists():
                continue

            for file_path in subdir_path.iterdir():
                if file_path.name.startswith(f"{file_id}_"):
                    filename = file_path.name[len(file_id) + 1 :]
                    stat = file_path.stat()
                    return {
                        "file_id": file_id,
                        "filename": filename,
                        "path": str(file_path),
                        "size": stat.st_size,
                        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                    }

        return None

    async def read_file(self, session_id: str, file_id: str) -> Optional[bytes]:
        """
        Read file content by ID.

        Args:
            session_id: Session identifier
            file_id: File identifier

        Returns:
            File content as bytes or None if not found
        """
        file_info = await self.get_file(session_id, file_id)
        if not file_info:
            return None

        return await asyncio.to_thread(self._read_file, Path(file_info["path"]))

    def _read_file(self, path: Path) -> bytes:
        """Synchronous file read."""
        with open(path, "rb") as f:
            return f.read()

    async def get_session_input_dir(self, session_id: str) -> str:
        """Get input directory path for a session."""
        return str(self._get_session_dir(session_id, "input"))

    async def get_session_output_dir(self, session_id: str) -> str:
        """Get output directory path for a session."""
        return str(self._get_session_dir(session_id, "output"))

    async def list_output_files(self, session_id: str) -> list[dict]:
        """
        List all output files for a session.

        Args:
            session_id: Session identifier

        Returns:
            List of file info dicts
        """
        output_dir = self._get_session_dir(session_id, "output")
        files = []

        if not output_dir.exists():
            return files

        for file_path in output_dir.iterdir():
            if file_path.is_file():
                # Extract file_id and filename from stored name
                name = file_path.name
                if "_" in name:
                    file_id = name.split("_")[0]
                    filename = name[len(file_id) + 1 :]
                else:
                    file_id = str(uuid.uuid4())
                    filename = name

                stat = file_path.stat()
                files.append(
                    {
                        "file_id": file_id,
                        "filename": filename,
                        "path": str(file_path),
                        "size": stat.st_size,
                        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                    }
                )

        return files

    async def cleanup_session(self, session_id: str) -> bool:
        """
        Clean up all files for a session.

        Args:
            session_id: Session identifier

        Returns:
            True if cleanup was successful
        """
        session_dir = self.temp_dir / session_id
        if session_dir.exists():
            try:
                await asyncio.to_thread(shutil.rmtree, session_dir)
                logger.info(f"Cleaned up session {session_id}")
                return True
            except Exception as e:
                logger.error(f"Failed to cleanup session {session_id}: {e}")
                return False
        return True

    async def cleanup_expired_sessions(
        self, max_age_hours: int = 24
    ) -> int:
        """
        Clean up sessions older than max_age_hours.

        Args:
            max_age_hours: Maximum age in hours

        Returns:
            Number of sessions cleaned up
        """
        if not self.temp_dir.exists():
            return 0

        cutoff = datetime.now() - timedelta(hours=max_age_hours)
        cleaned = 0

        for session_dir in self.temp_dir.iterdir():
            if not session_dir.is_dir():
                continue

            try:
                stat = session_dir.stat()
                mtime = datetime.fromtimestamp(stat.st_mtime)

                if mtime < cutoff:
                    await asyncio.to_thread(shutil.rmtree, session_dir)
                    cleaned += 1
                    logger.info(f"Cleaned up expired session: {session_dir.name}")
            except Exception as e:
                logger.warning(f"Failed to process {session_dir}: {e}")

        return cleaned


# Singleton instance
file_storage_service = FileStorageService()
