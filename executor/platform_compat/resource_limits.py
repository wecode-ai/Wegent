# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process resource limit helpers for subprocess-heavy local executors."""

from dataclasses import dataclass
from typing import Optional

from shared.logger import setup_logger

logger = setup_logger("resource_limits")

try:
    import resource
except ImportError:  # pragma: no cover - Windows does not provide resource.
    resource = None  # type: ignore[assignment]


CLAUDE_CLI_RECOMMENDED_NOFILE_LIMIT = 2147483646


@dataclass(frozen=True)
class ResourceLimitResult:
    """Result of attempting to prepare a process resource limit."""

    supported: bool
    changed: bool
    current_soft: Optional[int]
    current_hard: Optional[int]
    target_soft: Optional[int]
    error: Optional[str] = None


def ensure_subprocess_nofile_limit(
    minimum: int = CLAUDE_CLI_RECOMMENDED_NOFILE_LIMIT,
) -> ResourceLimitResult:
    """Raise RLIMIT_NOFILE soft limit so child processes inherit enough fds."""
    if resource is None:
        return ResourceLimitResult(False, False, None, None, None)

    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = _target_soft_limit(minimum, hard)
        if soft >= target:
            return ResourceLimitResult(True, False, soft, hard, target)

        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
        logger.info(
            "Raised RLIMIT_NOFILE soft limit for subprocesses: %s -> %s (hard=%s)",
            soft,
            target,
            hard,
        )
        return ResourceLimitResult(True, True, target, hard, target)
    except (OSError, ValueError) as exc:
        logger.warning(
            "Failed to raise RLIMIT_NOFILE for subprocesses. "
            "Claude Code may fail on large workspaces; on macOS, run "
            "'sudo launchctl limit maxfiles %s' and restart Wegent. Error: %s",
            minimum,
            exc,
        )
        return ResourceLimitResult(True, False, None, None, None, str(exc))


def _target_soft_limit(minimum: int, hard: int) -> int:
    if hard == resource.RLIM_INFINITY:
        return minimum
    return min(minimum, hard)
