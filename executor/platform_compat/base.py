# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract base classes for platform-specific operations.

These classes define the interface that platform-specific implementations must follow.
"""

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional, Tuple


class PtyProcess(ABC):
    """Abstract base class for PTY process wrapper."""

    @abstractmethod
    def read(self, size: int = 4096) -> bytes:
        """Read data from the PTY.

        Args:
            size: Maximum number of bytes to read.

        Returns:
            Bytes read from the PTY, or empty bytes if no data available.
        """
        pass

    @abstractmethod
    def write(self, data: bytes) -> int:
        """Write data to the PTY.

        Args:
            data: Bytes to write.

        Returns:
            Number of bytes written.
        """
        pass

    @abstractmethod
    def resize(self, rows: int, cols: int) -> None:
        """Resize the PTY window.

        Args:
            rows: Number of rows.
            cols: Number of columns.
        """
        pass

    @abstractmethod
    def poll(self) -> Optional[int]:
        """Check if the process has terminated.

        Returns:
            Exit code if terminated, None if still running.
        """
        pass

    @abstractmethod
    def terminate(self, force: bool = False) -> None:
        """Terminate the process.

        Args:
            force: If True, force kill the process.
        """
        pass

    @abstractmethod
    def wait(self, timeout: Optional[float] = None) -> int:
        """Wait for the process to terminate.

        Args:
            timeout: Maximum time to wait in seconds, None for infinite.

        Returns:
            Exit code of the process.

        Raises:
            TimeoutError: If timeout is reached.
        """
        pass

    @property
    @abstractmethod
    def pid(self) -> int:
        """Get the process ID."""
        pass

    @property
    @abstractmethod
    def returncode(self) -> Optional[int]:
        """Get the return code, or None if not terminated."""
        pass

    @property
    @abstractmethod
    def fd(self) -> int:
        """Get the file descriptor for the PTY master.

        On Windows, this may return a handle or -1 if not applicable.
        """
        pass


class PtyManager(ABC):
    """Abstract base class for PTY management."""

    @abstractmethod
    def spawn(
        self,
        cmd: List[str],
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        rows: int = 24,
        cols: int = 80,
    ) -> PtyProcess:
        """Spawn a new process with a PTY.

        Args:
            cmd: Command and arguments to execute.
            cwd: Working directory.
            env: Environment variables.
            rows: Initial number of rows.
            cols: Initial number of columns.

        Returns:
            PtyProcess instance.
        """
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """Check if PTY support is available on this platform.

        Returns:
            True if PTY is available, False otherwise.
        """
        pass

    def set_nonblocking(self, fd: int) -> None:
        """Set a file descriptor to non-blocking mode.

        Args:
            fd: File descriptor to modify.

        Note:
            This is a no-op on platforms that don't support it.
        """
        pass

    def read_available(self, fd: int, timeout: float = 0.5) -> Optional[bytes]:
        """Read available data from file descriptor with timeout.

        Args:
            fd: File descriptor to read from.
            timeout: Timeout in seconds.

        Returns:
            Bytes read, or None if no data available.
        """
        pass


class PermissionsManager(ABC):
    """Abstract base class for file permission management."""

    @abstractmethod
    def set_owner_only(self, path: str, is_directory: bool = False) -> None:
        """Set file/directory permissions to owner-only access.

        On Unix: Sets mode to 0o700 (directory) or 0o600 (file).
        On Windows: Sets ACL to grant full control only to current user.

        Args:
            path: Path to the file or directory.
            is_directory: True if path is a directory.
        """
        pass

    @abstractmethod
    def set_mode(self, path: str, mode: int) -> None:
        """Set file permissions using Unix-style mode.

        Args:
            path: Path to the file.
            mode: Unix permission mode (e.g., 0o755).

        Note:
            On Windows, this is a best-effort translation to ACLs.
        """
        pass

    @abstractmethod
    def get_mode(self, path: str) -> int:
        """Get file permissions as Unix-style mode.

        Args:
            path: Path to the file.

        Returns:
            Unix permission mode.

        Note:
            On Windows, this returns an approximation based on ACLs.
        """
        pass


class SignalHandler(ABC):
    """Abstract base class for process signal handling."""

    @abstractmethod
    def terminate_gracefully(self, pid: int) -> bool:
        """Send a graceful termination signal to a process.

        On Unix: Sends SIGTERM.
        On Windows: Sends CTRL_BREAK_EVENT or uses TerminateProcess with grace.

        Args:
            pid: Process ID to signal.

        Returns:
            True if signal was sent successfully.
        """
        pass

    @abstractmethod
    def terminate_forcefully(self, pid: int) -> bool:
        """Forcefully terminate a process.

        On Unix: Sends SIGKILL.
        On Windows: Calls TerminateProcess.

        Args:
            pid: Process ID to terminate.

        Returns:
            True if process was terminated successfully.
        """
        pass

    @abstractmethod
    def get_termination_signal(self) -> int:
        """Get the signal number for graceful termination.

        Returns:
            Signal number (SIGTERM on Unix, approximation on Windows).
        """
        pass

    @abstractmethod
    def get_kill_signal(self) -> int:
        """Get the signal number for forceful termination.

        Returns:
            Signal number (SIGKILL on Unix, approximation on Windows).
        """
        pass


class UserInfoProvider(ABC):
    """Abstract base class for user/group information."""

    @abstractmethod
    def get_owner_name(self, uid: int) -> str:
        """Get the username for a user ID.

        Args:
            uid: User ID.

        Returns:
            Username string, or the UID as string if not found.
        """
        pass

    @abstractmethod
    def get_group_name(self, gid: int) -> str:
        """Get the group name for a group ID.

        Args:
            gid: Group ID.

        Returns:
            Group name string, or the GID as string if not found.
        """
        pass

    @abstractmethod
    def get_owner_name_from_path(self, path: str) -> str:
        """Get the owner name for a file path.

        Args:
            path: File path.

        Returns:
            Owner name string.
        """
        pass

    @abstractmethod
    def get_group_name_from_path(self, path: str) -> str:
        """Get the group name for a file path.

        Args:
            path: File path.

        Returns:
            Group name string.
        """
        pass
