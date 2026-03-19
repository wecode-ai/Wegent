# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Binary replacer for executor self-update.

Downloads new binary and performs atomic replacement with backup.
"""

import logging
import os
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Callable, Optional

from shared.utils.http_client import traced_session

logger = logging.getLogger(__name__)


class BinaryReplacer:
    """Download and replace executor binary with atomic operations.

    Downloads the new binary to a temporary location, creates a backup,
    and performs an atomic replacement to ensure the binary is never
    left in a corrupted state.
    """

    DOWNLOAD_TIMEOUT = 300  # 5 minutes for large binaries
    DOWNLOAD_CHUNK_SIZE = 8192  # 8KB chunks for streaming

    def __init__(self, download_url: str, auth_token: Optional[str] = None):
        """Initialize binary replacer.

        Args:
            download_url: URL to download the new binary from
            auth_token: Optional authentication token for the download API
        """
        self.download_url = download_url
        self.auth_token = auth_token

    def download_binary(
        self,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Path:
        """Download binary to temp location with streaming.

        Args:
            progress_callback: Optional callback(bytes_downloaded, total_bytes)
                Called periodically during download to report progress.

        Returns:
            Path to the downloaded temporary file

        Raises:
            RuntimeError: If download fails (network error, HTTP error, etc.)
        """
        headers = {}
        if self.auth_token:
            headers["PRIVATE-TOKEN"] = self.auth_token

        try:
            session = traced_session()
            response = session.get(
                self.download_url,
                headers=headers,
                timeout=self.DOWNLOAD_TIMEOUT,
                stream=True,
            )
            response.raise_for_status()

            # Get total size if available
            total_size = response.headers.get("content-length")
            if total_size:
                total_size = int(total_size)

            # Create temp file with restrictive permissions
            fd, temp_path = tempfile.mkstemp(suffix="-wegent-executor-new")
            os.close(fd)
            temp_file = Path(temp_path)

            try:
                downloaded = 0
                with open(temp_file, "wb") as f:
                    for chunk in response.iter_content(chunk_size=self.DOWNLOAD_CHUNK_SIZE):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if progress_callback:
                                progress_callback(downloaded, total_size)

                return temp_file

            except Exception:
                # Clean up temp file on error
                if temp_file.exists():
                    temp_file.unlink()
                raise

        except Exception as e:
            raise RuntimeError(f"Failed to download binary: {e}")

    def replace_binary(self, new_binary: Path, current_binary: Path) -> bool:
        """Atomically replace current binary with backup.

        Performs the following steps:
        1. Create backup at {current_binary}.backup
        2. Set executable permissions on new binary (0o755)
        3. Atomically replace current binary with new one

        Args:
            new_binary: Path to the new binary (temp download location)
            current_binary: Path to the currently running binary

        Returns:
            True if replacement succeeded, False otherwise

        Note:
            os.replace() is atomic on POSIX systems. On Windows, it may
            fail if the binary is running - this is handled by the caller.
        """
        backup_path = current_binary.with_suffix(".backup")

        try:
            # Create backup of current binary if it exists
            if current_binary.exists():
                shutil.copy2(current_binary, backup_path)
                logger.debug(f"Created backup at {backup_path}")

            # Set executable permissions on new binary
            # 0o755 = rwxr-xr-x (owner can read/write/execute, group/others can read/execute)
            os.chmod(new_binary, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)

            # Atomic replace: new_binary -> current_binary
            # On POSIX, os.replace is atomic. On Windows, it may fail if binary is in use.
            os.replace(new_binary, current_binary)

            logger.info(f"Successfully replaced binary at {current_binary}")
            return True

        except PermissionError as e:
            logger.error(f"Permission denied during binary replacement: {e}")
            # Clean up on failure
            self._cleanup_on_failure(new_binary, backup_path, current_binary)
            return False
        except Exception as e:
            logger.error(f"Failed to replace binary: {e}")
            self._cleanup_on_failure(new_binary, backup_path, current_binary)
            return False

    def _cleanup_on_failure(
        self, new_binary: Path, backup_path: Path, current_binary: Path
    ) -> None:
        """Clean up temporary files on failure.

        Args:
            new_binary: Path to the new binary temp file
            backup_path: Path to the backup file
            current_binary: Path to the current binary
        """
        # Remove temp download if it exists
        if new_binary.exists():
            try:
                new_binary.unlink()
            except OSError:
                pass

        # If current binary was somehow removed, try to restore from backup
        if not current_binary.exists() and backup_path.exists():
            try:
                shutil.move(backup_path, current_binary)
                logger.warning("Restored binary from backup after failure")
            except OSError as e:
                logger.error(f"Failed to restore from backup: {e}")

    def cleanup_backup(self, current_binary: Path) -> bool:
        """Remove backup after successful update confirmation.

        Args:
            current_binary: Path to the current binary

        Returns:
            True if backup was removed or didn't exist, False on error
        """
        backup_path = current_binary.with_suffix(".backup")

        if not backup_path.exists():
            return True

        try:
            backup_path.unlink()
            logger.debug(f"Cleaned up backup at {backup_path}")
            return True
        except OSError as e:
            logger.warning(f"Failed to clean up backup: {e}")
            return False

    @staticmethod
    def format_progress_bar(downloaded: int, total: Optional[int], width: int = 40) -> str:
        """Format a progress bar for terminal display.

        Args:
            downloaded: Bytes downloaded so far
            total: Total bytes to download (None if unknown)
            width: Width of the progress bar in characters

        Returns:
            Formatted progress string like "[====>    ] 45% (23 MB / 50 MB)"
        """
        if total and total > 0:
            percent = min(100, int(100 * downloaded / total))
            filled = int(width * percent / 100)
            bar = "=" * filled + ">" + " " * (width - filled - 1)
            size_str = f"({downloaded // (1024 * 1024)} MB / {total // (1024 * 1024)} MB)"
            return f"[{bar}] {percent}% {size_str}"
        else:
            # Unknown total size
            mb = downloaded // (1024 * 1024)
            bar = "=" * width
            return f"[{bar}] {mb} MB downloaded"
